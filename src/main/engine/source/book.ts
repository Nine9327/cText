/**
 * 网络书的抓取层（M4-09）：详情 → 目录 → 正文。
 *
 * 与 `search.ts` 的分工：搜索只要「一页 → 一批条目」，这里要跑完一本书的三段链路，
 * 且目录与正文都可能分页（`nextTocUrl` / `nextContentUrl`）。四段规则各自的字段名
 * 保持「阅读 3.0」原样，不做自定义映射（与 `model.ts` 的口径一致）。
 *
 * 六处刻意的选择：
 *   1. **分页有硬上限**。目录 20 页、正文 5 页。不设上限的书源可以把一次「加入书架」
 *      变成几百个请求——用户的机器不是爬虫节点，站点也不该这么被打。
 *   2. **翻页 URL 去重**。不少站点的「下一页」在最后一页会指回自己或第一页，
 *      不去重就是死循环；`seen` 集合比「最多 20 页」更早生效。
 *   3. **单页失败不返回半本书**。目录取到第 3 页时站点 500，抛错而不是「先给 2 页」——
 *      半本目录会被写进库，表现为「章节数莫名其妙少了一截」，比直接失败更难查。
 *   4. **正文一律转成段落 HTML**。站点给的 `<div><br></div>`、`&nbsp;` 缩进、
 *      行内广告 `<span>` 混在一起，直接塞进阅读器会排版崩坏；统一抽成纯文本再包 `<p>`，
 *      阅读器的段落样式（首行缩进）才生效。代价是丢掉加粗/斜体——小说正文里可接受。
 *   5. **净化是白名单式**。`script / iframe / img / on*` 一律丢：正文是 `v-html` 渲染的，
 *      站点可控的 HTML 进渲染层等于把 XSS 面交给一个陌生网站。
 *   6. **错误码与搜索一致**（E_TIMEOUT / E_HTTP / E_RULE …）。同一个站点在搜索里
 *      是「超时」，在正文里也应该是「超时」，否则 M4-11 的调试面板要维护两套词表。
 */
import { load } from 'cheerio'
import type { HttpClient, HttpResponse } from '../http/client'
import { executeFirst, executeRuleText, type RuleContext, type RuleIssue } from '../rules/execute'
import type { ParseOptions } from '../ruleParser'
import type { SourceRecord } from '../../db/repositories/sources'
import { normalizeSource, TEXT_SOURCE_TYPE } from './model'
import type { TraceSink } from './trace'
import { buildUrlTarget, resolveHttpUrl } from './url'

/**
 * 详情/目录/正文的规则默认按 CSS 解释。
 *
 * 「阅读 3.0」里只有搜索地址和正文翻页这类 URL 才写前缀，字段规则（`text`、`href`、
 * `#list dd`）都是裸的 CSS 选择器。引擎的默认值是正则（M4-01 的口径），
 * 所以这一层必须显式覆盖，否则一整本书的目录会变成 0 章。
 */
const CSS_DEFAULT: ParseOptions = { defaultSyntax: 'css' }

/** 目录最多翻 20 页（计划里 M4-09 的验收口径就是「20 页内正确拼接」） */
export const MAX_TOC_PAGES = 20
/** 正文最多翻 5 页：再长的「一章」通常是站点把整卷塞进一个页面，翻它没有意义 */
export const MAX_CONTENT_PAGES = 5

export type NetworkFetchCode =
  | 'E_BAD_RECORD'
  | 'E_UNSUPPORTED'
  | 'E_NO_RULE'
  | 'E_BAD_URL'
  | 'E_REQUEST'
  | 'E_TIMEOUT'
  | 'E_HTTP'
  | 'E_RULE'
  | 'E_EMPTY_TOC'
  | 'E_EMPTY_CONTENT'

export class NetworkFetchError extends Error {
  constructor(
    readonly code: NetworkFetchCode,
    message: string
  ) {
    super(message)
    this.name = 'NetworkFetchError'
  }
}

