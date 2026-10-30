/**
 * 正则取值器（M4-04）。
 *
 * 「阅读 3.0」的规则里，没写 `@css:`/`@xpath:`/`@json:` 前缀的一律按正则处理。
 * 书源作者用的是 **Java 的 `java.util.regex`**，与 JS 的 `RegExp` 有一批语法差异，
 * 直接 `new RegExp(规则)` 会编译失败或语义跑偏。这里先做一层「翻译」再执行。
 *
 * 翻译项（只做有把握的，拿不准的宁可标记不兼容也不猜）：
 *   - `(?i)(?s)(?m)` 开头的内联 flag  → 提取成 JS flag（`i`/`s`/`m`）
 *   - `\p{Han}` / `\p{IsHan}`         → `\p{Script=Han}`，并自动加 `u` flag
 *   - `\p{Alpha}` 等 POSIX 类         → 对应的 Unicode 属性（`\p{L}` …）
 *   - `\Q…\E` 字面量引用              → 逐个字符转义
 *   - `\A` / `\z` / `\Z` / `\R` / `\h` → 等价的 JS 写法
 *   - 占有量词 `a*+` `a++` `a?+` `{n,m}+` → 去掉 `+`（近似：放弃「不回溯」语义）
 *   - 原子组 `(?>…)`                   → 非捕获组 `(?:…)`（同样是近似）
 *
 * 不做（会明确报「规则不兼容」，而不是静默跑错）：
 *   - 出现在中段的 `(?i)`：Java 从这里开始生效，JS 没有对应语法
 *   - 反向预查等 JS 也不支持的写法
 *
 * 取值语义（对齐 Legado 的 `getStringList`）：
 *   - 有捕获组时取**第 1 组**，没有捕获组取整个匹配
 *   - 返回所有匹配，而不是第一个——列表类规则（书名/作者/链接）靠这个
 *   - 纯空白结果丢弃，让上层 `||` 能判空降级
 */
import type { ReplaceOp } from '../ruleParser'

export interface RegexExtractResult {
  /** 取到的值（纯空白已丢弃） */
  values: string[]
  /** 编译失败的原因；正常为空 */
  error: string | null
  /** 规则是否被完整支持（false 时 error 会说明原因） */
  compatible: boolean
}

export interface TranslateResult {
  source: string
  flags: string
  /** 实际做过的转换，供调试面板（M4-11）展示「这条规则被改成了什么」 */
  notes: string[]
}

/** 一次最多返回多少个匹配：防止一条坏规则在大页面上产出几十万个字符串 */
const MAX_MATCHES = 2000

/**
 * 嵌套无界量词：`(a+)+`、`(\w+\s?)*`、`(\d{2,})+` 这类。
 *
 * JS 正则无法中断，一条这样的规则遇到长正文会把主进程卡死（§7.4 遗留项），而搜索是
 * 10 源并发、正文动辄几万字。v8 的 `matchAll` 没有超时机制，唯一能在执行前挡住它的
 * 是静态检查——所以这里**fail-closed**：命中就拒绝执行，报「规则不兼容」。
 *
 * 只匹配「组内量词 + 组外无界量词」这一种最典型形态；`(a+){2}` 这种有界重复、
 * `(cat|dog)+` 这种无内层量词的交替**不拦**——它们是正常写法，拦了会误伤大量真实书源。
 * 这是启发式，不是完备判定；真正的完备检查要 PAS 分析，等 M4-12 用真实样本说话。
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d+,\})/

/** 命中嵌套无界量词时返回命中的片段，供报错信息展示 */
export function findNestedQuantifier(pattern: string): string | null {
  const match = NESTED_QUANTIFIER.exec(pattern)
  return match === null ? null : match[0]
}

/** Java 的 POSIX 字符类 → JS 的 Unicode 属性（需 `u` flag） */
const POSIX_CLASS: Record<string, string> = {
  Lower: 'Ll',
  Upper: 'Lu',
  ASCII: 'ASCII',
  Alpha: 'L',
  Digit: 'Nd',
  Alnum: 'Alphanumeric',
  Punct: 'P',
  Graph: 'Graph',
  Print: 'Print',
  Blank: 'Blank',
  Cntrl: 'Cc',
  XDigit: 'Hex_Digit',
  Space: 'White_Space'
}

