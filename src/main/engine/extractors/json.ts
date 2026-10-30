/**
 * JSONPath 取值器（M4-03）。
 *
 * 用于「接口类」书源：目录/正文/搜索接口直接返回 JSON，规则写成 `$.data.list[*].name`。
 *
 * 输入可以是**原始响应文本**（内部 JSON.parse）或**已解析的值**——链式下一步常拿到
 * 上游返回的对象，两种形态都要能接住。
 *
 * 取值语义：
 *   - 字符串 → 原样返回，只丢「纯空白」值（让上层 `||` 能判空）
 *   - 数字 / 布尔 → 转字符串（`2` → `"2"`，`true` → `"true"`）
 *   - 对象 / 数组 → `JSON.stringify`，供链式下一段 `@json:` 重新解析
 *   - `null` / `undefined` → 丢弃
 *
 * 两条刻意的防御：
 *   1. **表达式预检**：`jsonpath-plus` 对括号不闭合的路径（`$.data[*`）不报错，而是
 *      返回一堆风马牛不相及的值。书源写错一个字就会静默取到错误内容，比报错更糟，
 *      所以这里先做括号/引号配平检查，不合格直接判错。
 *   2. **`eval: 'safe'`**：过滤表达式 `[?(@.price>0)]` 需要求值。用库提供的受限
 *      求值器，而不是 `new Function`。真正的隔离留给 M4-05 的 quickjs 沙箱；
 *      若 M4-12 样本回归出现可疑写法，把这里改成 `eval: false` 即为 fail-closed。
 *
 * 未实现：JSONP（`cb({...})`）剥壳归 M4-06 HTTP 层，取值器只收已解析的 JSON。
 */
import { JSONPath } from 'jsonpath-plus'

export interface JsonExtractResult {
  /** 取到的值（空值已丢弃） */
  values: string[]
  /** JSON 或路径无效时的原因；正常为空 */
  error: string | null
}

export function extractJson(payload: unknown, exprInput: string): JsonExtractResult {
  const expr = normalizeJsonPath(exprInput)
  if (expr === '') return { values: [], error: null }

  const problem = checkJsonPath(expr)
  if (problem !== null) return { values: [], error: problem }

  let data: unknown = payload
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload)
    } catch {
      return { values: [], error: '响应不是合法 JSON' }
    }
  }
  if (data === null || data === undefined) return { values: [], error: null }

  let raw: unknown
  try {
    raw = JSONPath({ path: expr, json: data as object, wrap: true, eval: 'safe' })
  } catch (err) {
    return { values: [], error: `JSONPath 无效：${messageOf(err)}` }
  }

  const values: string[] = []
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const value = toValue(item)
    if (value !== null) values.push(value)
  }
  return { values, error: null }
}

/**
 * 补上 `$` 前缀：书源里 `$.data.list` 是标准写法，但手写时常漏掉 `$`。
 * 只做前缀补全，不改动路径本身。
 */
export function normalizeJsonPath(exprInput: string): string {
  let text = exprInput.trim()
  if (text.startsWith('@json:')) text = text.slice('@json:'.length).trim()
  if (text === '') return ''
  if (text.startsWith('$')) return text
  // `..x` 是递归下降，不能补成 `$...x`
  if (text.startsWith('..') || text.startsWith('[')) return `$${text}`
  return `$.${text}`
}

/**
 * JSONPath 预检：括号 / 引号配平 + 不以 `.` 结尾。
 * 只拦「明显写错」，不追求完整语法校验（真正的解析仍交给库）。
 */
export function checkJsonPath(expr: string): string | null {
  if (!expr.startsWith('$')) return 'JSONPath 必须以 $ 开头'

  let bracket = 0
  let paren = 0
  let quote: string | null = null

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]

    if (quote !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '[') bracket++
    else if (ch === ']') {
      bracket--
      if (bracket < 0) return 'JSONPath 方括号不配平'
    } else if (ch === '(') paren++
    else if (ch === ')') {
      paren--
      if (paren < 0) return 'JSONPath 圆括号不配平'
    }
  }

  if (quote !== null) return 'JSONPath 引号未闭合'
  if (bracket !== 0) return 'JSONPath 方括号不配平'
  if (paren !== 0) return 'JSONPath 圆括号不配平'
  if (expr.endsWith('.')) return 'JSONPath 不能以 . 结尾'
  return null
}

function toValue(item: unknown): string | null {
  if (item === null || item === undefined) return null
  if (typeof item === 'string') return item.trim() === '' ? null : item
  if (typeof item === 'number') return Number.isFinite(item) ? String(item) : null
  if (typeof item === 'boolean') return item ? 'true' : 'false'
  if (typeof item === 'object') {
    try {
      return JSON.stringify(item)
    } catch {
      return null
    }
  }
  return null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