export interface NetworkSource {
  id: string
  name: string
  url: string
  header: Record<string, string> | null
  bookSourceType: number
  /** `ruleBookInfo` / `ruleToc` / `ruleContent` 的原始字段，键名不动 */
  info: Record<string, string>
  toc: Record<string, string>
  content: Record<string, string>
  /** 记录本身坏了（rule_json 不是 JSON / 不是书源对象）时的原因 */
  broken: string | null
}

export function toNetworkSource(record: SourceRecord): NetworkSource {
  const base: NetworkSource = {
    id: record.id,
    name: record.name,
    url: record.url,
    header: null,
    bookSourceType: TEXT_SOURCE_TYPE,
    info: {},
    toc: {},
    content: {},
    broken: null
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
    ...base,
    header: source.header,
    bookSourceType: source.bookSourceType,
    info: source.rules.ruleBookInfo ?? {},
    toc: source.rules.ruleToc ?? {},
    content: source.rules.ruleContent ?? {},
    broken: null
  }
}

/** 先做「这个源能不能用来读书」的三项前置检查，避免每段各写一遍 */
function assertUsable(source: NetworkSource): void {
  if (source.broken !== null) throw new NetworkFetchError('E_BAD_RECORD', source.broken)
  if (source.bookSourceType !== TEXT_SOURCE_TYPE) {
    throw new NetworkFetchError('E_UNSUPPORTED', '仅支持文本类书源（音频/图片/文件暂不支持）')
  }
}

export interface FetchOptions {
  http: HttpClient
  source: NetworkSource
  /** 整段链路（含分页）的截止时间，不是单次请求的 */
  deadline: number
  /** 规则里的 `{{}}` 变量；详情/目录/正文一般用不到，保留给 `@js` 场景 */
  variables?: Map<string, string>
  /** 调试面板的轨迹收集器（M4-11）。不传就是零开销：所有埋点都是 `?.` 调用 */
  trace?: TraceSink
}

function ruleContext(options: FetchOptions, baseUrl: string): RuleContext {
  return {
    http: options.http,
    variables: options.variables ?? new Map<string, string>(),
    sourceKey: options.source.url,
    headers: options.source.header ?? undefined,
    baseUrl
  }
}

