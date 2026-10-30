/**
 * 规则执行器（M4-08 的前置件）。
 *
 * M4-01 只把规则**解析**成表达式树，M4-02~05 只做单点取值。把树跑起来的那一层在这里：
 * 输入一段 HTML / 文本，输出字符串数组。搜索（M4-08）与阅读链路（M4-09）共用它。
 *
 * 求值顺序按解析器定下的优先级逐层展开：
 *   `||`  逐个备选试，**第一个取到非空值的备选胜出**；
 *   `&&`  每个 chain 各自从同一个输入出发，结果**合并**；
 *   `@`   链式，上一步的每个结果分别喂给下一步（多值时逐个执行再摊平）；
 *   `##`  每个结果上依次做正则替换。
 *
 * 五处刻意的选择：
 *   1. **单步出错只当「取不到」，不抛出**。`@css:写坏的选择器 || @css:.good` 是书源里
 *      最常见的自保写法；一步失败就中断整条规则，等于把 `||` 废掉。错误收进 `issues`
 *      供调试面板（M4-11）展示。
 *   2. **空值是信号，不是数据**。所有取值器都丢弃空串，`||` 靠这个判断「这一步没取到」。
 *   3. **链式按值展开**。`@css:.list@tag.li@tag.a@href` 里第二段要分别作用在每个 `<li>` 上，
 *      合并成一个大字符串再选是错的。
 *   4. **JS 拿到的 `result` 永远是字符串**（上一步结果）。跨沙箱边界只传字符串这条线
 *      在 M4-05 就定了，这里不破例。
 *   5. **超时是整条规则共享的**，不是每步 800ms。一条 `a@js:x@js:y@js:z` 若每步都吃满
 *      800ms 就是 2.4s，搜索里 10 源并发直接爆预算。这里按 deadline 逐步收紧。
 */
import type { HttpClient } from '../http/client'
import { extractCss, extractSelf } from '../extractors/css'
import { extractJson } from '../extractors/json'
import { applyReplaces, extractRegex } from '../extractors/regex'
import { extractXpath } from '../extractors/xpath'
import { runScript, type SandboxLimits } from '../js/sandbox'
import { parseRule, type ParsedRule, type ParseOptions, type RuleAtom, type RuleStep, type TakeKind } from '../ruleParser'

export interface RuleIssue {
  message: string
}

export interface RuleExecResult {
  /** 取到的值；全部为空时是空数组 */
  values: string[]
  /** 过程中遇到的问题（坏选择器、坏正则、JS 抛错），**不代表整条规则失败** */
  issues: RuleIssue[]
  /** 本次触达的网络地址（JS 里的 `java.ajax`），供缓存与调试面板 */
  urls: string[]
  elapsedMs: number
}

export interface RuleContext {
  /** 出网通道；JS 的 `java.ajax` 也走它 */
  http: HttpClient
  /** `@put/@get` 与 `{{}}` 共用的变量表（同一次抓取内共享） */
  variables: Map<string, string>
  /** `source.getKey()` 的返回值 */
  sourceKey: string
  /** 书源自带的请求头 */
  headers?: Record<string, string>
  /** 当前页地址，注入给 JS 的 `baseUrl` */
  baseUrl?: string
  limits?: Partial<SandboxLimits>
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
}

/** 整条规则的时间预算：与单步 JS 上限区分开（见文件头第 5 条） */
const RULE_BUDGET_MS = 8_000
/** JS 里 `java.ajax` 的单次超时 */
const AJAX_TIMEOUT_MS = 8_000

/** 变量插值。未定义的变量原样保留——把 `{{key}}` 拼成空串会得到一个「看起来合法」的错 URL */
export function interpolate(text: string, variables: Map<string, string>): string {
  return text.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (whole, key: string) => variables.get(key) ?? whole)
}

/** 执行一条已解析的规则 */
export async function executeRule(
  rule: ParsedRule,
  subject: string,
  ctx: RuleContext
): Promise<RuleExecResult> {
  const startedAt = Date.now()
  const issues: RuleIssue[] = []
  const urls: string[] = []
  const deadline = startedAt + RULE_BUDGET_MS

  for (const group of rule.alternatives) {
    const merged: string[] = []
    for (const chain of group.chains) {
      let values = [subject]
      for (const step of chain.steps) {
        const next: string[] = []
        for (const value of values) {
          const outcome = await runStep(step, value, ctx, deadline)
          next.push(...outcome.values)
          issues.push(...outcome.issues)
          urls.push(...outcome.urls)
        }
        values = next
        // 链式中段取不到东西，后面的步骤没有意义（`a@b` 里 a 空则整条空）
        if (values.length === 0) break
      }
      merged.push(...values)
    }
    if (merged.length > 0) {
      return { values: merged, issues, urls, elapsedMs: Date.now() - startedAt }
    }
  }

  return { values: [], issues, urls, elapsedMs: Date.now() - startedAt }
}

/** 规则原文 → 执行。字段规则一律按正则做默认解释，与 Legado 一致 */
export async function executeRuleText(
  text: string,
  subject: string,
  ctx: RuleContext,
  parseOptions?: ParseOptions
): Promise<RuleExecResult> {
  return executeRule(parseRule(text, parseOptions), subject, ctx)
}