/** JS 能直接吃的通用类别（`\p{L}` `\p{Lu}` 这种一到两个字母的短名） */
const GENERAL_CATEGORY = /^[LMNPSZC][a-z]?$/

export function translateJavaRegex(pattern: string): TranslateResult {
  const notes: string[] = []
  let source = pattern.trim()
  let flags = ''

  // 1. 开头的内联 flag，例如 `(?is)`；Java 允许连续多个
  for (;;) {
    const match = /^\(\?([idmsuxU]+)\)/.exec(source)
    if (!match) break
    for (const ch of match[1]) {
      if (ch === 'i' || ch === 's' || ch === 'm') {
        if (!flags.includes(ch)) flags += ch
      } else {
        notes.push(`忽略了不支持的 flag (?${ch})`)
      }
    }
    source = source.slice(match[0].length)
  }
  if (flags !== '') notes.push(`内联 flag → ${flags}`)

  // 2. `\Q…\E` 字面量引用（先做，因为里面可能出现 `\p` 之类的假语法）
  source = expandQuoted(source, notes)

  // 3. `\p{...}` / `\P{...}` 属性名
  let needsUnicode = false
  source = source.replace(/(\\[pP])\{([^}]*)\}/g, (full, head: string, name: string) => {
    const mapped = mapProperty(name, notes)
    if (mapped === null) return full
    needsUnicode = true
    return `${head}{${mapped}}`
  })

  // 4. Java 专有的转义
  const escapes: Array<[RegExp, string, string]> = [
    [/\\R/g, '(?:\\r\\n|[\\r\\n\\u2028\\u2029])', '\\R → 任意换行'],
    [/\\A/g, '^', '\\A → ^'],
    [/\\[zZ]/g, '$', '\\z/\\Z → $'],
    [/\\h/g, '[ \\t]', '\\h → 水平空白'],
    [/\\H/g, '[^ \\t]', '\\H → 非水平空白']
  ]
  for (const [re, to, note] of escapes) {
    if (re.test(source)) {
      source = source.replace(re, to)
      notes.push(note)
      re.lastIndex = 0
    }
  }

  // 5. 占有量词与原子组（近似处理，语义可能有细微差别）
  if (/(?:[*+?]|\{\d+(?:,\d*)?\})\+/.test(source)) {
    source = source.replace(/((?:[*+?]|\{\d+(?:,\d*)?\})\+)/g, (m) => m.slice(0, -1))
    notes.push('占有量词 → 贪婪量词（近似）')
  }
  if (source.includes('(?>')) {
    source = source.split('(?>').join('(?:')
    notes.push('原子组 → 非捕获组（近似）')
  }

  if (needsUnicode) {
    flags += 'u'
    notes.push('使用 \\p{…} → 加 u flag')
  }

  if (/\(\?[idmsuxU]+[:)]/.test(source)) {
    notes.push('中段内联 flag 无法翻译，可能不兼容')
  }

  return { source, flags, notes }
}

/** `\Q…\E` 之间全部按字面量处理；没有 `\E` 时一路到结尾（与 Java 一致） */
function expandQuoted(input: string, notes: string[]): string {
  if (!input.includes('\\Q')) return input
  let out = ''
  let i = 0
  while (i < input.length) {
    if (input.startsWith('\\Q', i)) {
      const end = input.indexOf('\\E', i + 2)
      const literal = end < 0 ? input.slice(i + 2) : input.slice(i + 2, end)
      out += literal.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
      i = end < 0 ? input.length : end + 2
      continue
    }
    out += input[i]
    i++
  }
  notes.push('\\Q…\\E → 逐字符转义')
  return out
}

