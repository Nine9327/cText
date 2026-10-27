/**
 * 日志脱敏。
 *
 * 产品文档 §3.11 的硬要求：**日志里不得出现用户名与凭据**。
 * 日志会随用户反馈外流（M5-04 的一键导出），所以脱敏必须在**写入那一刻**做，
 * 不能等到导出时再处理——中途一旦落盘，任何截图/复制都已经泄漏了。
 *
 * 覆盖四类：
 *   1. Windows 用户目录 `C:\Users\<name>` / `c:/Users/<name>`
 *   2. POSIX 家目录 `/home/<name>`、`/Users/<name>`（开发机可能是别的系统）
 *   3. `Authorization: Bearer <token>`
 *   4. URL 查询串里的 token / key / secret / password
 *
 * 只做「替换为 `~` / `***`」，不做删除：保留路径结构，排障时仍能看出是哪个目录。
 */

/** 用户名占位符；验收要求就是 `~`（见开发计划 M0-06 的验收标准） */
const USER_PLACEHOLDER = '~'
const SECRET_PLACEHOLDER = '***'

const RULES: readonly (readonly [RegExp, string])[] = [
  // C:\Users\name、D:/Users/name（盘符任意，分隔符任意）
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"\r\n\t]+/gi, `$1${USER_PLACEHOLDER}`],
  // /home/name、/Users/name
  [/(\/(?:home|Users)\/)[^\\/"\r\n\t]+/g, `$1${USER_PLACEHOLDER}`],
  // Authorization: Bearer xxx（保留前缀，便于看出是哪种凭据）
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${SECRET_PLACEHOLDER}`],
  // URL 查询串
  [/([?&](?:token|key|secret|password|passwd|access_token|api_key)=)[^&\s"']+/gi, `$1${SECRET_PLACEHOLDER}`]
]

/** 单条日志最多处理这么长，防止一条巨型堆栈把脱敏拖成瓶颈 */
const MAX_SCAN = 16_000
/** 字段递归深度上限，防止环形结构 */
const MAX_DEPTH = 4
/** 数组/对象最多保留的条目数 */
const MAX_ENTRIES = 48

export function redactText(text: string): string {
  if (!text) return text
  const input = text.length > MAX_SCAN ? `${text.slice(0, MAX_SCAN)}…（截断）` : text
  let out = input
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/**
 * 把任意值转成可安全 JSON 序列化、且已脱敏的副本。
 * - Error → { name, message, stack }（否则 JSON.stringify 会得到 `{}`，等于丢日志）
 * - Buffer → `<binary N bytes>`（序列化出来可能是几 MB 的数字数组）
 * - 超过深度/条目数 → 截断标记
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value

  const type = typeof value
  if (type === 'string') return redactText(value as string)
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return `${String(value)}n`
  if (type === 'function') return '[function]'
  if (type === 'symbol') return String(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined
    }
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `<binary ${value.length} bytes>`
  }

  if (depth >= MAX_DEPTH) return '[嵌套过深]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, depth + 1))
    if (value.length > MAX_ENTRIES) items.push(`…共 ${value.length} 项`)
    return items
  }

  if (value instanceof Date) return value.toISOString()

  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const out: Record<string, unknown> = {}
    for (const [key, item] of entries.slice(0, MAX_ENTRIES)) {
      out[redactText(key)] = redactValue(item, depth + 1)
    }
    if (entries.length > MAX_ENTRIES) out['…'] = `共 ${entries.length} 个字段`
    return out
  }

  return String(value)
}