/** 只要一个值：取第一个。搜索的字段规则用这个，列表规则用 `executeRuleText` */
export async function executeFirst(
  text: string,
  subject: string,
  ctx: RuleContext,
  parseOptions?: ParseOptions
): Promise<{ value: string; issues: RuleIssue[]; urls: string[] }> {
  const take = directTakeOf(text)
  if (take !== null) {
    const self = extractSelf(subject, take)
    return {
      value: self.values[0] ?? '',
      issues: self.error ? [{ message: self.error }] : [],
      urls: []
    }
  }
  const result = await executeRuleText(text, subject, ctx, parseOptions)
  return { value: result.values[0] ?? '', issues: result.issues, urls: result.urls }
}

/** 只写取值后缀的规则：`text` / `@text` / `href` / `@html` … */
const DIRECT_TAKE = new Set<TakeKind>(['text', 'textNodes', 'ownText', 'href', 'src', 'html', 'outerHtml', 'content'])

/**
 * `text` / `@href` 这类「只有取值后缀」的规则，作用对象是**上一步取到的那块 HTML 本身**。
 *
 * 真实书源的目录规则几乎都这么写（`"chapterName": "text"`、`"chapterUrl": "href"`）：
 * 列表规则已经把每个 `<li>` 取出来了，这一步只是读它的文本/属性。不能丢给解析器——
 * 解析器会把 `@text` 当成链式步骤的 `@` 前缀剥掉，最后变成选一个叫 `text` 的标签，
 * 整本目录取出来 0 章（M4-09 第一版就栽在这里）。
 */
export function directTakeOf(rule: string): TakeKind | null {
  const trimmed = rule.trim()
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  return DIRECT_TAKE.has(bare as TakeKind) ? (bare as TakeKind) : null
}

interface StepOutcome {
  values: string[]
  issues: RuleIssue[]
  urls: string[]
}

async function runStep(
  step: RuleStep,
  subject: string,
  ctx: RuleContext,
  deadline: number
): Promise<StepOutcome> {
  const outcome = await runAtom(step.atom, subject, ctx, deadline)
  if (step.replaces.length === 0 || outcome.values.length === 0) return outcome

  const values: string[] = []
  const issues = [...outcome.issues]
  for (const value of outcome.values) {
    const replaced = applyReplaces(value, step.replaces)
    for (const error of replaced.errors) issues.push({ message: `替换失败：${error}` })
    if (replaced.value !== '') values.push(replaced.value)
  }
  return { values, issues, urls: outcome.urls }
}

async function runAtom(
  atom: RuleAtom,
  subject: string,
  ctx: RuleContext,
  deadline: number
): Promise<StepOutcome> {
  const plain = (values: string[], issues: RuleIssue[] = []): StepOutcome => ({ values, issues, urls: [] })

  switch (atom.type) {
    case 'selector': {
      if (atom.syntax === 'css') {
        const result = extractCss(subject, atom.expr, atom.take)
        return plain(result.values, result.error ? [{ message: result.error }] : [])
      }
      if (atom.syntax === 'xpath') {
        const result = extractXpath(subject, atom.expr, atom.take)
        return plain(result.values, result.error ? [{ message: result.error }] : [])
      }
      const result = extractJson(subject, atom.expr)
      return plain(result.values, result.error ? [{ message: result.error }] : [])
    }

    case 'regex': {
      const result = extractRegex(subject, atom.pattern)
      return plain(result.values, result.error ? [{ message: result.error }] : [])
    }

    case 'template':
      return plain([interpolate(atom.text, ctx.variables)])

    case 'get': {
      const value = ctx.variables.get(atom.key)
      return plain(value === undefined || value === '' ? [] : [value])
    }

    case 'put': {
      if (atom.value !== null) {
        const nested = await executeRule(atom.value, subject, ctx)
        const value = nested.values[0]
        // 取不到就不写：写个空串进去会把上一次 `@put` 的有效值覆盖掉
        if (value !== undefined && value !== '') ctx.variables.set(atom.key, value)
        // 放行原输入，让 `…@put:{k:…}` 之后还能继续接步骤
        return { values: [subject], issues: nested.issues, urls: nested.urls }
      }
      return plain([subject])
    }

    case 'js': {
      const budget = Math.max(0, Math.min(RULE_BUDGET_MS, deadline - Date.now()))
      if (budget <= 0) {
        return plain([], [{ message: `规则总耗时超过 ${RULE_BUDGET_MS}ms，JS 步骤未执行` }])
      }
      const result = await runScript({
        code: atom.code,
        bindings: {
          result: subject,
          baseUrl: ctx.baseUrl ?? '',
          key: ctx.variables.get('key') ?? ''
        },
        variables: ctx.variables,
        sourceKey: ctx.sourceKey,
        log: ctx.log,
        limits: { ...ctx.limits, totalBudgetMs: budget },
        ajax: async (url, options) => {
          const response = await ctx.http.fetch(url, {
            method: options?.method ?? 'GET',
            headers: { ...ctx.headers, ...options?.headers },
            ...(options?.body === undefined ? {} : { body: options.body }),
            timeoutMs: AJAX_TIMEOUT_MS
          })
          return { status: response.status, url: response.url, body: response.body }
        }
      })
      if (!result.ok) {
        return plain([], [{ message: result.error?.message ?? 'js 规则执行失败' }])
      }
      return {
        values: result.value === '' ? [] : [result.value],
        issues: [],
        urls: result.ajaxUrls
      }
    }
  }
}
