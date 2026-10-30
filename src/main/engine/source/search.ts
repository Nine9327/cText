/**
 * 网络搜索聚合（M4-08）。
 *
 * 一次搜索 = 每个启用书源各发一次请求 → 用 `ruleSearch` 逐字段提取 → 按源分组返回。
 * 四件事在这里收口：URL 插值、并发池、单源超时、同名合并。
 *
 * 六处刻意的选择：
 *   1. **单源失败不影响其他源**。10 个源里有 3 个站点挂了是常态，整次搜索不该只有一个
 *      错误码；失败源连同原因一起返回，界面按「静默降级 + 汇总提示」展示（产品文档 §2.11）。
 *   2. **并发池上限 8，不是「一个源一个 promise」**。50 个源全开会把连接池与内存打满，
 *      而单源内部仍然串行——它只有一次搜索请求，天然串行。
 *   3. **`bookList` 取不到时区分「没结果」与「规则坏了」**。前者是正常返回（空列表），
 *      后者要让用户知道是书源的问题；判据是取值器有没有报错。
 *   4. **书名为空或详情地址取不到的条目直接丢**。列表里放一条点不开的「书」比少一条更糟，
 *      而这类条目通常来自站点改版后的错位规则。
 *   5. **同名合并是「视图合并」，不是数据合并**。保留第一条为主项，其余源放进 `alsoIn`；
 *      用户在界面上看到一条，但能选从哪个源读。把几个源的书混成一条会让「加入书架」时
 *      不知道该存哪个 bookUrl。
 *   6. **超时按项检查，不用 Promise.race**。race 只是让调用方先返回，被丢下的那条任务
 *      还会继续发请求、继续占连接——对一个「要限速、要防封」的抓取器来说，那不是超时，
 *      是失控。这里每一步之前看一次 deadline，超了就停手。
 */
import type {
  SearchOptions,
  SourceSearchFailureDTO,
  SourceSearchGroupDTO,
  SourceSearchItemDTO,
  SourceSearchResultDTO
} from '@shared/dto'
import type { SourceRecord } from '../../db/repositories/sources'
import type { HttpClient, HttpResponse } from '../http/client'
import { collapseWhitespace } from '../extractors/css'
import { executeFirst, executeRuleText, type RuleContext, type RuleIssue } from '../rules/execute'
import type { ParseOptions } from '../ruleParser'
import { normalizeSource, TEXT_SOURCE_TYPE } from './model'
import type { TraceSink } from './trace'
import { buildUrlTarget, resolveHttpUrl } from './url'

/**
 * 字段规则默认按 CSS 解释（与「阅读 3.0」一致）：真实书源里 `"name": "text"`、
 * `"bookUrl": "href"`、`"bookList": ".result-list>li"` 都不带前缀。
 * 引擎默认是正则（M4-01 的口径），这里显式覆盖。
 */
const CSS_DEFAULT: ParseOptions = { defaultSyntax: 'css' }

/** 并发池上限（产品文档 §2.7：全局 8） */
export const SEARCH_CONCURRENCY = 8
/** 单源超时（含请求与全部字段提取） */
export const SEARCH_TIMEOUT_MS = 8_000
/** 单源最多返回多少条：没有分页 UI 之前，一个源刷出 500 条只会让界面卡住 */
const MAX_ITEMS = 50

export interface SearchSource {
  id: string
  name: string
  url: string
  searchUrl: string | null
  header: Record<string, string> | null
  bookSourceType: number
  /** `ruleSearch` 里的规则；键名保持 Legado 原样 */
  rules: Record<string, string>
  /** 记录本身坏了（rule_json 不是 JSON / 不是书源对象）时的原因 */
  broken: string | null
}

