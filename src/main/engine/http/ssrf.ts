/**
 * SSRF 防护（M4-06）。
 *
 * 书源是用户导入的**不可信数据**，它的 URL 可能指向 `127.0.0.1`、内网段、
 * 或云厂商的元数据地址（`169.254.169.254`）。请求层必须先判定，再连。
 *
 * 判定分两层，缺一不可：
 *   1. **URL 层**：只允许 `http:` / `https:`，拒绝 `file:` `ftp:` 等协议；
 *   2. **解析层**：域名先解析成 IP，**所有**结果都必须是公网地址才放行，
 *      并把这次解析到的 IP 钉给连接器（`connect.lookup`），避免「校验时是公网、
 *      连接时变成内网」的 DNS rebinding。
 *
 * 用 `net.BlockList` 而不是手写位运算：段表集中在一处，加规则只需加一行，
 * 也不会把 `/12` 写成 `/16` 这种错。
 */
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

export type HttpErrorCode =
  | 'invalid-url'
  | 'protocol'
  | 'private-address'
  | 'dns'
  | 'timeout'
  | 'too-large'
  | 'redirect-limit'
  | 'network'
  | 'status'

export class HttpError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const v4 = new BlockList()
const v6 = new BlockList()

/** 非公网 IPv4 段（含云元数据 169.254.169.254 所在的链路本地段） */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私网 A
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地 / 云元数据
  ['172.16.0.0', 12], // 私网 B
  ['192.0.0.0', 24], // IETF 协议保留
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // 私网 C
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4] // 保留 + 广播
]

/** 非公网 IPv6 段 */
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // 未指定 / 回环 / IPv4 兼容
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // 丢弃段
  ['2001:db8::', 32], // 文档段
  ['fc00::', 7], // 唯一本地（ULA）
  ['fe80::', 10], // 链路本地
  ['ff00::', 8] // 组播
]

for (const [net, prefix] of BLOCKED_V4) v4.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of BLOCKED_V6) v6.addSubnet(net, prefix, 'ipv6')

/** 单个 IP 是否可访问（公网才可） */
export function isPublicAddress(raw: string): boolean {
  const address = raw.trim().toLowerCase().replace(/%.*$/, '') // 去掉 IPv6 的 zone id
  const family = isIP(address)
  if (family === 4) return !v4.check(address, 'ipv4')
  if (family === 6) {
    const mapped = mappedIPv4(address)
    if (mapped !== null) return !v4.check(mapped, 'ipv4')
    return !v6.check(address, 'ipv6')
  }
  return false // 不是 IP 一律当不可信
}

/** `::ffff:127.0.0.1` / `::ffff:7f00:1` → `127.0.0.1`；非映射地址返回 null */
function mappedIPv4(address: string): string | null {
  if (!address.startsWith('::ffff:')) return null
  const tail = address.slice('::ffff:'.length)
  if (isIP(tail) === 4) return tail
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!hex) return null
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

export interface GuardedUrl {
  url: URL
  /** 校验通过的解析结果（顺序与原解析一致，供连接器钉住） */
  addresses: Array<{ address: string; family: number }>
}

/**
 * 校验一个待请求的 URL：协议、主机名、解析结果。
 * 主机名本身是 IP 时不查 DNS，直接判定。
 */
export async function assertUrlAllowed(rawUrl: string): Promise<GuardedUrl> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new HttpError('invalid-url', '地址格式不合法', rawUrl)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError('protocol', `只允许 http/https，收到 ${url.protocol}`, rawUrl)
  }

  const host = stripBrackets(url.hostname)
  if (host === '') throw new HttpError('invalid-url', '地址缺少主机名', rawUrl)

  const literal = isIP(host)
  if (literal !== 0) {
    if (!isPublicAddress(host)) {
      throw new HttpError('private-address', '拒绝访问内网/回环地址', host)
    }
    return { url, addresses: [{ address: host, family: literal }] }
  }

  // 明显的本机名直接拒，省一次 DNS
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new HttpError('private-address', '拒绝访问本机地址', host)
  }

  let resolved: Array<{ address: string; family: number }>
  try {
    const list = await dnsLookup(host, { all: true, verbatim: true })
    resolved = list.map((item) => ({ address: item.address, family: item.family }))
  } catch (err) {
    throw new HttpError('dns', `域名解析失败：${messageOf(err)}`, host)
  }

  if (resolved.length === 0) throw new HttpError('dns', '域名没有解析结果', host)

  const bad = resolved.find((item) => !isPublicAddress(item.address))
  if (bad) {
    // 只要有一个解析结果落在内网就整体拒绝：DNS 轮询不能成为绕过手段
    throw new HttpError('private-address', '域名解析到内网/回环地址', bad.address)
  }

  return { url, addresses: resolved }
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
