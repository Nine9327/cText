/**
 * M4-12 合成书源基线（离线回归）。
 *
 * 计划里 M4-12 的验收是「100 条真实书源通过率 ≥85%」，但产品文档 §2.7 的红线是
 * **不内置、不分发任何书源**——真实样本不能进仓库。所以验收拆成两段：
 *
 *   1. 本文件：20 条自建合成源，覆盖 css / xpath / json / 正则 / JS 五类语法，
 *      以及索引、区间、`||` 降级、`##` 替换、分页、POST、请求头这些真实书源的高频写法。
 *      全部打在本地服务器上，不访问外网，作为**回归基线**（要求 100%）。
 *   2. `sample-report.ts`：用户自己导入的真实书源，数量与通过率只作为发布前自测报告，
 *      不进 CI、不进仓库。
 *
 * 一个刻意的设计：**每条源都要跑完搜索 → 详情 → 目录 → 正文四段**。只测搜索会漏掉
 * 「搜索能用但目录规则写错」这类最常见的坏源——而那恰好是用户点「加入书架」时才炸的。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SourceRecord } from '../../db/repositories/sources'
import { extractCss, splitIndexSuffix } from '../extractors/css'
import { createHttpClient } from '../http/client'
import { classifyFailure } from './classify'
import { fetchBookInfo, fetchChapter, fetchToc, toNetworkSource, type NetworkSource } from './book'
import { searchSources } from './search'
import { advanceBreaker, BREAKER_COOLDOWN_MS, breakerNote, isBreakerOpen, type BreakerState } from './breaker'

export interface CompatCheck {
  name: string
  ok: boolean
  detail: string
}

interface Spec {
  id: string
  name: string
  variant: 1 | 2 | 3 | 4 | 5
  /** 覆盖某一段的规则（键名沿用 Legado） */
  search?: Record<string, string>
  info?: Record<string, string>
  toc?: Record<string, string>
  content?: Record<string, string>
  searchUrl?: string
  expect: {
    searchCount?: number
    firstName?: string
    minToc?: number
    contentIncludes?: string
    author?: string
    firstChapter?: string
  }
}

const BOOKS: Array<[title: string, author: string, id: string]> = [
  ['三体', '刘慈欣', '1'],
  ['三体Ⅱ·黑暗森林', '刘慈欣', '2'],
  ['三体Ⅲ·死神永生', '刘慈欣', '3']
]

const CHAPTERS: Array<[title: string, id: string]> = [
  ['第一章 科学边界', '1'],
  ['第二章 台球', '2'],
  ['第三章 射手与农场主', '3'],
  ['第四章 三体问题', '4']
]