export function toSearchSource(record: SourceRecord): SearchSource {
  const base = {
    id: record.id,
    name: record.name,
    url: record.url,
    searchUrl: null as string | null,
    header: null as Record<string, string> | null,
    bookSourceType: TEXT_SOURCE_TYPE,
    rules: {} as Record<string, string>,
    broken: null as string | null
  }

  let raw: unknown
  try {
    raw = JSON.parse(record.ruleJson)
  } catch {
    return { ...base, broken: '书源规则不是合法 JSON，建议重新导入该源' }
  }

  const normalized = normalizeSource(raw)
  if (!normalized.ok) return { ...base, broken: normalized.reason }

  const source = normalized.source
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    searchUrl: source.searchUrl,
    header: source.header,
    bookSourceType: source.bookSourceType,
    rules: source.rules.ruleSearch ?? {},
    broken: null
  }
}

export interface SearchRequest {
  url: string
  method: 'GET' | 'POST'
  body: string | undefined
  headers: Record<string, string>
}

export type SearchRequestResult =
  | { ok: true; request: SearchRequest }
  | { ok: false; reason: string }

/**
 * `searchUrl` → 实际请求。
 *
 * 支持 Legado 的两种写法：
 *   - 纯 URL：`/search?q={{key}}&page={{page}}`
 *   - 带选项：`/search,{"method":"POST","body":"key={{key}}","headers":{"X-Token":"x"}}`
 *
 * `{{key}}` 一律按 URL 编码后的形式代入（字面含空格、`&`、中文的书名不编码会拆坏 query）。
 * 未定义的变量原样保留，让写错的规则在日志里露出 `{{key}}`，而不是变成一个看似合法的错地址。
 */
export function buildSearchUrl(source: SearchSource, keyword: string, page: number): SearchRequestResult {
  const raw = source.searchUrl?.trim() ?? ''
  if (raw === '') return { ok: false, reason: '该源没有配置搜索地址（searchUrl）' }

  // `{{key}}` 一律按 URL 编码后的形式代入（字面含空格、`&`、中文的书名不编码会拆坏 query）
  const variables = new Map<string, string>([
    ['key', encodeURIComponent(keyword)],
    ['page', String(page)]
  ])
  const built = buildUrlTarget(raw, source.url, variables, '搜索地址')
  if (!built.ok) return built
  return { ok: true, request: built.target }
}

/** 站点加在书名后面的尾巴：「三体最新章节」「三体(www.xx.com)」 */
const TITLE_NOISE = /(最新章节|全文阅读|无弹窗|免费阅读|章节列表|txt下载)\s*$/i
const SITE_HINT = /(小说|书屋|文学|阅读|书院|中文网|txt|\.(com|net|org|cn|cc|la|info))/i

export function cleanTitle(input: string): string {
  const original = collapseWhitespace(input)
  if (original === '') return ''

  let title = original.replace(/[（(][^（）()]{0,40}[）)]\s*$/, (whole) => {
    // 括号里像站点名才去掉；「(全集)」「(第二部)」这类是书名的一部分
    const inner = whole.slice(1, -1).trim()
    return SITE_HINT.test(inner) ? '' : whole
  })
  title = title.replace(TITLE_NOISE, '').replace(/[_\-|·]\s*$/, '').trim()
  // 清完什么都不剩（书名本身就叫「最新章节」这种极端情况）就退回原值，别返回空
  return title === '' ? original : title
}

export interface SearchTaskResult {
  items: SourceSearchItemDTO[]
  failure: SourceSearchFailureDTO | null
  elapsedMs: number
}

