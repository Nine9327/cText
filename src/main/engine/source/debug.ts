/**
 * 规则调试（M4-11）。产品文档 §2.7 的「最小形态」：一个 URL、一个书源、四段一次跑完，
 * 逐段给出规则原文 / 实际 URL / 状态 / 响应片段 / 提取结果 / 耗时 / 错误，只读。
 *
 * 五条刻意的选择：
 *   1. **跑的是真实链路**。四段直接调 `searchOne` / `fetchBookInfo` / `fetchToc` /
 *      `fetchChapter`，只是多挂一个 `trace`。另写一份「调试用抓取」会立刻分叉，
 *      面板调通了、正式链路仍失败，那比没有面板更耽误事。
 *   2. **只读**。整个文件不接收 `Db`，也不写任何表：调试不该改变书架、目录与缓存。
 *   3. **缺前置输入就显式跳过**，不是假装成功。没填关键词就不跑搜索、没填地址就不跑详情，
 *      段里写清原因——「空结果」和「没跑」在排查时是两件事。
 *   4. **每段独立预算**。目录 20 页按同站 1s 节流就要 20 秒，四段共享一个截止时间会让
 *      最后一段永远超时；每段 25 秒、总共 90 秒封顶。
 *   5. **段的顺序固定**（search → info → toc → content）。后面的段依赖前面的产物
 *      （tocUrl、第一章地址），按用户勾选顺序跑会得到「先跑正文再跑目录」这种没有意义的组合。
 */
import type {
  SourceDebugInputDTO,
  SourceDebugPhase,
  SourceDebugResultDTO,
  SourceDebugSectionDTO
} from '@shared/dto'
import type { SourceRecord } from '../../db/repositories/sources'
import type { HttpClient } from '../http/client'
import {
  NetworkFetchError,
  fetchBookInfo,
  fetchChapter,
  fetchToc,
  toNetworkSource
} from './book'
import { searchOne, toSearchSource } from './search'
import { SourceTrace } from './trace'

/** 单段预算：目录 20 页 × 同站 1s 节流刚好压在 20 秒附近 */
const SECTION_BUDGET_MS = 25_000
/** 四段合计上限：超过说明站点在挂，再等也没有信息量 */
const TOTAL_BUDGET_MS = 90_000

/** 固定执行顺序：后面的段依赖前面的产物 */
const PHASE_ORDER: readonly SourceDebugPhase[] = ['search', 'info', 'toc', 'content']

export interface DebugRunOptions {
  /** 总量预算，自检会调小以便快速验证超时分支 */
  totalBudgetMs?: number
  sectionBudgetMs?: number
}