// ---------------------------------------------------------------- 本地站点

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 单台服务器按路径前缀分出 5 个「站点」，避免 5 个端口各自写一份路由 */
function route(pathname: string, query: URLSearchParams, method: string, body: string, headers: IncomingMessage['headers']): { type: string; body: string } | { status: number } {
  const m = /^\/v(\d)\/(.*)$/.exec(pathname)
  if (m === null) return { status: 404 }
  const variant = Number(m[1])
  const rest = m[2] as string

  if (variant === 1 || variant === 5) {
    if (rest === 's') {
      // v5 的搜索是 POST + 请求头鉴权：验证 `searchUrl` 的选项语法与 header 透传
      if (variant === 5) {
        if (method !== 'POST') return { status: 405 }
        if (headers['x-token'] !== 'ctext') return { status: 403 }
        if (!body.includes('q=')) return { status: 400 }
      }
      const items = BOOKS.map(
        ([title, author, id]) =>
          `<li><h3><a href="/v${variant}/book/${id}">${title}</a></h3><span class="author">${author}</span></li>`
      ).join('')
      return { type: 'text/html', body: page(`<div class="result-list">${items}</div>`) }
    }
    const bookMatch = /^book\/(\d+)$/.exec(rest)
    if (bookMatch !== null) {
      const title = BOOKS.find(([, , id]) => id === bookMatch[1])?.[0] ?? '三体'
      return {
        type: 'text/html',
        body: page(
          `<div class="book-info"><h1 class="book-name">${title}</h1><p class="author">刘慈欣</p>` +
            `<div class="intro">地球往事三部曲第一部</div></div>` +
            `<a class="read-btn" href="/v${variant}/toc/1">开始阅读</a>`
        )
      }
    }
    if (rest === 'toc/1') {
      if (variant === 5) {
        const dds = CHAPTERS.slice(0, 3)
          .map(([title, id]) => `<dd><a href="/v5/c/1/${id}">${title}</a></dd>`)
          .join('')
        return { type: 'text/html', body: page(`<dl class="chapter-list">${dds}</dl>`) }
      }
      const second = query.get('page') === '2'
      const list = second ? CHAPTERS.slice(2) : CHAPTERS.slice(0, 2)
      const dds = list.map(([title, id]) => `<dd><a href="/v1/c/1/${id}">${title}</a></dd>`).join('')
      const next = second ? '' : `<a class="next" href="/v1/toc/1?page=2">下一页</a>`
      return { type: 'text/html', body: page(`<dl class="chapter-list">${dds}</dl>${next}`) }
    }
    if (rest === 'c/1/1') {
      if (variant === 5) {
        const encoded = Buffer.from('<p>正文第一段：三体世界的日出。</p>', 'utf8').toString('base64')
        return { type: 'text/html', body: page(`<div id="b64">${encoded}</div>`) }
      }
      const second = query.get('page') === '2'
      const content = second
        ? '<p>续页第二段：质子展开。</p>'
        : '<p>正文第一段：三体世界的日出。</p>'
      const next = second ? '' : `<a id="next" href="/v1/c/1/1?page=2">下一页</a>`
      return { type: 'text/html', body: page(`<div id="content">${content}</div>${next}`) }
    }
    return { status: 404 }
  }

  if (variant === 2) {
    if (rest === 's') {
      const rows = BOOKS.map(
        ([title, author, id]) =>
          `<tr><td class="t"><a href="/v2/book/${id}">${title}</a></td><td class="a">${author}</td></tr>`
      ).join('')
      return { type: 'text/html', body: page(`<table id="list">${rows}</table>`) }
    }
    if (rest === 'book/1') {
      return {
        type: 'text/html',
        body: page(
          `<div id="info"><h1>三体</h1><span id="author">刘慈欣</span><p id="intro">地球往事三部曲第一部</p>` +
            `<a id="read" href="/v2/toc/1">阅读</a></div>`
        )
      }
    }
    if (rest === 'toc/1') {
      const lis = CHAPTERS.slice(0, 3)
        .map(([title, id]) => `<li><a href="/v2/c/1/${id}">${title}</a></li>`)
        .join('')
      return { type: 'text/html', body: page(`<ul id="toc">${lis}</ul>`) }
    }
    if (rest === 'c/1/1') {
      return {
        type: 'text/html',
        body: page('<div id="content"><p>正文第一段：三体世界的日出。</p><p>正文第二段：质子展开。</p></div>')
      }
    }
    return { status: 404 }
  }

  if (variant === 3) {
    if (rest === 'api/search') {
      return {
        type: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { list: BOOKS.map(([title, author, id]) => ({ title, author, url: `/v3/book/${id}` })) }
        })
      }
    }
    if (rest === 'book/1') {
      return {
        type: 'application/json',
        body: JSON.stringify({ data: { title: '三体', author: '刘慈欣', intro: '地球往事三部曲第一部', tocUrl: '/v3/toc/1' } })
      }
    }
    if (rest === 'toc/1') {
      return {
        type: 'application/json',
        body: JSON.stringify({
          data: { chapters: CHAPTERS.slice(0, 3).map(([title, id]) => ({ title, url: `/v3/c/1/${id}` })) }
        })
      }
    }
    if (rest === 'c/1/1') {
      return {
        type: 'application/json',
        body: JSON.stringify({ data: { content: '<p>正文第一段：三体世界的日出。</p>' } })
      }
    }
    return { status: 404 }
  }

  // v4：纯文本 + 正则
  if (rest === 's') {
    const lines = BOOKS.map(([title, author, id]) => `【${title}|${author}|/v4/book/${id}】`).join('')
    return { type: 'text/plain', body: lines }
  }
  if (rest === 'book/1') {
    return { type: 'text/plain', body: '书名：三体\n作者：刘慈欣\n简介：地球往事三部曲第一部\n目录：/v4/toc/1' }
  }
  if (rest === 'toc/1') {
    const lines = CHAPTERS.slice(0, 3)
      .map(([title, id]) => `【${title}|/v4/c/1/${id}】`)
      .join('')
    return { type: 'text/plain', body: lines }
  }
  if (rest === 'c/1/1') {
    return { type: 'text/plain', body: '正文开始\n正文第一段：三体世界的日出。\n正文第二段：质子展开。' }
  }
  return { status: 404 }
}