export async function searchSources(
  records: SourceRecord[],
  keyword: string,
  options: SearchOptions,
  http: HttpClient
): Promise<SourceSearchResultDTO> {
  const startedAt = Date.now()
  const page = options.page !== undefined && options.page > 0 ? options.page : 1
  const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : SEARCH_TIMEOUT_MS
  const sourceIds = options.sourceIds

  const selected = records.filter((record) =>
    sourceIds === undefined ? record.enabled : sourceIds.includes(record.id)
  )
  const sources = selected.map(toSearchSource)

  const outcomes = await runPool(sources, SEARCH_CONCURRENCY, (source) =>
    searchOne(source, keyword, page, http, timeoutMs)
  )

  const groups: SourceSearchGroupDTO[] = []
  const failures: SourceSearchFailureDTO[] = []
  outcomes.forEach((outcome, index) => {
    if (outcome.failure !== null) {
      failures.push(outcome.failure)
      return
    }
    const source = sources[index]
    groups.push({
      sourceId: source.id,
      sourceName: source.name,
      items: outcome.items,
      elapsedMs: outcome.elapsedMs
    })
  })

  if (options.mergeSame !== false) mergeSameBooks(groups)

  return { keyword, groups, failures, elapsedMs: Date.now() - startedAt }
}

/**
 * 搜一个源。导出是为了让调试面板（M4-11）跑**同一条**实现——面板另写一遍
 * 「怎么发请求、怎么取字段」，一旦与真实链路分叉，调出来的结论就不可信。
 *
 * `trace` 只在调试时传；不传时所有埋点都是 `?.`，生产路径零开销。
 */
