/**
 * 规则调试的运行轨迹（M4-11）。
 *
 * 抓取层（`book.ts` / `search.ts`）在**真跑的同时**把「发了哪个请求、取了什么值、
 * 花了多久、错在哪」推给这里。刻意不在调试面板里重写一份抓取逻辑：调试结果一旦
 * 与真实链路不一致，面板说的每句话都不能信，那比没有面板更糟。
 *
 * 三条容量上限，防止一次误点把内存吃光（这是一本 5000 章的书能拉出几十万字符的地方）：
 *   1. 响应片段 2KB（产品文档 §2.7 的口径），超出部分截断并标注；
 *   2. 单步值最多 20 条、单条最长 300 字：目录列表规则在整本书上会返回几千项；
 *   3. 总步数 200：20 页目录 × 每页 3 步就接近这个量了，再多也没人看。
 */
import type { SourceDebugStepDTO } from '@shared/dto'

const SNIPPET_LIMIT = 2048
const VALUE_LIMIT = 300
const VALUES_LIMIT = 20
const STEPS_LIMIT = 200

export interface RequestTraceInput {
  /** 这一步在做什么：「详情页」「目录第 2 页」 */
  label: string
  /** 实际请求地址（跟完重定向之后） */
  url: string
  status: number | null
  /** 响应体原文，超长由 `SourceTrace` 截断 */
  snippet: string | null
  elapsedMs: number
  error: string | null
}

export interface RuleTraceInput {
  label: string
  /** 规则原文，原样展示——用户在面板上要对的就是这一串 */
  rule: string
  values: readonly string[]
  elapsedMs: number
  error: string | null
}

export interface TraceSink {
  request(entry: RequestTraceInput): void
  rule(entry: RuleTraceInput): void
}

export class SourceTrace implements TraceSink {
  readonly steps: SourceDebugStepDTO[] = []

  request(entry: RequestTraceInput): void {
    this.push({
      kind: 'request',
      label: entry.label,
      rule: null,
      url: entry.url,
      status: entry.status,
      snippet: clip(entry.snippet, SNIPPET_LIMIT),
      values: [],
      elapsedMs: entry.elapsedMs,
      error: entry.error
    })
  }

  rule(entry: RuleTraceInput): void {
    this.push({
      kind: 'rule',
      label: entry.label,
      rule: entry.rule,
      url: null,
      status: null,
      snippet: null,
      values: entry.values.slice(0, VALUES_LIMIT).map((value) => clip(value, VALUE_LIMIT) ?? ''),
      elapsedMs: entry.elapsedMs,
      error: entry.error
    })
  }

  private push(step: SourceDebugStepDTO): void {
    if (this.steps.length >= STEPS_LIMIT) return
    this.steps.push(step)
  }
}

/** 截断并留一个可辨认的尾巴：「…（已截断，原长 18234 字）」比静默截断好查 */
function clip(text: string | null, limit: number): string | null {
  if (text === null) return null
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字）`
}
