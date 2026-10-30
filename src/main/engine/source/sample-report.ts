/**
 * 真实书源抽样报告（M4-12，**不进 CI**）。
 *
 * 计划里 M4-12 的验收含「100 条真实书源通过率 ≥85%」，但产品文档 §2.7 的红线是
 * 「不内置、不分发任何书源」。这两条只能在**仓库之外**同时成立：
 *
 *   - 样本由用户自己放在任意目录（`pnpm compat:report --dir D:\我的书源`）；
 *   - 本模块只读该目录，不复制、不落库、不导出，报告里也只出现书名/域名与失败归因；
 *   - 合成基线（`compat-smoke.ts`）才是仓库内的回归门禁，要求 100%。
 *
 * 这样「通过率」是发布前自测的输入，而不是一个必须靠分发样本才能满足的数字。
 *
 * 与调试面板的区别：面板一次只调一条源、四段按需勾选；这里是一批源跑完四段，
 * 产出可统计的报告——两者复用同一条抓取链路（`searchSources` / `fetchBookInfo` /
 * `fetchToc` / `fetchChapter`），否则报告里的成功率与用户实际体验无关。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { SourceRecord } from '../../db/repositories/sources'
import { createHttpClient } from '../http/client'
import { classifyFailure, emptyTally, type FailureKind, type FailureTally } from './classify'
import { fetchBookInfo, fetchChapter, fetchToc, toNetworkSource, type NetworkSource } from './book'
import { normalizeSource, TEXT_SOURCE_TYPE } from './model'
import { searchSources } from './search'

export type SampleStage = 'search' | 'info' | 'toc' | 'content'

export interface StageResult {
  stage: SampleStage
  ok: boolean
  code: string | null
  message: string | null
  kind: FailureKind | null
  elapsedMs: number
}

export interface SourceSampleResult {
  /** 文件名 + 序号，报告里定位样本用；不含绝对路径 */
  file: string
  name: string
  url: string
  ok: boolean
  /** 失败发生在哪一段（全部通过时为 null） */
  failedStage: SampleStage | null
  stages: StageResult[]
}

export interface SampleReport {
  startedAt: number
  finishedAt: number
  total: number
  passed: number
  /** 0..1 */
  rate: number
  byKind: FailureTally
  sources: SourceSampleResult[]
  /** 被跳过的条目（非文本源、坏记录、不是书源对象） */
  skipped: Array<{ file: string; reason: string }>
}

export interface SampleReportOptions {
  dir: string
  keyword?: string
  /** 最多跑多少条；0/undefined = 全部 */
  limit?: number
  /** 并发源数，默认 3：抓的是别人的站，别比搜索功能还激进 */
  concurrency?: number
  /** 单段超时 */
  timeoutMs?: number
}

const DEFAULT_KEYWORD = '三体'
const DEFAULT_CONCURRENCY = 3
const DEFAULT_TIMEOUT_MS = 12_000

/** 读目录下的 JSON；单个对象、对象数组、以及「一行一个源」都收 */
async function loadFiles(dir: string): Promise<Array<{ file: string; payload: unknown }>> {
  const names = (await readdir(dir)).filter((name) => extname(name).toLowerCase() === '.json').sort()
  const out: Array<{ file: string; payload: unknown }> = []
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8')
    try {
      out.push({ file: name, payload: JSON.parse(text) })
    } catch {
      // 一行一个源的导出格式：解析失败时再按行试一次
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      const items: unknown[] = []
      for (const line of lines) {
        try {
          items.push(JSON.parse(line))
        } catch {
          items.length = 0
          break
        }
      }
      if (items.length === 0) {
        out.push({ file: name, payload: null })
      } else {
        out.push({ file: name, payload: items })
      }
    }
  }
  return out
}

interface SampleItem {
  record: SourceRecord
  file: string
}

function makeRecord(payload: Record<string, unknown>, index: number): SourceRecord {
  const url = String(payload['bookSourceUrl'] ?? '')
  return {
    id: `sample-${index}`,
    url,
    name: String(payload['bookSourceName'] ?? url),
    group: null,
    enabled: true,
    customOrder: index,
    compatLevel: 'full',
    compatNote: null,
    ruleJson: JSON.stringify(payload),
    lastUsedAt: null,
    createdAt: 0,
    failStreak: 0,
    breakerUntil: null,
    lastFailure: null
  }
}

