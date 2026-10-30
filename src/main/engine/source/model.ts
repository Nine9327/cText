/**
 * 书源模型与归一化（M4-07）。
 *
 * 输入是「阅读 3.0」（Legado）导出的原始 JSON —— 单个对象或对象数组。
 * 本文件只做两件事：把任意 JSON 收敛成 `NormalizedSource`，并记录**不阻断导入**的问题。
 *
 * 三条口径（与产品文档 §2.7 对齐，改动前先看那一节）：
 *
 *   1. **不做自定义映射**。字段名、规则语法保持原样，`rule_json` 存的就是原始对象。
 *      归一化的结果只用于**查重、排序、兼容判定**，不替代原数据。
 *   2. **宁收不拒**。结构对但内容可疑（缺名称、规则写坏、类型是音频）一律导入并打标记，
 *      让用户在列表里看到、能删能改。只有「根本不是书源对象」才判失败——
 *      批量导入 100 条时，一条坏数据不该让整批回滚。
 *   3. **身份是 `bookSourceUrl`**。它是 Legado 的天然主键，也是 `book_sources` 的 UNIQUE 列。
 *      缺失或不是 http(s) 的条目直接判失败：没有身份就无法去重，也没法发请求。
 */

/** 文本小说。其余值（1 音频 / 2 图片 / 3 文件）v1 不支持，导入但标 unsupported */
export const TEXT_SOURCE_TYPE = 0

/** 规则字段所在的四个分组。`ruleExplore` 不在其中：发现页 v1 不做 */
export const RULE_SECTIONS = ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'] as const
export type RuleSection = (typeof RULE_SECTIONS)[number]

export interface NormalizedSource {
  /** bookSourceUrl，trim 后的原始字符串（不补斜杠、不改大小写） */
  url: string
  /** bookSourceName；缺失时退化为域名 */
  name: string
  group: string | null
  enabled: boolean
  customOrder: number
  bookSourceType: number
  searchUrl: string | null
  loginUrl: string | null
  /** header 字段解析后的对象；未声明或不是合法 JSON 时为 null */
  header: Record<string, string> | null
  /** 只保留字符串型规则，非字符串一律丢掉（Legado 里偶尔会出现数字/对象） */
  rules: Partial<Record<RuleSection, Record<string, string>>>
  /** 原始对象，原样落库 */
  raw: Record<string, unknown>
  /** 归一化时发现的问题，写进 compat_note */
  warnings: string[]
}

export type NormalizeResult =
  | { ok: true; source: NormalizedSource }
  | { ok: false; reason: string; name: string | null; url: string | null }

export type PayloadParseResult = { ok: true; items: unknown[] } | { ok: false; reason: string }

/**
 * 解析导入载荷（文件内容或粘贴的文本）。
 *
 * 除了标准的「对象 / 数组」，还容忍两种情况：
 *   - 文件开头带 BOM（Windows 记事本另存为 UTF-8 必带）；
 *   - 数组里嵌套数组（有人手工拼接过导出文件）。
 * 其余一律判失败并给出**人话**原因，不要把 `Unexpected token <` 这种丢给用户。
 */
export function parsePayload(text: string): PayloadParseResult {
  const body = text.replace(/^\uFEFF/, '').trim()
  if (body === '') return { ok: false, reason: '内容为空' }

  if (body.startsWith('<')) {
    return { ok: false, reason: '这是一段 HTML/XML，不是书源 JSON。若从网页复制，请用「导入 URL」并确认地址直链返回 JSON' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `JSON 解析失败：${message}` }
  }

  const items = flatten(parsed)
  if (items === null) {
    return { ok: false, reason: '顶层既不是书源对象也不是数组，无法识别' }
  }
  if (items.length === 0) return { ok: false, reason: '数组是空的，没有可导入的书源' }
  return { ok: true, items }
}

/** 展开嵌套数组；顶层是对象则包成单元素数组。不像任何一种时返回 null */
function flatten(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const entry of value) {
      if (Array.isArray(entry)) {
        const nested = flatten(entry)
        if (nested) out.push(...nested)
      } else {
        out.push(entry)
      }
    }
    return out
  }
  if (isRecord(value)) return [value]
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** `bookSourceType` 缺失按文本处理（绝大多数书源不写这个字段） */
function toType(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return TEXT_SOURCE_TYPE
}