/** 属性名归一；不认识的返回 null（保持原样，交给编译期报错） */
function mapProperty(name: string, notes: string[]): string | null {
  // 已带 `=` 的（`Script=Han` / `sc=Han`）原样使用，只把 Java 的 `sc` 换成 `Script`
  if (name.includes('=')) {
    const [key, value] = name.split('=')
    if (key === 'sc' || key === 'scx') {
      notes.push(`\\p{${name}} → Script=${value}`)
      return `Script=${value}`
    }
    return name
  }

  // `IsHan` → Java 的「脚本」别名
  if (name.startsWith('Is')) {
    const script = name.slice(2)
    notes.push(`\\p{${name}} → Script=${script}`)
    return `Script=${script}`
  }

  const posix = POSIX_CLASS[name]
  if (posix !== undefined) {
    notes.push(`\\p{${name}} → \\p{${posix}}`)
    return posix
  }

  // `\p{L}` `\p{Lu}` 这类通用类别 JS 直接认
  if (GENERAL_CATEGORY.test(name)) return name

  // 其余按脚本名处理（Java 里 `\p{Han}` 就是脚本）
  notes.push(`\\p{${name}} → Script=${name}`)
  return `Script=${name}`
}

export function extractRegex(text: string, pattern: string): RegexExtractResult {
  if (pattern.trim() === '') return { values: [], error: null, compatible: true }
  if (text === '') return { values: [], error: null, compatible: true }

  const translated = translateJavaRegex(pattern)
  const risky = findNestedQuantifier(translated.source)
  if (risky !== null) {
    return {
      values: [],
      error: `规则含嵌套无界量词（${risky}），已拒绝执行以避免卡死`,
      compatible: false
    }
  }
  const compiled = compile(translated.source, translated.flags)
  if (compiled.error !== null) {
    return { values: [], error: compiled.error, compatible: false }
  }

  const regex = compiled.regex as RegExp
  const values: string[] = []
  try {
    for (const match of text.matchAll(regex)) {
      // 有捕获组取第 1 组；第 1 组不存在（或未参与匹配）时退回整个匹配
      const value = match.length > 1 && match[1] !== undefined ? match[1] : match[0]
      if (value.trim() !== '') values.push(value)
      if (values.length >= MAX_MATCHES) break
    }
  } catch (err) {
    return { values: [], error: messageOf(err), compatible: false }
  }

  return { values, error: null, compatible: true }
}

/**
 * 应用 `##` 替换链（`rule##正则##替换`）。
 * 与 Java 的 `Matcher.replaceAll` 一致：替换串里的 `$1` 是分组引用，非法正则不动原值。
 */
export function applyReplaces(value: string, ops: ReplaceOp[]): { value: string; errors: string[] } {
  let current = value
  const errors: string[] = []
  for (const op of ops) {
    try {
      current = current.replace(new RegExp(op.pattern, 'g'), op.replacement)
    } catch (err) {
      errors.push(`替换失败：${messageOf(err)}`)
    }
  }
  return { value: current, errors }
}

/**
 * 只做「能不能编译」的探测，不执行。
 *
 * 给导入期用（M4-07）：书源规则来自不可信输入，提前编译一遍就能把不兼容的挑出来，
 * 而不是等用户点搜索时才在日志里看到 `Invalid regular expression`。
 *
 * 不返回 RegExp 本体——调用方拿到编译结果也只会去做同一件事，而共享一个带 `g`
 * 标志的实例会让 `lastIndex` 在多次调用之间互相污染。
 */
export function probeJavaRegex(pattern: string): { ok: boolean; error: string | null; notes: string[] } {
  if (pattern.trim() === '') return { ok: true, error: null, notes: [] }
  const translated = translateJavaRegex(pattern)
  const compiled = compile(translated.source, translated.flags)
  return { ok: compiled.error === null, error: compiled.error, notes: translated.notes }
}

function compile(source: string, flags: string): { regex: RegExp | null; error: string | null } {
  // 带 u flag 时有些写法会更严格（如裸 `\\-`），失败则退回不带 u 再试一次
  const attempts = flags.includes('u') ? [`${flags}g`, `${flags.replace('u', '')}g`] : [`${flags}g`]
  let lastError = ''
  for (const attempt of attempts) {
    try {
      return { regex: new RegExp(source, attempt), error: null }
    } catch (err) {
      lastError = messageOf(err)
    }
  }
  return { regex: null, error: `正则不兼容：${lastError}` }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