interface StageOutcome {
  ok: boolean
  code: string | null
  message: string | null
}

function failureOf(err: unknown): StageOutcome {
  const detail = err as { code?: string; message?: string }
  return {
    ok: false,
    code: detail.code ?? null,
    message: detail.message ?? (err instanceof Error ? err.message : String(err))
  }
}

/** 四段跑一遍；任一失败立即停（后面的段依赖前面的输出，硬跑只会产出噪声） */
async function runOne(
  item: SampleItem,
  keyword: string,
  http: ReturnType<typeof createHttpClient>,
  timeoutMs: number
): Promise<SourceSampleResult> {
  const { record, file } = item
  const source: NetworkSource = toNetworkSource(record)
  const stages: StageResult[] = []
  const push = (stage: SampleStage, outcome: StageOutcome, elapsedMs: number): void => {
    const cls = outcome.ok ? null : classifyFailure({ code: outcome.code, message: outcome.message })
    stages.push({
      stage,
      ok: outcome.ok,
      code: outcome.code,
      message: outcome.message,
      kind: cls?.kind ?? null,
      elapsedMs
    })
  }

  let bookUrl = ''
  let startedAt = Date.now()
  try {
    const result = await searchSources([record], keyword, { timeoutMs }, http)
    const group = result.groups[0]
    const item = group?.items[0]
    if (group === undefined || item === undefined) {
      const failure = result.failures[0]
      push('search', {
        ok: false,
        code: failure?.code ?? 'E_EMPTY',
        message: failure?.message ?? '搜索没有返回任何结果'
      }, Date.now() - startedAt)
      return finish(record, file, stages)
    }
    bookUrl = item.bookUrl
    push('search', { ok: true, code: null, message: null }, Date.now() - startedAt)
  } catch (err) {
    push('search', failureOf(err), Date.now() - startedAt)
    return finish(record, file, stages)
  }

  startedAt = Date.now()
  let tocUrl = ''
  try {
    const info = await fetchBookInfo({ http, source, deadline: Date.now() + timeoutMs }, bookUrl)
    // 详情规则缺 name 是常态（很多源只有目录和正文），只有「整页取不到任何字段」才算失败
    const gotSomething = info.info.title !== null || info.info.author !== null || info.info.intro !== null
    push(
      'info',
      gotSomething
        ? { ok: true, code: null, message: null }
        : { ok: false, code: 'E_EMPTY', message: '详情页没有取到任何字段' },
      Date.now() - startedAt
    )
    tocUrl = info.tocUrl
  } catch (err) {
    push('info', failureOf(err), Date.now() - startedAt)
    return finish(record, file, stages)
  }

  startedAt = Date.now()
  let chapterUrl = ''
  try {
    const toc = await fetchToc({ http, source, deadline: Date.now() + timeoutMs }, tocUrl)
    chapterUrl = toc.chapters[0]?.url ?? ''
    push(
      'toc',
      toc.chapters.length > 0
        ? { ok: true, code: null, message: null }
        : { ok: false, code: 'E_EMPTY_TOC', message: '目录为空' },
      Date.now() - startedAt
    )
    if (toc.chapters.length === 0) return finish(record, file, stages)
  } catch (err) {
    push('toc', failureOf(err), Date.now() - startedAt)
    return finish(record, file, stages)
  }

  startedAt = Date.now()
  try {
    const content = await fetchChapter({ http, source, deadline: Date.now() + timeoutMs }, chapterUrl)
    push(
      'content',
      content.html.length > 0
        ? { ok: true, code: null, message: null }
        : { ok: false, code: 'E_EMPTY_CONTENT', message: '正文为空' },
      Date.now() - startedAt
    )
  } catch (err) {
    push('content', failureOf(err), Date.now() - startedAt)
  }
  return finish(record, file, stages)
}

function finish(record: SourceRecord, file: string, stages: StageResult[]): SourceSampleResult {
  const failed = stages.find((stage) => !stage.ok)
  return {
    file,
    name: record.name,
    url: record.url,
    ok: failed === undefined,
    failedStage: failed?.stage ?? null,
    stages
  }
}

