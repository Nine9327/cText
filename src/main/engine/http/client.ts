/**
 * HTTP 层（M4-06）——书源引擎的**唯一出网通道**。
 *
 * 设计约束来自三处：产品文档 §2.7（限速/防 SSRF/编码）、开发计划 M4-06
 * （undici 连接池、GBK、单域名 QPS ≤1、代理注入）、§7.4 的实测结论。
 *
 * 几处刻意的选择：
 *   1. **手动跟重定向**，不用 undici 的 `maxRedirections`。内置跟随不会再过一遍 SSRF 校验，
 *      一个 302 指向 `127.0.0.1` 就能绕过防护。这里每跳重新解析 + 判定，最多 3 跳。
 *   2. **解析结果钉给连接器**（`connect.lookup`）。校验时解析一次、连接时再解析一次，
 *      中间存在 DNS rebinding 窗口；把校验通过的 IP 直接喂给 socket 就没有第二次解析。
 *   3. **自己解压**。undici 的 `request` 不解 `Content-Encoding`（`fetch` 才解），
 *      不解压会把 gzip 字节当正文交给规则引擎，取出来是乱码。
 *   4. **体积硬上限**。书源是用户导入的不可信数据，一条指向 10GB 文件的规则不能把内存打满。
 *
 * `ssrf: false` 只给自检用（要连本地测试服务器），业务层一律走默认值。
 */
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici'
import { decodeBody } from './charset'
import { DEFAULT_MIN_INTERVAL_MS, HostLimiter } from './limiter'
import { assertUrlAllowed, HttpError } from './ssrf'

export interface HttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | Buffer
  /** 整个请求的总超时（含读完响应体） */
  timeoutMs?: number
  headersTimeoutMs?: number
  maxRedirects?: number
  maxBodyBytes?: number
  /** 默认 true；仅自检置 false */
  ssrf?: boolean
  minIntervalMs?: number
  proxy?: string
  /**
   * 只要字节不要文本（图片、字体这类二进制）。
   *
   * 打开后 `body` 为空串、`raw` 带解压后的字节：正文抓取依赖编码判定，
   * 而封面图片经 `iconv` 转一遍就会坏，两条路径不能共用同一个返回字段。
   */
  raw?: boolean
}

export interface HttpResponse {
  status: number
  /** 最终 URL（跟完重定向后） */
  url: string
  headers: Record<string, string>
  body: string
  charset: string
  declaredCharset: string | null
  /** 解压后的字节数 */
  bytes: number
  elapsedMs: number
  /** 经过的重定向链，供调试面板（M4-11）展示 */
  redirects: string[]
  /** 原始字节；仅 `raw: true` 时提供（图片等二进制，未经编码转换） */
  raw?: Buffer
}

export interface HttpClient {
  fetch(url: string, options?: HttpOptions): Promise<HttpResponse>
  close(): Promise<void>
}

const DEFAULTS = {
  timeoutMs: 15_000,
  headersTimeoutMs: 15_000,
  maxRedirects: 3,
  maxBodyBytes: 5 * 1024 * 1024,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS
} as const

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/** 连接指纹缓存时长：CDN 会换 IP，太长会连不上，太短等于每次重连 */
const AGENT_TTL_MS = 5 * 60 * 1000
const MAX_AGENTS = 32

interface CachedAgent {
  agent: Dispatcher
  expiresAt: number
}