function startServer(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let body = ''
      if (req.method === 'POST') body = await readBody(req)
      const result = route(url.pathname, url.searchParams, req.method ?? 'GET', body, req.headers)
      if ('status' in result) {
        send(res, result.status, 'text/plain', `HTTP ${result.status}`)
        return
      }
      send(res, 200, result.type, result.body)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

// ---------------------------------------------------------------- 20 条合成源

const V1_RULES = {
  ruleSearch: { bookList: '.result-list>li', name: 'h3>a@text', author: '.author@text', bookUrl: 'h3>a@href' },
  ruleBookInfo: { name: '.book-name@text', author: '.author@text', intro: '.intro@text', tocUrl: '.read-btn@href' },
  ruleToc: { chapterList: '.chapter-list dd', chapterName: 'a@text', chapterUrl: 'a@href', nextTocUrl: '.next@href' },
  ruleContent: { content: '#content@html', nextContentUrl: '#next@href' }
}

const V2_RULES = {
  ruleSearch: {
    bookList: '//table[@id="list"]//tr',
    name: '//td[@class="t"]/a/text()',
    author: '//td[@class="a"]/text()',
    bookUrl: '//td[@class="t"]/a/@href'
  },
  ruleBookInfo: {
    name: '//h1/text()',
    author: '//span[@id="author"]/text()',
    intro: '//p[@id="intro"]/text()',
    tocUrl: '//a[@id="read"]/@href'
  },
  ruleToc: { chapterList: '//ul[@id="toc"]/li', chapterName: '//a/text()', chapterUrl: '//a/@href' },
  ruleContent: { content: '//div[@id="content"]' }
}

const V3_RULES = {
  ruleSearch: { bookList: '$.data.list[*]', name: '$.title', author: '$.author', bookUrl: '$.url' },
  ruleBookInfo: { name: '$.data.title', author: '$.data.author', intro: '$.data.intro', tocUrl: '$.data.tocUrl' },
  ruleToc: { chapterList: '$.data.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
  ruleContent: { content: '$.data.content' }
}

const V4_RULES = {
  ruleSearch: {
    bookList: ':【(.+?)】',
    name: ':^(.+?)\\|',
    author: ':\\|(.+?)\\|',
    bookUrl: ':\\|(/v4/book/\\d+)$'
  },
  ruleBookInfo: { name: ':书名：(.+)', author: ':作者：(.+)', intro: ':简介：(.+)', tocUrl: ':目录：(\\S+)' },
  ruleToc: { chapterList: ':【(.+?)】', chapterName: ':^(.+?)\\|', chapterUrl: ':\\|(/v4/c/1/\\d+)$' },
  ruleContent: { content: ':正文开始\\n([\\s\\S]+)' }
}

const V5_RULES = {
  ruleSearch: {
    bookList: '.result-list>li',
    name: "@js:const m = result.match(/>([^<]+)<\\/a>/); m ? m[1] : ''",
    author: "@js:const m = result.match(/class=\"author\">([^<]+)</); m ? m[1] : ''",
    bookUrl: 'h3>a@href'
  },
  ruleBookInfo: { name: '.book-name@text', author: '.author@text', tocUrl: '.read-btn@href' },
  ruleToc: {
    chapterList: '.chapter-list dd',
    chapterName: "a@text@js: result.replace(/\\s+/g, '')",
    chapterUrl: 'a@href'
  },
  ruleContent: { content: '#b64@text@js: java.base64Decode(result)' }
}

const SPECS: Spec[] = [
  // ---- v1 css
  { id: 'c1', name: '合成-CSS-标准', variant: 1, expect: { searchCount: 3, firstName: '三体', minToc: 4, contentIncludes: '续页第二段' } },
  {
    id: 'c2',
    name: '合成-CSS-降级',
    variant: 1,
    search: { name: '.no-such-node@text||h3>a@text', author: '.author@text##刘慈欣##刘慈欣（著）' },
    info: { author: '.author@text##刘慈欣##刘慈欣（著）' },
    expect: { searchCount: 3, firstName: '三体', author: '刘慈欣（著）', minToc: 4 }
  },
  {
    id: 'c3',
    name: '合成-CSS-索引',
    variant: 1,
    search: { bookList: '.result-list>li!1' },
    expect: { searchCount: 1, firstName: '三体Ⅱ·黑暗森林', minToc: 4 }
  },
  {
    id: 'c4',
    name: '合成-CSS-区间',
    variant: 1,
    search: { bookList: '.result-list>li[0:2]' },
    toc: { chapterList: '.chapter-list dd[0:1]' },
    expect: { searchCount: 2, minToc: 1 }
  },
  // ---- v2 xpath
  { id: 'x1', name: '合成-XPath-标准', variant: 2, expect: { searchCount: 3, firstName: '三体', minToc: 3, contentIncludes: '质子展开' } },
  {
    id: 'x2',
    name: '合成-XPath-降级',
    variant: 2,
    search: { author: '//td[@class="none"]/text()||//td[@class="a"]/text()' },
    expect: { searchCount: 3, author: '刘慈欣', minToc: 3 }
  },
  {
    id: 'x3',
    name: '合成-XPath-属性',
    variant: 2,
    toc: { chapterUrl: '//a/@href', chapterName: '//a/text()' },
    expect: { searchCount: 3, minToc: 3, firstChapter: '第一章 科学边界' }
  },
  {
    id: 'x4',
    name: '合成-XPath-文本轴',
    variant: 2,
    info: { name: '//h1//text()', author: '//span[@id="author"]//text()' },
    expect: { searchCount: 3, minToc: 3 }
  },
  // ---- v3 json
  { id: 'j1', name: '合成-JSON-标准', variant: 3, expect: { searchCount: 3, firstName: '三体', minToc: 3, contentIncludes: '三体世界' } },
  {
    id: 'j2',
    name: '合成-JSON-降级',
    variant: 3,
    search: { name: '$.name||$.title' },
    expect: { searchCount: 3, firstName: '三体', minToc: 3 }
  },
  {
    id: 'j3',
    name: '合成-JSON-切片',
    variant: 3,
    search: { bookList: '$.data.list[0:2]' },
    expect: { searchCount: 2, minToc: 3 }
  },
  {
    id: 'j4',
    name: '合成-JSON-详情缺字段',
    variant: 3,
    info: { name: '$.data.title', author: '$.data.author' },
    expect: { searchCount: 3, minToc: 3, contentIncludes: '三体世界' }
  },
  // ---- v4 regex
  { id: 'r1', name: '合成-正则-标准', variant: 4, expect: { searchCount: 3, firstName: '三体', minToc: 3, contentIncludes: '质子展开' } },
  {
    id: 'r2',
    name: '合成-正则-替换',
    variant: 4,
    info: { author: ':作者：(.+)##刘慈欣##刘慈欣（著）' },
    expect: { searchCount: 3, author: '刘慈欣（著）', minToc: 3 }
  },
  {
    id: 'r3',
    name: '合成-正则-降级',
    variant: 4,
    info: { name: ':标题：(.+)||:书名：(.+)' },
    expect: { searchCount: 3, firstName: '三体', minToc: 3 }
  },
  {
    id: 'r4',
    name: '合成-正则-正文多行',
    variant: 4,
    content: { content: ':正文开始\\n([\\s\\S]+)\\n' },
    expect: { searchCount: 3, minToc: 3, contentIncludes: '正文第一段' }
  },
  // ---- v5 js
  { id: 's1', name: '合成-JS-字段', variant: 5, expect: { searchCount: 3, firstName: '三体', minToc: 3 } },
  {
    id: 's2',
    name: '合成-JS-POST鉴权',
    variant: 5,
    searchUrl: '/v5/s,{"method":"POST","body":"q={{key}}&page={{page}}&from=compat","headers":{"X-Token":"ctext"}}',
    expect: { searchCount: 3, firstName: '三体', minToc: 3 }
  },
  {
    id: 's3',
    name: '合成-JS-正文解码',
    variant: 5,
    content: { content: '#b64@text@js: java.base64Decode(result)' },
    expect: { searchCount: 3, minToc: 3, contentIncludes: '三体世界' }
  },
  {
    id: 's4',
    name: '合成-JS-目录清洗',
    variant: 5,
    expect: { searchCount: 3, minToc: 3, firstChapter: '第一章科学边界' }
  }
]

function baseRules(variant: Spec['variant']): {
  ruleSearch: Record<string, string>
  ruleBookInfo: Record<string, string>
  ruleToc: Record<string, string>
  ruleContent: Record<string, string>
} {
  if (variant === 2) return V2_RULES
  if (variant === 3) return V3_RULES
  if (variant === 4) return V4_RULES
  if (variant === 5) return V5_RULES
  return V1_RULES
}

/** v3 是 JSON API，v4 是纯文本，v5 必须 POST——三种地址形态本身就是被回归的语法 */
function defaultSearchUrl(variant: Spec['variant']): string {
  if (variant === 3) return '/v3/api/search?q={{key}}&page={{page}}'
  if (variant === 4) return '/v4/s?q={{key}}'
  if (variant === 5) {
    return '/v5/s,{"method":"POST","body":"q={{key}}&page={{page}}","headers":{"X-Token":"ctext"}}'
  }
  return `/v${variant}/s?q={{key}}&page={{page}}`
}

function makeRecord(spec: Spec, base: string): SourceRecord {
  const rules = baseRules(spec.variant)
  const raw = {
    bookSourceName: spec.name,
    bookSourceUrl: base,
    bookSourceType: 0,
    enabled: true,
    searchUrl: spec.searchUrl ?? defaultSearchUrl(spec.variant),
    ruleSearch: { ...rules.ruleSearch, ...spec.search },
    ruleBookInfo: { ...rules.ruleBookInfo, ...spec.info },
    ruleToc: { ...rules.ruleToc, ...spec.toc },
    ruleContent: { ...rules.ruleContent, ...spec.content }
  }
  return {
    id: `compat-${spec.id}`,
    url: base,
    name: spec.name,
    group: null,
    enabled: true,
    customOrder: 0,
    compatLevel: 'full',
    compatNote: null,
    ruleJson: JSON.stringify(raw),
    lastUsedAt: null,
    createdAt: 0,
    failStreak: 0,
    breakerUntil: null,
    lastFailure: null
  }
}

/** 抓取异常 → 归类标签；报告里带上类别，修复时才知道该看哪一层 */
function describe(err: unknown): string {
  const detail = err as { code?: string; message?: string }
  const cls = classifyFailure({ code: detail.code ?? null, message: detail.message ?? String(err) })
  return `${cls.label}：${detail.message ?? String(err)}`
}

// ---------------------------------------------------------------- 断言

export async function runCompatSmoke(): Promise<CompatCheck[]> {
  const checks: CompatCheck[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------- 1. 失败归类（纯函数）
  const timeout = classifyFailure({ code: 'E_TIMEOUT' })
  check('归类：超时可重试且不归为规则错误', timeout.kind === 'timeout' && timeout.retriable)
  check('归类：403 提示防盗链', classifyFailure({ code: 'E_HTTP', status: 403 }).hint.includes('UA'))
  check('归类：ENOTFOUND 归网络', classifyFailure({ code: 'ENOTFOUND', message: 'getaddrinfo' }).kind === 'network')
  check('归类：选择器无效归规则', classifyFailure({ message: '选择器无效：unexpected token' }).kind === 'rule')
  check('归类：空目录归「取不到内容」', classifyFailure({ code: 'E_EMPTY_TOC' }).kind === 'empty')
  check('归类：熔断单独一类', classifyFailure({ code: 'E_BREAKER' }).kind === 'breaker')

  // ---------- 2. 熔断状态机（纯函数，拨表推进）
  const t0 = 1_700_000_000_000
  let state: BreakerState = { streak: 0, until: null, lastFailure: null }
  state = advanceBreaker(state, { ok: false, code: 'E_TIMEOUT', message: '请求超时' }, t0)
  check('熔断：第 1 次超时不触发', state.streak === 1 && state.until === null)
  state = advanceBreaker(state, { ok: false, code: 'E_HTTP', message: '站点返回 HTTP 404' }, t0 + 1)
  check('熔断：非超时失败清零连击', state.streak === 0 && state.until === null)
  state = advanceBreaker(state, { ok: false, code: 'E_TIMEOUT' }, t0 + 2)
  state = advanceBreaker(state, { ok: false, code: 'E_TIMEOUT' }, t0 + 3)
  state = advanceBreaker(state, { ok: false, code: 'E_TIMEOUT' }, t0 + 4)
  check('熔断：连续 3 次超时开启冷却', state.streak === 3 && state.until === t0 + 4 + BREAKER_COOLDOWN_MS)
  check('熔断：冷却中判定为开', isBreakerOpen(state, t0 + 5) && breakerNote(state, t0 + 5) !== null)
  check('熔断：冷却结束自动放行', !isBreakerOpen(state, (state.until as number) + 1))
  state = advanceBreaker(state, { ok: true }, t0 + 6)
  check('熔断：成功后清空全部状态', state.streak === 0 && state.until === null && state.lastFailure === null)

  // ---------- 3. CSS 索引与区间（M4-12 新语义）
  const suffix = splitIndexSuffix('.list>li[1:3]')
  check('索引：区间后缀被正确切出', suffix.selector === '.list>li' && suffix.range?.start === 1 && suffix.range?.end === 3)
  check('索引：属性选择器不被误认成区间', splitIndexSuffix('a[data-id]').range === null)
  const list = '<ul><li>a</li><li>b</li><li>c</li></ul>'
  check('索引：!0 取第一个', extractCss(list, 'li!0', 'text').values[0] === 'a')
  check('索引：!-1 取最后一个', extractCss(list, 'li!-1', 'text').values[0] === 'c')
  check('索引：[1:] 取后两个', extractCss(list, 'li[1:]', 'text').values.join(',') === 'b,c')
  check('索引：越界返回空而不是报错', extractCss(list, 'li!5', 'text').values.length === 0)

  // ---------- 4. 20 条合成源 × 四段链路
  const { server, base } = await startServer()
  const http = createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 8_000 })
  try {
    for (const spec of SPECS) {
      const record = makeRecord(spec, base)
      const source: NetworkSource = toNetworkSource(record)
      const prefix = `${spec.id} ${spec.name}`
      let bookUrl: string | null = null

      try {
        const result = await searchSources([record], '三体', {}, http)
        const group = result.groups[0]
        if (group === undefined) {
          const failure = result.failures[0]
          check(`${prefix} · 搜索`, false, describe(failure ?? { message: '没有返回任何分组' }))
          continue
        }
        const items = group.items
        const countOk = spec.expect.searchCount === undefined || items.length === spec.expect.searchCount
        const firstOk = spec.expect.firstName === undefined || items[0]?.title === spec.expect.firstName
        bookUrl = items[0]?.bookUrl ?? null
        check(
          `${prefix} · 搜索`,
          countOk && firstOk && bookUrl !== null,
          `${items.length} 条${items[0] ? `，首条「${items[0].title}」` : ''}`
        )
      } catch (err) {
        check(`${prefix} · 搜索`, false, describe(err))
        continue
      }

      const deadline = Date.now() + 10_000
      const options = { http, source, deadline }
      let tocUrl: string
      try {
        const info = await fetchBookInfo(options, bookUrl as string)
        const titleOk = info.info.title !== null
        const authorOk = spec.expect.author === undefined || info.info.author === spec.expect.author
        check(`${prefix} · 详情`, titleOk && authorOk, `书名「${info.info.title ?? ''}」作者「${info.info.author ?? ''}」`)
        tocUrl = info.tocUrl
      } catch (err) {
        check(`${prefix} · 详情`, false, describe(err))
        continue
      }

      let chapterUrl: string | null = null
      try {
        const toc = await fetchToc({ http, source, deadline: Date.now() + 10_000 }, tocUrl)
        const countOk = toc.chapters.length >= (spec.expect.minToc ?? 1)
        const firstOk = spec.expect.firstChapter === undefined || toc.chapters[0]?.title === spec.expect.firstChapter
        chapterUrl = toc.chapters[0]?.url ?? null
        check(
          `${prefix} · 目录`,
          countOk && firstOk && chapterUrl !== null,
          `${toc.chapters.length} 章 / ${toc.pages} 页${toc.chapters[0] ? `，首章「${toc.chapters[0].title}」` : ''}`
        )
      } catch (err) {
        check(`${prefix} · 目录`, false, describe(err))
        continue
      }

      try {
        const content = await fetchChapter({ http, source, deadline: Date.now() + 10_000 }, chapterUrl as string)
        const textOk = content.html.includes('正文')
        const expectOk = spec.expect.contentIncludes === undefined || content.html.includes(spec.expect.contentIncludes)
        check(`${prefix} · 正文`, textOk && expectOk, `${content.pages} 页 / ${content.html.length} 字符`)
      } catch (err) {
        check(`${prefix} · 正文`, false, describe(err))
      }
    }
  } finally {
    await http.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return checks
}