export async function runSampleReport(options: SampleReportOptions): Promise<SampleReport> {
  const startedAt = Date.now()
  const keyword = options.keyword ?? DEFAULT_KEYWORD
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  const files = await loadFiles(options.dir)
  const records: SampleItem[] = []
  const skipped: Array<{ file: string; reason: string }> = []

  for (const [index, entry] of files.entries()) {
    if (entry.payload === null) {
      skipped.push({ file: entry.file, reason: '不是合法 JSON' })
      continue
    }
    const items = Array.isArray(entry.payload) ? entry.payload : [entry.payload]
    for (const item of items) {
      const normalized = normalizeSource(item)
      if (!normalized.ok) {
        skipped.push({ file: entry.file, reason: normalized.reason })
        continue
      }
      if (normalized.source.bookSourceType !== TEXT_SOURCE_TYPE) {
        skipped.push({ file: entry.file, reason: '非文本类书源（音频/图片/文件）' })
        continue
      }
      records.push({ record: makeRecord(normalized.source.raw, records.length + index), file: entry.file })
    }
  }

  const limited = options.limit !== undefined && options.limit > 0 ? records.slice(0, options.limit) : records
  const http = createHttpClient()
  const results: SourceSampleResult[] = []
  const byKind = emptyTally()

  try {
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        const item = limited[index]
        if (item === undefined) return
        const result = await runOne(item, keyword, http, timeoutMs)
        const failed = result.stages.find((stage) => !stage.ok)
        if (failed?.kind != null) byKind[failed.kind] += 1
        results.push(result)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  } finally {
    await http.close()
  }

  // 并发完成顺序不稳定，报告按输入顺序排，两次跑同一批样本才能 diff
  const order = new Map(limited.map((item, index) => [item.record.id, index]))
  results.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0))

  const passed = results.filter((result) => result.ok).length
  return {
    startedAt,
    finishedAt: Date.now(),
    total: results.length,
    passed,
    rate: results.length === 0 ? 0 : passed / results.length,
    byKind,
    sources: results,
    skipped
  }
}

/** 报告 → Markdown。只写书名、域名、失败归因，不写规则原文（避免报告本身变成书源分发） */
export function renderMarkdown(report: SampleReport): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const stageMark = (result: SourceSampleResult, stage: SampleStage): string => {
    const hit = result.stages.find((item) => item.stage === stage)
    if (hit === undefined) return '—'
    return hit.ok ? '✅' : `❌ ${hit.kind ?? 'unknown'}`
  }

  const lines: string[] = [
    '# 书源兼容性抽样报告（M4-12）',
    '',
    `- 生成时间：${new Date(report.finishedAt).toISOString()}`,
    `- 样本：${report.total} 条（跳过 ${report.skipped.length} 条）`,
    `- 四段全通：${report.passed} 条，通过率 **${pct(report.rate)}**`,
    '',
    '## 失败归类',
    ''
  ]

  const kinds = Object.entries(report.byKind).filter(([, count]) => count > 0)
  if (kinds.length === 0) lines.push('无失败。')
  else {
    lines.push('| 类别 | 条数 |', '| --- | --- |')
    for (const [kind, count] of kinds) lines.push(`| ${kind} | ${count} |`)
  }

  lines.push('', '## 逐条结果', '', '| 源 | 搜索 | 详情 | 目录 | 正文 | 失败原因 |', '| --- | --- | --- | --- | --- | --- |')
  for (const result of report.sources) {
    const failed = result.stages.find((stage) => !stage.ok)
    const reason = failed === null || failed === undefined ? '' : `${failed.stage}: ${failed.message ?? ''}`.replace(/\|/g, '/')
    lines.push(
      `| ${result.name.replace(/\|/g, '/')} | ${stageMark(result, 'search')} | ${stageMark(result, 'info')} | ${stageMark(result, 'toc')} | ${stageMark(result, 'content')} | ${reason} |`
    )
  }

  if (report.skipped.length > 0) {
    lines.push('', '## 跳过', '')
    for (const item of report.skipped) lines.push(`- ${item.file}：${item.reason}`)
  }

  lines.push('', '> 样本由使用者自行提供，未随应用分发；报告只用于发布前自测。', '')
  return lines.join('\n')
}

/** 落盘：同名 `.json` + `.md`，目录不存在就建 */
export async function writeSampleReport(report: SampleReport, outFile: string): Promise<{ json: string; markdown: string }> {
  await mkdir(dirname(outFile), { recursive: true })
  const json = outFile.replace(/\.(json|md)$/i, '') + '.json'
  const markdown = outFile.replace(/\.(json|md)$/i, '') + '.md'
  await writeFile(json, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(markdown, renderMarkdown(report), 'utf8')
  return { json, markdown }
}