async function fetchPage(options: FetchOptions, url: string, label: string): Promise<HttpResponse> {
  const remaining = options.deadline - Date.now()
  if (remaining <= 0) {
    options.trace?.request({ label, url, status: null, snippet: null, elapsedMs: 0, error: '整段超时，请求未发出' })
    throw new NetworkFetchError('E_TIMEOUT', `${label}超时，请稍后重试`)
  }

  const startedAt = Date.now()
  let response: HttpResponse
  try {
    response = await options.http.fetch(url, {
      headers: options.source.header ?? undefined,
      timeoutMs: Math.max(1000, Math.min(remaining, 15_000))
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    options.trace?.request({
      label,
      url,
      status: null,
      snippet: null,
      elapsedMs: Date.now() - startedAt,
      error: message
    })
    throw new NetworkFetchError(message.includes('超时') ? 'E_TIMEOUT' : 'E_REQUEST', message)
  }
  if (response.status >= 400) {
    // 4xx/5xx 也记一笔：调试时「站点返回 403」和「规则取不到值」是两种完全不同的病
    options.trace?.request({
      label,
      url: response.url,
      status: response.status,
      snippet: response.body,
      elapsedMs: Date.now() - startedAt,
      error: `HTTP ${response.status}`
    })
    throw new NetworkFetchError('E_HTTP', `站点返回 HTTP ${response.status}（${label}）`)
  }
  options.trace?.request({
    label,
    url: response.url,
    status: response.status,
    snippet: response.body,
    elapsedMs: Date.now() - startedAt,
    error: null
  })
  return response
}

// ---------------------------------------------------------------- 详情

export interface BookInfo {
  title: string | null
  author: string | null
  intro: string | null
  kind: string | null
  lastChapter: string | null
  coverUrl: string | null
  wordCount: string | null
}

export interface BookInfoResult {
  info: BookInfo
  /** 目录首页地址。规则没给 `tocUrl` 时就是详情页自己 */
  tocUrl: string
  /** 详情页最终地址（跟完重定向后），目录规则里的相对地址按它补全 */
  finalUrl: string
  issues: RuleIssue[]
}

/**
 * 取详情页。
 *
 * `ruleBookInfo` 缺失时**不发请求**直接返回空信息 + 详情页当目录页：相当一部分
 * 书源（尤其是只有目录和正文的极简源）根本没写详情规则，为了一条规则都不用的页面
 * 多发一次请求只会让「加入书架」慢 1 秒。
 */
export async function fetchBookInfo(
  options: FetchOptions,
  bookUrl: string
): Promise<BookInfoResult> {
  assertUsable(options.source)

  const base = resolveHttpUrl(bookUrl, options.source.url)
  if (base === null) throw new NetworkFetchError('E_BAD_URL', `详情页地址不合法：${bookUrl.slice(0, 120)}`)

  const rules = options.source.info
  const info: BookInfo = {
    title: null,
    author: null,
    intro: null,
    kind: null,
    lastChapter: null,
    coverUrl: null,
    wordCount: null
  }
  if (Object.keys(rules).length === 0) {
    return { info, tocUrl: base, finalUrl: base, issues: [] }
  }

  const built = buildUrlTarget(base, options.source.url, options.variables ?? new Map(), '详情页地址')
  if (!built.ok) throw new NetworkFetchError('E_BAD_URL', built.reason)

  const response = await fetchPage(options, built.target.url, '详情页')
  const ctx = ruleContext(options, response.url)
  const issues: RuleIssue[] = []

  const field = async (key: string): Promise<string | null> => {
    const rule = rules[key]
    if (rule === undefined) return null
    const startedAt = Date.now()
    const result = await executeFirst(rule, response.body, ctx, CSS_DEFAULT)
    options.trace?.rule({
      label: `详情字段 ${key}`,
      rule,
      values: result.value === '' ? [] : [result.value],
      elapsedMs: Date.now() - startedAt,
      error: result.issues[0]?.message ?? null
    })
    issues.push(...result.issues)
    const value = result.value.trim()
    return value === '' ? null : value
  }

  // 顺序执行而不是 Promise.all：`@put` 会写共享变量表，并发取字段时先后顺序不确定
  info.title = await field('name')
  info.author = await field('author')
  info.intro = await field('intro')
  info.kind = await field('kind')
  info.lastChapter = await field('lastChapter')
  info.wordCount = await field('wordCount')
  const cover = await field('coverUrl')
  info.coverUrl = cover === null ? null : resolveHttpUrl(cover, response.url)
  const tocUrl = await field('tocUrl')

  return {
    info,
    tocUrl: tocUrl === null ? response.url : (resolveHttpUrl(tocUrl, response.url) ?? response.url),
    finalUrl: response.url,
    issues
  }
}

// ---------------------------------------------------------------- 目录

export interface TocChapter {
  title: string
  url: string
}

export interface TocResult {
  chapters: TocChapter[]
  /** 实际翻了几页 */
  pages: number
  /** 撞上 20 页上限（说明这书目录还没翻完） */
  truncated: boolean
  issues: RuleIssue[]
}

/** 目录规则的最小可用判断，供上层在发请求前就给出人话原因 */
export function tocRuleReady(source: NetworkSource): boolean {
  return source.toc['chapterList'] !== undefined
}

export async function fetchToc(options: FetchOptions, startUrl: string): Promise<TocResult> {
  assertUsable(options.source)
  const source = options.source
  if (!tocRuleReady(source)) {
    throw new NetworkFetchError('E_NO_RULE', '该源没有配置目录列表规则（ruleToc.chapterList）')
  }

  const issues: RuleIssue[] = []
  const chapters: TocChapter[] = []
  const seenPages = new Set<string>()
  const seenChapters = new Set<string>()

  let current: string | null = startUrl
  let pages = 0
  let truncated = false

  while (current !== null) {
    if (pages >= MAX_TOC_PAGES) {
      truncated = true
      issues.push({ message: `目录超过 ${MAX_TOC_PAGES} 页，只取了前 ${MAX_TOC_PAGES} 页` })
      break
    }
    if (seenPages.has(current)) break
    seenPages.add(current)

    const response = await fetchPage(options, current, `目录第 ${pages + 1} 页`)
    pages++
    const ctx = ruleContext(options, response.url)

    const listStartedAt = Date.now()
    const list = await executeRuleText(source.toc['chapterList'] as string, response.body, ctx, CSS_DEFAULT)
    options.trace?.rule({
      label: `目录列表（第 ${pages} 页）`,
      rule: source.toc['chapterList'] as string,
      values: list.values,
      elapsedMs: Date.now() - listStartedAt,
      error: list.issues[0]?.message ?? null
    })
    issues.push(...list.issues)
    if (list.values.length === 0) {
      if (list.issues.length > 0) throw new NetworkFetchError('E_RULE', list.issues[0].message)
      if (pages === 1) throw new NetworkFetchError('E_EMPTY_TOC', '目录页没有取到任何章节，书源规则可能已失效')
      break
    }

    for (const [index, block] of list.values.entries()) {
      // 只记第 1 条的字段取值：整页都记会让面板变成几千行，而「列表取到、字段取不到」
      // 这种典型故障，看第一条就够了
      if (index === 0 && options.trace !== undefined) {
        await traceChapterSample(options.trace, source, block, ctx)
      }
      const title = await fieldOf(source.toc['chapterName'], block, ctx, issues, CSS_DEFAULT)
      const href = await fieldOf(source.toc['chapterUrl'], block, ctx, issues, CSS_DEFAULT)
      const url = href === null ? null : resolveHttpUrl(href, response.url)
      if (title === null || url === null) continue
      if (seenChapters.has(url)) continue
      seenChapters.add(url)
      chapters.push({ title: collapseTitle(title), url })
    }

    const nextRule = source.toc['nextTocUrl']
    if (nextRule === undefined) break
    const nextStartedAt = Date.now()
    const next = await executeRuleText(nextRule, response.body, ctx, CSS_DEFAULT)
    options.trace?.rule({
      label: `目录下一页（第 ${pages} 页）`,
      rule: nextRule,
      values: next.values,
      elapsedMs: Date.now() - nextStartedAt,
      error: next.issues[0]?.message ?? null
    })
    issues.push(...next.issues)
    const candidate = next.values.map((value) => resolveHttpUrl(value, response.url)).find((url) => url !== null)
    current = candidate === undefined ? null : candidate
  }

  return { chapters, pages, truncated, issues }
}

/**
 * 目录第一条的字段取值单独记一笔。
 *
 * 「列表取到 20 个 `<li>`、但章节标题全空」是书源改版后的典型故障，
 * 面板上只记第 1 条就足以定位，不必把整页的字段都记一遍。
 */
async function traceChapterSample(
  trace: TraceSink,
  source: NetworkSource,
  block: string,
  ctx: RuleContext
): Promise<void> {
  for (const key of ['chapterName', 'chapterUrl'] as const) {
    const rule = source.toc[key]
    if (rule === undefined) continue
    const startedAt = Date.now()
    const result = await executeFirst(rule, block, ctx, CSS_DEFAULT)
    trace.rule({
      label: `第 1 条 · ${key}`,
      rule,
      values: result.value === '' ? [] : [result.value],
      elapsedMs: Date.now() - startedAt,
      error: result.issues[0]?.message ?? null
    })
  }
}

/** 取一个字段；空串当「没有」处理（与搜索侧同一口径） */
async function fieldOf(
  rule: string | undefined,
  subject: string,
  ctx: RuleContext,
  issues: RuleIssue[],
  parseOptions: ParseOptions
): Promise<string | null> {
  if (rule === undefined) return null
  const result = await executeFirst(rule, subject, ctx, parseOptions)
  issues.push(...result.issues)
  const value = result.value.trim()
  return value === '' ? null : value
}

/** 章节标题折叠空白：目录里 `第1章\n  风起` 这种换行会撑坏单行列表 */
function collapseTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------- 正文

export interface ChapterResult {
  html: string
  pages: number
  issues: RuleIssue[]
}

export async function fetchChapter(options: FetchOptions, chapterUrl: string): Promise<ChapterResult> {
  assertUsable(options.source)
  const source = options.source
  const contentRule = source.content['content']
  if (contentRule === undefined) {
    throw new NetworkFetchError('E_NO_RULE', '该源没有配置正文规则（ruleContent.content）')
  }

  const issues: RuleIssue[] = []
  const seenPages = new Set<string>()
  const blocks: string[] = []

  let current: string | null = chapterUrl
  let pages = 0
  while (current !== null) {
    if (pages >= MAX_CONTENT_PAGES) break
    if (seenPages.has(current)) break
    seenPages.add(current)

    const response = await fetchPage(options, current, `正文第 ${pages + 1} 页`)
    pages++
    const ctx = ruleContext(options, response.url)

    const contentStartedAt = Date.now()
    const content = await executeRuleText(contentRule, response.body, ctx, CSS_DEFAULT)
    options.trace?.rule({
      label: `正文（第 ${pages} 页）`,
      rule: contentRule,
      values: content.values,
      elapsedMs: Date.now() - contentStartedAt,
      error: content.issues[0]?.message ?? null
    })
    issues.push(...content.issues)
    if (content.values.length === 0) {
      if (content.issues.length > 0) throw new NetworkFetchError('E_RULE', content.issues[0].message)
      if (pages === 1) throw new NetworkFetchError('E_EMPTY_CONTENT', '正文页没有取到内容，书源规则可能已失效')
      break
    }
    blocks.push(toParagraphHtml(content.values.join('\n')))

    const nextRule = source.content['nextContentUrl']
    if (nextRule === undefined) break
    const nextStartedAt = Date.now()
    const next = await executeRuleText(nextRule, response.body, ctx, CSS_DEFAULT)
    options.trace?.rule({
      label: `正文下一页（第 ${pages} 页）`,
      rule: nextRule,
      values: next.values,
      elapsedMs: Date.now() - nextStartedAt,
      error: next.issues[0]?.message ?? null
    })
    issues.push(...next.issues)
    const candidate = next.values.map((value) => resolveHttpUrl(value, response.url)).find((url) => url !== null)
    current = candidate === undefined ? null : candidate
  }

  return { html: blocks.filter((block) => block !== '').join('\n'), pages, issues }
}

/** 丢掉这些标签连同内容：站点可控的脚本/外链不该进渲染层（文件头第 5 条） */
const DROP_TAGS = 'script,style,iframe,noscript,object,embed,form,input,button,select,textarea,link,meta,svg,img,video,audio,canvas'
/** 这些标签的结束处要断行，否则 `<p>a</p><p>b</p>` 会被抽成「ab」 */
const BLOCK_TAGS = 'p,div,section,article,li,ul,ol,tr,blockquote,pre,h1,h2,h3,h4,h5,h6'

/**
 * 正文原文（HTML 片段或纯文本）→ 段落 HTML。
 *
 * 统一抽成文本再包 `<p>`：站点正文里的 `<div><br></div>`、`&nbsp;` 缩进、
 * 行内广告 `<span>` 混在一起，保留原标签只会让阅读器排版崩坏（文件头第 4 条）。
 */
export function toParagraphHtml(raw: string): string {
  const text = raw.includes('<') ? extractLines(raw) : raw
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n')
}

function extractLines(html: string): string {
  const $ = load(html, null, false)
  $(DROP_TAGS).remove()
  $('br').replaceWith('\n')
  $(BLOCK_TAGS).each((_, el) => {
    $(el).append('\n')
  })
  return $.root().text()
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