export async function searchOne(
  source: SearchSource,
  keyword: string,
  page: number,
  http: HttpClient,
  timeoutMs: number,
  trace?: TraceSink
): Promise<SearchTaskResult> {
  const startedAt = Date.now()
  const done = (failure: Omit<SourceSearchFailureDTO, 'sourceId' | 'sourceName'>): SearchTaskResult => ({
    items: [],
    failure: { sourceId: source.id, sourceName: source.name, ...failure },
    elapsedMs: Date.now() - startedAt
  })

  if (source.broken !== null) return done({ code: 'E_BAD_RECORD', message: source.broken })
  if (source.bookSourceType !== TEXT_SOURCE_TYPE) {
    return done({ code: 'E_UNSUPPORTED', message: '仅支持文本类书源（音频/图片/文件暂不支持）' })
  }
  if (source.searchUrl === null) {
    return done({ code: 'E_NO_SEARCH_URL', message: '该源没有配置搜索地址（searchUrl）' })
  }
  if (source.rules['bookList'] === undefined) {
    return done({ code: 'E_NO_RULE', message: '该源没有配置搜索结果列表规则（ruleSearch.bookList）' })
  }

  const built = buildSearchUrl(source, keyword, page)
  if (!built.ok) return done({ code: 'E_BAD_URL', message: built.reason })

  const deadline = startedAt + timeoutMs
  const variables = new Map<string, string>([
    ['key', encodeURIComponent(keyword)],
    ['page', String(page)]
  ])
  const ctx: RuleContext = {
    http,
    variables,
    sourceKey: source.url,
    headers: source.header ?? undefined,
    baseUrl: built.request.url
  }

  let response: HttpResponse
  const requestStartedAt = Date.now()
  try {
    response = await http.fetch(built.request.url, {
      method: built.request.method,
      headers: { ...source.header, ...built.request.headers },
      ...(built.request.body === undefined ? {} : { body: built.request.body }),
      timeoutMs: Math.max(1, deadline - Date.now())
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = message.includes('超时') ? 'E_TIMEOUT' : 'E_REQUEST'
    trace?.request({
      label: '搜索页',
      url: built.request.url,
      status: null,
      snippet: null,
      elapsedMs: Date.now() - requestStartedAt,
      error: message
    })
    return done({ code, message })
  }

  if (response.status >= 400) {
    trace?.request({
      label: '搜索页',
      url: response.url,
      status: response.status,
      snippet: response.body,
      elapsedMs: Date.now() - requestStartedAt,
      error: `HTTP ${response.status}`
    })
    return done({ code: 'E_HTTP', message: `站点返回 HTTP ${response.status}` })
  }

  trace?.request({
    label: '搜索页',
    url: response.url,
    status: response.status,
    snippet: response.body,
    elapsedMs: Date.now() - requestStartedAt,
    error: null
  })

  const issues: RuleIssue[] = []
  const listRule = source.rules['bookList'] as string
  const listStartedAt = Date.now()
  const list = await executeRuleText(listRule, response.body, ctx, CSS_DEFAULT)
  trace?.rule({
    label: '搜索结果列表',
    rule: listRule,
    values: list.values,
    elapsedMs: Date.now() - listStartedAt,
    error: list.issues[0]?.message ?? null
  })
  issues.push(...list.issues)
  if (list.values.length === 0) {
    // 规则本身报错 ≠ 站点真的没有结果：前者要让用户知道书源坏了
    if (issues.length > 0) return done({ code: 'E_RULE', message: issues[0].message })
    return { items: [], failure: null, elapsedMs: Date.now() - startedAt }
  }

  const items: SourceSearchItemDTO[] = []
  for (const [index, html] of list.values.slice(0, MAX_ITEMS).entries()) {
    if (Date.now() > deadline) {
      return done({ code: 'E_TIMEOUT', message: `提取 ${items.length} 条后超过 ${timeoutMs}ms` })
    }

    const field = async (key: string): Promise<string> => {
      const rule = source.rules[key]
      if (rule === undefined) return ''
      const fieldStartedAt = Date.now()
      const result = await executeFirst(rule, html, ctx, CSS_DEFAULT)
      // 只记第 1 条的字段：整页几十条全记会让面板变成几万行
      if (index === 0) {
        trace?.rule({
          label: `第 1 条 · ${key}`,
          rule,
          values: result.value === '' ? [] : [result.value],
          elapsedMs: Date.now() - fieldStartedAt,
          error: result.issues[0]?.message ?? null
        })
      }
      issues.push(...result.issues)
      return result.value.trim()
    }

    const [title, author, intro, kind, lastChapter, coverUrl, bookUrl] = await Promise.all([
      field('name'),
      field('author'),
      field('intro'),
      field('kind'),
      field('lastChapter'),
      field('coverUrl'),
      field('bookUrl')
    ])

    const absolute = resolveHttpUrl(bookUrl, response.url)
    if (title === '' || absolute === null) continue

    items.push({
      sourceId: source.id,
      sourceName: source.name,
      title: cleanTitle(title),
      author: author === '' ? null : author,
      coverUrl: resolveHttpUrl(coverUrl, response.url),
      intro: intro === '' ? null : intro,
      bookUrl: absolute,
      kind: kind === '' ? null : kind,
      lastChapter: lastChapter === '' ? null : lastChapter
    })
  }

  return { items, failure: null, elapsedMs: Date.now() - startedAt }
}

function normalizeName(value: string | null): string {
  if (value === null) return ''
  return value
    .toLowerCase()
    .replace(/[\s《》「」『』\[\]()（）·・:：,，.。!！?？]/g, '')
}

/**
 * 同名合并：书名 + 作者归一化后相同视为同一本。保留首次出现的主项，
 * 其余源记进 `alsoIn` —— 用户要选「从哪个源读」，所以不能把 bookUrl 揉成一个。
 */
function mergeSameBooks(groups: SourceSearchGroupDTO[]): void {
  const seen = new Map<string, SourceSearchItemDTO>()
  for (const group of groups) {
    const kept: SourceSearchItemDTO[] = []
    for (const item of group.items) {
      const key = `${normalizeName(item.title)}\u0000${normalizeName(item.author)}`
      const hit = seen.get(key)
      if (!hit) {
        seen.set(key, item)
        kept.push(item)
        continue
      }
      hit.alsoIn = [
        ...(hit.alsoIn ?? []),
        { sourceId: item.sourceId, sourceName: item.sourceName, bookUrl: item.bookUrl }
      ]
    }
    group.items = kept
  }
}

/** 固定并发度的池：按入参顺序返回结果 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}