export async function runSourceDebug(
  record: SourceRecord,
  input: SourceDebugInputDTO,
  http: HttpClient,
  options: DebugRunOptions = {}
): Promise<SourceDebugResultDTO> {
  const startedAt = Date.now()
  const totalDeadline = startedAt + (options.totalBudgetMs ?? TOTAL_BUDGET_MS)
  const sectionBudget = options.sectionBudgetMs ?? SECTION_BUDGET_MS

  const wanted = new Set<SourceDebugPhase>(
    input.phases !== undefined && input.phases.length > 0 ? input.phases : PHASE_ORDER
  )
  const url = nonEmpty(input.url)
  const keyword = nonEmpty(input.keyword)
  const chapterUrl = nonEmpty(input.chapterUrl)
  const source = toNetworkSource(record)

  const sections: SourceDebugSectionDTO[] = []
  /** 目录地址：详情段跑成功就用规则给的，否则退回用户填的地址 */
  let tocUrl: string | null = url
  /** 正文地址：用户直接给的优先，其次取目录第一章 */
  let firstChapterUrl: string | null = chapterUrl

  for (const phase of PHASE_ORDER) {
    if (!wanted.has(phase)) continue
    const sectionStartedAt = Date.now()
    const trace = new SourceTrace()
    const deadline = Math.min(totalDeadline, sectionStartedAt + sectionBudget)

    if (phase === 'search') {
      if (keyword === null) {
        sections.push(skip('search', '未填搜索关键词，跳过搜索段'))
        continue
      }
      const outcome = await searchOne(
        toSearchSource(record),
        keyword,
        1,
        http,
        Math.max(1, deadline - Date.now()),
        trace
      )
      sections.push({
        phase,
        ok: outcome.failure === null,
        skipped: false,
        summary: outcome.failure === null ? `${outcome.items.length} 条结果` : outcome.failure.message,
        error: outcome.failure === null ? null : `${outcome.failure.code}：${outcome.failure.message}`,
        elapsedMs: Date.now() - sectionStartedAt,
        steps: trace.steps
      })
      continue
    }

    if (phase === 'info') {
      if (url === null) {
        sections.push(skip('info', '未填详情页地址，跳过详情段'))
        continue
      }
      try {
        const result = await fetchBookInfo({ http, source, deadline, trace }, url)
        tocUrl = result.tocUrl
        sections.push({
          phase,
          ok: true,
          skipped: false,
          summary: describeInfo(result.info.title, result.info.author),
          error: null,
          elapsedMs: Date.now() - sectionStartedAt,
          steps: trace.steps
        })
      } catch (err) {
        sections.push(fail(phase, err, sectionStartedAt, trace))
      }
      continue
    }

    if (phase === 'toc') {
      if (tocUrl === null) {
        sections.push(skip('toc', '没有可用的目录地址（先填详情页地址，或直接填目录页）'))
        continue
      }
      try {
        const result = await fetchToc({ http, source, deadline, trace }, tocUrl)
        firstChapterUrl = firstChapterUrl ?? result.chapters[0]?.url ?? null
        sections.push({
          phase,
          ok: true,
          skipped: false,
          summary: `${result.chapters.length} 章 / ${result.pages} 页${result.truncated ? '（触及页数上限）' : ''}`,
          error: null,
          elapsedMs: Date.now() - sectionStartedAt,
          steps: trace.steps
        })
      } catch (err) {
        sections.push(fail(phase, err, sectionStartedAt, trace))
      }
      continue
    }

    if (firstChapterUrl === null) {
      sections.push(skip('content', '没有可用的章节地址（勾选目录段，或直接填章节地址）'))
      continue
    }
    try {
      const result = await fetchChapter({ http, source, deadline, trace }, firstChapterUrl)
      sections.push({
        phase,
        ok: true,
        skipped: false,
        summary: `${plainLength(result.html)} 字 / ${result.pages} 页`,
        error: null,
        elapsedMs: Date.now() - sectionStartedAt,
        steps: trace.steps
      })
    } catch (err) {
      sections.push(fail(phase, err, sectionStartedAt, trace))
    }
  }

  return {
    sourceId: record.id,
    sourceName: record.name,
    url,
    keyword,
    sections,
    elapsedMs: Date.now() - startedAt
  }
}

function nonEmpty(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  return text === '' ? null : text
}

function describeInfo(title: string | null, author: string | null): string {
  if (title === null && author === null) return '规则没取到书名与作者'
  return [title ?? '（未取到书名）', author].filter((part) => part !== null).join(' · ')
}

/** 正文是 `<p>` 段落 HTML，报「多少字」比报「多少字节」对用户有意义 */
function plainLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length
}

function skip(phase: SourceDebugPhase, summary: string): SourceDebugSectionDTO {
  return { phase, ok: false, skipped: true, summary, error: null, elapsedMs: 0, steps: [] }
}

function fail(
  phase: SourceDebugPhase,
  err: unknown,
  startedAt: number,
  trace: SourceTrace
): SourceDebugSectionDTO {
  // 抓取层的错误自带机器码（E_HTTP / E_RULE / E_TIMEOUT），带上它才能和日志对上
  const message = err instanceof Error ? err.message : String(err)
  const code = err instanceof NetworkFetchError ? `${err.code}：` : ''
  return {
    phase,
    ok: false,
    skipped: false,
    summary: message,
    error: `${code}${message}`,
    elapsedMs: Date.now() - startedAt,
    steps: trace.steps
  }
}
