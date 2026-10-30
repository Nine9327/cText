/**
 * 书源 URL 的统一构造（M4-08 起用，M4-09 扩展到详情 / 目录 / 正文）。
 *
 * 抽出这一个文件的原因：搜索地址（`searchUrl`）、详情页（`bookUrl`）、目录翻页
 * （`nextTocUrl`）、正文翻页（`nextContentUrl`）四处都要做同一件事——
 * 「一段可能带选项对象的规则文本 + 模板变量 → 一个真实请求」。三处各写一份
 * `,{...}` 解析，迟早有一处漏掉 POST 或漏掉相对地址补全。
 *
 * 支持的写法（与「阅读 3.0」一致）：
 *   - 纯地址：`/book/1`、`https://a.com/s?q={{key}}`
 *   - 带选项：`/book/1,{"method":"POST","body":"id=1","headers":{"X-Token":"x"}}`
 *
 * 两条刻意的语义：
 *   1. **未定义的 `{{x}}` 原样保留**。拼成空串会得到一个「看起来合法」的错地址，
 *      日志里也看不出是哪条规则没填变量。
 *   2. **只接受 http(s)**。`file:`、`javascript:`、`data:` 都是 SSRF / XSS 入口，
 *      而书源规则是外部输入，不能信任。
 */

export interface UrlTarget {
  url: string
  method: 'GET' | 'POST'
  body: string | undefined
  headers: Record<string, string>
}

export type BuildTargetResult = { ok: true; target: UrlTarget } | { ok: false; reason: string }

/** 拆 `url,{...}`；`{` 前面必须有逗号，避免把 URL 里的 `{` 当选项 */
export function splitUrlOptions(raw: string): { urlText: string; options: Record<string, unknown> } {
  const index = raw.lastIndexOf(',{')
  if (index < 0) return { urlText: raw, options: {} }
  const tail = raw.slice(index + 1)
  if (!tail.endsWith('}')) return { urlText: raw, options: {} }
  try {
    const parsed: unknown = JSON.parse(tail)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { urlText: raw, options: {} }
    }
    return { urlText: raw.slice(0, index), options: parsed as Record<string, unknown> }
  } catch {
    return { urlText: raw, options: {} }
  }
}

/** `{{key}}` 插值。未定义变量原样保留（见文件头第 1 条） */
export function interpolateTemplate(text: string, variables: Map<string, string>): string {
  return text.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (whole, key: string) => variables.get(key) ?? whole)
}

/** 相对地址按 base 补全；不是 http(s) 或解析不了时返回 null */
export function resolveHttpUrl(value: string, base: string | undefined): string | null {
  const text = value.trim()
  if (text === '') return null
  try {
    const url = new URL(text, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

/**
 * 规则文本 → 请求描述。
 *
 * `label` 只用于错误文案（「详情页地址不合法」比「地址不合法」更好定位是哪一段）。
 */
export function buildUrlTarget(
  raw: string,
  base: string | undefined,
  variables: Map<string, string>,
  label = '地址'
): BuildTargetResult {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: `${label}为空` }

  const { urlText, options } = splitUrlOptions(text)
  const interpolated = interpolateTemplate(urlText, variables)
  const url = resolveHttpUrl(interpolated, base)
  if (url === null) {
    return { ok: false, reason: `${label}不合法：${interpolated.slice(0, 120)}` }
  }

  const method = String(options['method'] ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  const bodyText = typeof options['body'] === 'string' ? options['body'] : ''
  const body = bodyText === '' ? undefined : interpolateTemplate(bodyText, variables)

  const headers: Record<string, string> = {}
  const rawHeaders = options['headers']
  if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
    }
  }

  return { ok: true, target: { url, method, body, headers } }
}