function toEnabled(value: unknown): boolean {
  // Legado 里这个字段可能是 true / 1 / "true"；缺失视为启用
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return !['false', '0', ''].includes(value.trim().toLowerCase())
  return true
}

function toOrder(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return 0
}

/** 域名兜底名称：`https://www.example.com` → `example.com` */
function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url
  } catch {
    return url
  }
}

/** 只接受 http(s)。`file:`、`javascript:`、相对路径都不行——前者是 SSRF 入口，后者无法定位 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** `header` 是「一段 JSON 字符串」，不是对象。解析失败只记 warning，不影响导入 */
function parseHeader(value: unknown, warnings: string[]): Record<string, string> | null {
  const raw = str(value)
  if (raw === null) return null
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) {
        warnings.push('header 不是键值对象，已忽略')
        return null
      }
      const out: Record<string, string> = {}
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === 'string') out[key] = val
      }
      return Object.keys(out).length > 0 ? out : null
    } catch {
      warnings.push('header 不是合法 JSON，已忽略（该站点可能需要 UA 才能访问）')
      return null
    }
  }
  // 少数书源直接把 header 写成 `A: b\nC: d` 这种多行文本
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key !== '' && val !== '') out[key] = val
  }
  return Object.keys(out).length > 0 ? out : null
}

function collectRules(
  raw: Record<string, unknown>,
  warnings: string[]
): Partial<Record<RuleSection, Record<string, string>>> {
  const out: Partial<Record<RuleSection, Record<string, string>>> = {}
  for (const section of RULE_SECTIONS) {
    const value = raw[section]
    if (!isRecord(value)) continue
    const rules: Record<string, string> = {}
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed !== '') rules[key] = trimmed
      } else if (val !== null && val !== undefined) {
        // 非字符串规则直接丢：Legado 里这些位置偶尔出现数字，留着只会让解析器报怪错
        warnings.push(`${section}.${key} 不是字符串，已忽略`)
      }
    }
    if (Object.keys(rules).length > 0) out[section] = rules
  }
  return out
}

/**
 * 单个原始对象 → NormalizedSource。
 *
 * 失败只有三种：不是对象、缺 bookSourceUrl、bookSourceUrl 不是 http(s)。
 * 其余问题（缺名称、类型不支持、规则写坏）都降级成 warning，由兼容性判定去分级。
 */
export function normalizeSource(raw: unknown): NormalizeResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: '不是对象', name: null, url: null }
  }

  const url = str(raw['bookSourceUrl'])
  if (url === null) {
    const fallbackName = str(raw['bookSourceName'])
    return { ok: false, reason: '缺少 bookSourceUrl（书源的唯一标识）', name: fallbackName, url: null }
  }
  if (!isHttpUrl(url)) {
    return {
      ok: false,
      reason: `bookSourceUrl 不是 http(s) 地址：${url.slice(0, 80)}`,
      name: str(raw['bookSourceName']),
      url
    }
  }

  const warnings: string[] = []
  const declaredName = str(raw['bookSourceName'])
  if (declaredName === null) warnings.push('缺少 bookSourceName，已用域名代替')

  const header = parseHeader(raw['header'], warnings)
  const rules = collectRules(raw, warnings)
  if (Object.keys(rules).length === 0) warnings.push('没有任何规则字段（ruleSearch/ruleBookInfo/ruleToc/ruleContent）')

  return {
    ok: true,
    source: {
      url,
      name: declaredName ?? hostName(url),
      group: str(raw['bookSourceGroup']),
      enabled: toEnabled(raw['enabled']),
      customOrder: toOrder(raw['customOrder']),
      bookSourceType: toType(raw['bookSourceType']),
      searchUrl: str(raw['searchUrl']),
      loginUrl: str(raw['loginUrl']),
      header,
      rules,
      raw,
      warnings
    }
  }
}