export function createHttpClient(defaults: HttpOptions = {}): HttpClient {
  const base: Required<Pick<HttpOptions, 'timeoutMs' | 'headersTimeoutMs' | 'maxRedirects' | 'maxBodyBytes'>> & HttpOptions = {
    ...DEFAULTS,
    ...defaults
  }
  const limiter = new HostLimiter(base.minIntervalMs ?? DEFAULTS.minIntervalMs)
  const agents = new Map<string, CachedAgent>()
  let proxyAgent: Dispatcher | null = null

  function proxyDispatcher(): Dispatcher {
    if (proxyAgent === null) {
      if (!base.proxy) throw new HttpError('network', '代理地址为空')
      proxyAgent = new ProxyAgent(base.proxy)
    }
    return proxyAgent
  }

  function dispatcherFor(url: URL, addresses: Array<{ address: string; family: number }> | null): Dispatcher {
    // 走代理时无法钉 IP：SSRF 仍靠 URL/解析层校验，rebinding 窗口由代理侧承担（§7.4 已记录）
    if (base.proxy) return proxyDispatcher()

    const key = `${url.protocol}//${url.host}`
    const now = Date.now()
    const hit = agents.get(key)
    if (hit && hit.expiresAt > now) return hit.agent

    const agent = new Agent({
      connections: 4,
      connect: {
        timeout: 10_000,
        // 有校验结果就钉死；自检（ssrf:false）时退回系统解析
        ...(addresses ? { lookup: pinnedLookup(addresses) } : {})
      }
    })
    agents.set(key, { agent, expiresAt: now + AGENT_TTL_MS })
    if (agents.size > MAX_AGENTS) {
      for (const [oldKey, value] of agents) {
        if (oldKey === key) continue
        agents.delete(oldKey)
        void value.agent.close().catch(() => undefined)
        break
      }
    }
    return agent
  }

  async function send(
    url: URL,
    addresses: Array<{ address: string; family: number }> | null,
    method: 'GET' | 'POST',
    body: string | Buffer | undefined,
    options: HttpOptions
  ): Promise<{ status: number; headers: Record<string, string>; raw: Buffer }> {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? base.timeoutMs
    const maxBytes = options.maxBodyBytes ?? base.maxBodyBytes
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await request(url, {
        method,
        dispatcher: dispatcherFor(url, addresses),
        signal: controller.signal,
        headersTimeout: options.headersTimeoutMs ?? base.headersTimeoutMs,
        bodyTimeout: timeoutMs,
        headers: {
          'user-agent': DEFAULT_UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...options.headers
        },
        ...(body === undefined ? {} : { body })
      })

      const headers = normalizeHeaders(response.headers)
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        total += buffer.length
        if (total > maxBytes) {
          controller.abort()
          throw new HttpError('too-large', `响应体超过上限 ${maxBytes} 字节`, url.href)
        }
        chunks.push(buffer)
      }
      return { status: response.statusCode, headers, raw: Buffer.concat(chunks) }
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (controller.signal.aborted) {
        throw new HttpError('timeout', `请求超时（${timeoutMs}ms）`, url.href)
      }
      throw mapError(err)
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchOnce(rawUrl: string, options: HttpOptions): Promise<HttpResponse> {
    const startedAt = Date.now()
    const maxRedirects = options.maxRedirects ?? base.maxRedirects
    // 自检要连 127.0.0.1：只有显式设了环境变量才放行回环地址，生产默认拒绝
    const ssrf = options.ssrf !== false && process.env['CTEXT_HTTP_ALLOW_LOCAL'] !== '1'
    const redirects: string[] = []

    let currentUrl = rawUrl
    let method: 'GET' | 'POST' = options.method ?? 'GET'
    let body = options.body

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const guarded = ssrf
        ? await assertUrlAllowed(currentUrl)
        : { url: parseUrl(currentUrl), addresses: null }
      const url = guarded.url

      const response = await limiter.run(url.host, () => send(url, guarded.addresses, method, body, options))
      const location = response.headers['location']

      if (isRedirect(response.status) && location) {
        if (hop === maxRedirects) {
          throw new HttpError('redirect-limit', `重定向超过 ${maxRedirects} 跳`, rawUrl)
        }
        const next = new URL(location, url)
        redirects.push(next.href)
        currentUrl = next.href
        // 303 与 301/302 上的 POST 按浏览器行为降级成 GET
        if (response.status === 303 || method === 'POST') {
          method = 'GET'
          body = undefined
        }
        continue
      }

      const raw = decompress(response.raw, response.headers['content-encoding'])
      // 二进制路径不做编码判定：图片过一遍 iconv 就坏了
      if (options.raw) {
        return {
          status: response.status,
          url: url.href,
          headers: response.headers,
          body: '',
          charset: '',
          declaredCharset: null,
          bytes: raw.length,
          elapsedMs: Date.now() - startedAt,
          redirects,
          raw
        }
      }

      const decoded = decodeBody(raw, response.headers['content-type'])
      return {
        status: response.status,
        url: url.href,
        headers: response.headers,
        body: decoded.text,
        charset: decoded.charset,
        declaredCharset: decoded.declared,
        bytes: raw.length,
        elapsedMs: Date.now() - startedAt,
        redirects
      }
    }

    throw new HttpError('redirect-limit', '重定向处理异常', rawUrl)
  }

  return {
    fetch(rawUrl, options = {}) {
      return fetchOnce(rawUrl, { ...base, ...options })
    },
    async close() {
      const pending = [...agents.values()]
      agents.clear()
      for (const item of pending) await item.agent.close().catch(() => undefined)
      if (proxyAgent) {
        await proxyAgent.close().catch(() => undefined)
        proxyAgent = null
      }
    }
  }
}

/**
 * 把校验通过的解析结果钉给连接器：socket 不再自己查 DNS。
 * undici 实际以 `{ all: true }` 调用，两种形态都要兼容（自检里踩过）。
 */
function pinnedLookup(addresses: Array<{ address: string; family: number }>) {
  return (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    const all = (options as { all?: boolean } | undefined)?.all === true
    if (all) {
      callback(
        null,
        addresses.map((item) => ({ address: item.address, family: item.family }))
      )
      return
    }
    callback(null, addresses[0].address, addresses[0].family)
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function decompress(buffer: Buffer, encoding: string | undefined): Buffer {
  const name = (encoding ?? '').toLowerCase().trim()
  if (name === '' || name === 'identity') return buffer
  try {
    if (name === 'gzip' || name === 'x-gzip') return gunzipSync(buffer)
    if (name === 'deflate') {
      try {
        return inflateSync(buffer)
      } catch {
        // 有些服务器发的是裸 deflate（无 zlib 头）
        return inflateRawSync(buffer)
      }
    }
    if (name === 'br') return brotliDecompressSync(buffer)
  } catch (err) {
    throw new HttpError('network', `解压失败：${messageOf(err)}`, encoding)
  }
  return buffer
}

function mapError(err: unknown): HttpError {
  const detail = err as { code?: string; name?: string; message?: string }
  const code = detail.code ?? ''
  if (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    detail.name === 'AbortError' ||
    detail.name === 'TimeoutError'
  ) {
    return new HttpError('timeout', '请求超时', code)
  }
  return new HttpError('network', `请求失败：${detail.message ?? String(err)}`, code)
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new HttpError('invalid-url', '地址格式不合法', raw)
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
