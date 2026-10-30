/**
 * JS 规则返回值的归一（M4-05）。
 *
 * 规则引擎要的是**字符串**，但书源里的 `@js:` 可能返回任何东西：
 * `java.ajax(...).match(...)[1]` 是字符串，`[...new Set(a)]` 是数组，
 * `java.get('x')` 可能是 undefined。统一在这里收口，避免每个调用点各写一套。
 *
 * 口径与 §7.3 的 JSON 取值器保持一致：对象/数组 `JSON.stringify`，空值给空串。
 * 这样「js 取值 → 链式下一段 @json:」能直接接上。
 */

/** JS 值 → 规则引擎用的文本 */
export function toRuleText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    const json = JSON.stringify(value)
    return json === undefined ? '' : json
  } catch {
    // 循环引用、Symbol-only 对象等：宁可给空串（让上层 `||` 降级），也不抛异常打断整条规则
    return ''
  }
}

/** 把任意 JS 值写成可嵌入脚本的字面量；`\u2028/\u2029` 会截断 JS 源码，必须转义 */
export function toJsLiteral(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return 'undefined'
    return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  } catch {
    return 'undefined'
  }
}

/** 只接受合法标识符作为注入的变量名，避免把书源里的怪字符串拼进源码 */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}
