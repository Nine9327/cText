/**
 * M4-06 自检：HTTP 层。
 *
 * 四段断言，全部离线（起一个 127.0.0.1 的本地服务器当「书源站点」）：
 *   1. SSRF 判定：内网/回环/云元数据/IPv4 映射地址一律拒，公网才放行
 *   2. 编码：GBK 响应、meta 嗅探、BOM 优先、未知编码退回 UTF-8
 *   3. 节流：同 host 串行且间隔 ≥ 设定值，不同 host 并行
 *   4. 客户端：gzip 解压、重定向链、重定向超限、超时、体积上限、默认开启 SSRF
 *
 * 关键一条：**默认客户端必须拒绝 127.0.0.1**——自检自己能连本地服务器，
 * 靠的是显式 `ssrf: false`，而不是防线漏了。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import iconv from 'iconv-lite'
import { gzipSync } from 'node:zlib'
import { charsetFromContentType, decodeBody, normalizeCharset } from './charset'
import { createHttpClient, type HttpClient } from './client'
import { HostLimiter } from './limiter'
import { assertUrlAllowed, isPublicAddress, HttpError } from './ssrf'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function runHttpSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 1. SSRF 判定
  try {
    check('公网 IPv4 放行', isPublicAddress('8.8.8.8') === true)
    check('回环 IPv4 拒绝', isPublicAddress('127.0.0.1') === false)
    check('10/8 私网拒绝', isPublicAddress('10.1.2.3') === false)
    check('192.168/16 私网拒绝', isPublicAddress('192.168.1.1') === false)
    check('172.16/12 私网拒绝', isPublicAddress('172.16.0.1') === false)
    check('172.32 不在私网段内', isPublicAddress('172.32.0.1') === true)
    check('云元数据 169.254.169.254 拒绝', isPublicAddress('169.254.169.254') === false)
    check('运营商 NAT 100.64/10 拒绝', isPublicAddress('100.64.0.1') === false)
    check('0.0.0.0 拒绝', isPublicAddress('0.0.0.0') === false)
    check('组播 224/4 拒绝', isPublicAddress('224.0.0.1') === false)
    check('IPv6 回环拒绝', isPublicAddress('::1') === false)
    check('IPv6 链路本地拒绝', isPublicAddress('fe80::1') === false)
    check('IPv6 ULA 拒绝', isPublicAddress('fc00::1') === false)
    check('IPv4 映射回环拒绝', isPublicAddress('::ffff:127.0.0.1') === false)
    check('IPv4 映射公网放行', isPublicAddress('::ffff:8.8.8.8') === true)
    check('IPv6 公网放行', isPublicAddress('2001:4860:4860::8888') === true)

    check('URL 指向 127.0.0.1 被拒', await rejectsWith('http://127.0.0.1/', 'private-address'))
    check('URL 指向 localhost 被拒', await rejectsWith('http://localhost/', 'private-address'))
    check('URL 指向 [::1] 被拒', await rejectsWith('http://[::1]/', 'private-address'))
    check('file: 协议被拒', await rejectsWith('file:///etc/passwd', 'protocol'))
    check('ftp: 协议被拒', await rejectsWith('ftp://example.com/a', 'protocol'))
    check('非法地址被拒', await rejectsWith('不是地址', 'invalid-url'))

    const publicLiteral = await assertUrlAllowed('http://8.8.8.8/path')
    check('公网 IP 直连地址通过（不查 DNS）', publicLiteral.addresses.length === 1 && publicLiteral.addresses[0].address === '8.8.8.8')
  } catch (err) {
    check('SSRF 断言未抛异常', false, messageOf(err))
  }

  // ---------------------------------------------------------------- 2. 编码
  try {
    const gbk = iconv.encode('中文正文', 'gbk')
    const fromHeader = decodeBody(gbk, 'text/html; charset=GBK')
    check('Content-Type 声明 GBK 正确解码', fromHeader.text === '中文正文', fromHeader.text)
    check('GBK 归一成 gb18030 超集', fromHeader.charset === 'gb18030', fromHeader.charset)

    const metaBody = bufferWithMeta(gbk)
    const fromMeta = decodeBody(metaBody, 'text/html')
    check('无声明时用 <meta charset> 嗅探', fromMeta.text.includes('中文正文'), fromMeta.charset)

    const plain = decodeBody(Buffer.from('中文正文', 'utf8'), 'text/html')
    check('无声明默认 UTF-8', plain.text === '中文正文' && plain.charset === 'utf8', plain.charset)

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文正文', 'utf8')])
    const bom = decodeBody(withBom, 'text/html; charset=gbk')
    check('BOM 优先于声明', bom.text === '中文正文' && bom.charset === 'utf8', bom.charset)

    const unknown = decodeBody(Buffer.from('abc'), 'text/html; charset=x-unknown')
    check('未知编码退回 UTF-8 且不抛', unknown.text === 'abc' && unknown.charset === 'utf8', unknown.charset)

    check('GB2312 归一成 gb18030', normalizeCharset('GB2312') === 'gb18030', String(normalizeCharset('GB2312')))
    check('从 Content-Type 取 charset', charsetFromContentType('text/html; charset="gbk"') === 'gbk')
  } catch (err) {
    check('编码断言未抛异常', false, messageOf(err))
  }

  // ---------------------------------------------------------------- 3. 节流
  try {
    const limiter = new HostLimiter(80)
    const started = Date.now()
    for (let i = 0; i < 3; i++) await limiter.run('a.test', async () => i)
    const elapsed = Date.now() - started
    check('同 host 三次请求间隔 ≥ 2×80ms', elapsed >= 150, `${elapsed}ms`)

    const parallelStarted = Date.now()
    await Promise.all([
      limiter.run('b.test', () => sleep(100)),
      limiter.run('c.test', () => sleep(100))
    ])
    const parallelElapsed = Date.now() - parallelStarted
    check('不同 host 并行不被串行化', parallelElapsed < 190, `${parallelElapsed}ms`)
  } catch (err) {
    check('节流断言未抛异常', false, messageOf(err))
  }

  // ---------------------------------------------------------------- 4. 客户端
  let server: Server | null = null
  let client: HttpClient | null = null
  try {
    server = await startServer()
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    client = createHttpClient({ minIntervalMs: 0, timeoutMs: 4000 })

    const ok = await client.fetch(`${base}/ok`, { ssrf: false })
    check('GET 200 取文本', ok.status === 200 && ok.body === 'hello', `${ok.status} ${ok.body}`)

    const gbkPage = await client.fetch(`${base}/gbk`, { ssrf: false })
    check('GBK 页面按声明解码', gbkPage.body === '中文正文', gbkPage.body)

    const metaPage = await client.fetch(`${base}/meta-gbk`, { ssrf: false })
    check('GBK 页面靠 meta 嗅探解码', metaPage.body.includes('中文正文'), metaPage.body.slice(-12))

    const gzipped = await client.fetch(`${base}/gzip`, { ssrf: false })
    check('gzip 响应自动解压', gzipped.body === '压缩后的正文' && gzipped.headers['content-encoding'] === 'gzip', gzipped.body)

    const json = await client.fetch(`${base}/json`, { ssrf: false })
    check('JSON 响应可解析', JSON.parse(json.body).hidden === 1, json.body)

    const redirected = await client.fetch(`${base}/redirect`, { ssrf: false })
    check('跟随 302 到最终地址', redirected.status === 200 && redirected.url.endsWith('/ok') && redirected.redirects.length === 1, `${redirected.url} / ${redirected.redirects.length}`)

    const loop = await client.fetch(`${base}/loop`, { ssrf: false }).catch((err: unknown) => err)
    check('超过重定向上限报 redirect-limit', loop instanceof HttpError && loop.code === 'redirect-limit', loop instanceof Error ? loop.message : String(loop))

    const slow = await client.fetch(`${base}/slow`, { ssrf: false, timeoutMs: 300, headersTimeoutMs: 300 }).catch((err: unknown) => err)
    check('慢响应按超时中断', slow instanceof HttpError && slow.code === 'timeout', slow instanceof Error ? slow.message : String(slow))

    const big = await client.fetch(`${base}/big`, { ssrf: false, maxBodyBytes: 1024 }).catch((err: unknown) => err)
    check('响应体超限被中断', big instanceof HttpError && big.code === 'too-large', big instanceof Error ? big.message : String(big))

    const posted = await client.fetch(`${base}/echo`, { ssrf: false, method: 'POST', body: 'q=三体' })
    check('POST 表单体送达', posted.body.includes('q=三体'), posted.body)

    const ua = await client.fetch(`${base}/echo-ua`, { ssrf: false })
    check('默认带浏览器 UA', ua.body.includes('Mozilla/5.0'), ua.body.slice(0, 30))

    // 最关键的一条：默认客户端（ssrf 未关闭）不许连本地
    const guardedClient = createHttpClient({ minIntervalMs: 0 })
    const blocked = await guardedClient.fetch(`${base}/ok`).catch((err: unknown) => err)
    check('默认客户端拒绝本地地址', blocked instanceof HttpError && blocked.code === 'private-address', blocked instanceof Error ? blocked.message : String(blocked))
    await guardedClient.close()
  } catch (err) {
    check('客户端断言未抛异常', false, messageOf(err))
  } finally {
    try {
      await client?.close()
    } catch {
      // 忽略关闭异常
    }
    if (server) await closeServer(server)
  }

  return checks
}

function bufferWithMeta(gbk: Buffer): Buffer {
  const head = Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1')
  const tail = Buffer.from('</body></html>', 'latin1')
  return Buffer.concat([head, gbk, tail])
}

async function rejectsWith(url: string, code: string): Promise<boolean> {
  try {
    await assertUrlAllowed(url)
    return false
  } catch (err) {
    return err instanceof HttpError && err.code === code
  }
}

function startServer(): Promise<Server> {
  const server = createServer((req, res) => handle(req, res))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0]

  if (path === '/ok') return text(res, 'hello')
  if (path === '/gbk') return raw(res, iconv.encode('中文正文', 'gbk'), 'text/html; charset=gbk')
  if (path === '/meta-gbk') return raw(res, bufferWithMeta(iconv.encode('中文正文', 'gbk')), 'text/html')
  if (path === '/json') return raw(res, Buffer.from('{"hidden":1}'), 'application/json; charset=utf-8')
  if (path === '/gzip') {
    const body = gzipSync(Buffer.from('压缩后的正文', 'utf8'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': body.length })
    return void res.end(body)
  }
  if (path === '/redirect') {
    res.writeHead(302, { location: '/ok' })
    return void res.end()
  }
  if (path === '/loop') {
    res.writeHead(302, { location: '/loop' })
    return void res.end()
  }
  if (path === '/slow') {
    // 永不响应，等客户端超时；连接由 closeAllConnections 收尾
    return
  }
  if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return void res.end(Buffer.alloc(64 * 1024, 0x61))
  }
  if (path === '/echo') {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => raw(res, Buffer.concat(chunks), 'text/plain; charset=utf-8'))
    return
  }
  if (path === '/echo-ua') {
    return text(res, req.headers['user-agent'] ?? '')
  }
  res.writeHead(404)
  res.end()
}

function text(res: ServerResponse, body: string): void {
  raw(res, Buffer.from(body, 'utf8'), 'text/html; charset=utf-8')
}

function raw(res: ServerResponse, body: Buffer, contentType: string): void {
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length })
  res.end(body)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
