/**
 * M4-09 自检：阅读链路（详情 → 目录 → 正文 → 入库）。
 *
 * 全程离线：起一个 127.0.0.1 的本地服务器当「书源站点」，四类页面都由它提供
 * （详情、两页目录、两页正文），用临时 SQLite 库验证落库与刷新。
 *
 * 五块断言：
 *   1. 正文转段落（`toParagraphHtml`）—— 纯函数，最先跑
 *   2. 详情 / 目录 / 正文的字段提取与分页拼接
 *   3. 翻页去重：最后一页的「下一页」指回第一页时不能死循环
 *   4. 加入书架：新建 / 重复加入只刷目录 / 目录变长后刷新
 *   5. 失败路径：坏记录、缺正文规则、目录为空、书源被删
 *
 * 服务器必须 `ssrf: false` 才能连 127.0.0.1（业务层默认拒绝回环地址，
 * 由 `verify:http` 单独证明）；`minIntervalMs: 0` 关掉同站 1s 间隔，
 * 否则一次自检要跑一分钟。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase } from '../../db/connection'
import { SourcesRepository, type SourceRecord } from '../../db/repositories/sources'
import { createHttpClient, type HttpClient } from '../http/client'
import {
  NetworkFetchError,
  fetchBookInfo,
  fetchChapter,
  fetchToc,
  toNetworkSource,
  toParagraphHtml
} from './book'
import { addNetworkBook, clearNetworkCache, getNetworkChapterContent, refreshNetworkToc } from '../../network/service'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/**
 * 规则全部写成「真实书源的样子」：**不带 `@css:` 前缀**，目录字段只写取值后缀
 * （`text` / `href`）。这正是「阅读 3.0」的主流写法，也是 M4-09 第一版踩的坑——
 * 当时裸规则被当成正则，目录取出来 0 章。
 */
const DETAIL_RULES = {
  ruleBookInfo: {
    name: 'h1@text',
    author: '.author@text',
    intro: '#intro@text',
    tocUrl: 'a.toc@href'
  },
  ruleToc: {
    chapterList: '#list>li',
    chapterName: 'text',
    chapterUrl: 'a@href',
    nextTocUrl: 'a.next@href'
  },
  ruleContent: {
    content: '#content@html',
    nextContentUrl: 'a#next@href'
  }
}

export async function runBookSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 1. 正文转段落
  {
    const two = toParagraphHtml('<p>甲</p><p>乙</p>')
    check(
      '相邻块级元素被拆成两段（不会粘成「甲乙」）',
      (two.match(/<p>/g) ?? []).length === 2 && two.includes('甲') && two.includes('乙'),
      two
    )

    const br = toParagraphHtml('<div>第一行<br>第二行</div>')
    check('`<br>` 断行', (br.match(/<p>/g) ?? []).length === 2, br)

    const clean = toParagraphHtml('<div>正文<script>alert(1)</script><img src="x"></div>')
    check(
      'script / img 被整段丢掉',
      clean.includes('正文') && !clean.includes('alert') && !clean.includes('img'),
      clean
    )

    const escaped = toParagraphHtml('第一行\n\n第二行')
    check(
      '纯文本按行分段、空行丢弃',
      (escaped.match(/<p>/g) ?? []).length === 2 && escaped.includes('第一行') && escaped.includes('第二行'),
      escaped
    )

    const entity = toParagraphHtml('<p>甲 &lt; 乙</p>')
    check(
      'HTML 实体被还原后重新转义（不会注入标签）',
      entity.includes('&lt;') && !entity.includes('<乙'),
      entity
    )
  }

  // ---------------------------------------------------------------- 服务器
  const stats = { paths: [] as string[] }
  /** 目录章节总数：后半段会被改成 5，用来测「刷新目录」 */
  let totalChapters = 4
  const servers: Server[] = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    stats.paths.push(url.pathname + url.search)
    const send = (body: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }

    if (url.pathname === '/detail/1') {
      return send(`<html><body>
        <h1>三体</h1><span class="author">刘慈欣</span>
        <div id="intro">地球往事三部曲第一部。</div>
        <a class="toc" href="/toc/1">目录</a>
      </body></html>`)
    }

    if (url.pathname === '/toc/empty') {
      return send('<html><body><div id="list"></div></body></html>')
    }

    if (url.pathname === '/toc/1') {
      const page = Number(url.searchParams.get('p') ?? '1')
      const from = page === 1 ? 0 : 3
      const to = page === 1 ? Math.min(3, totalChapters) : totalChapters
      const rows = Array.from({ length: Math.max(0, to - from) }, (_, i) => {
        const idx = from + i + 1
        return `<li><a href="/c/${idx}">第${idx}章 标题${idx}</a></li>`
      }).join('')
      // 第二页的「下一页」故意指回第一页：真实站点在最后一页常这么写
      const next = page === 1 ? '<a class="next" href="/toc/1?p=2">下一页</a>' : '<a class="next" href="/toc/1">下一页</a>'
      return send(`<html><body><div id="list">${rows}</div>${next}</body></html>`)
    }

    if (url.pathname.startsWith('/c/')) {
      const page = Number(url.searchParams.get('p') ?? '1')
      if (page === 2) {
        return send('<html><body><div id="content"><p>第三段</p></div></body></html>')
      }
      return send(`<html><body>
        <div id="content"><p>第一段</p><p>第二段</p><script>alert(1)</script><img src="ad.png"></div>
        <a id="next" href="${url.pathname}?p=2">下一页</a>
      </body></html>`)
    }

    send('not found', 404)
  })

  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const http: HttpClient = createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 5_000 })

  const scratch = join(app.getPath('temp'), `ctext-book-smoke-${Date.now()}`)
  mkdirSync(scratch, { recursive: true })
  const { db } = openDatabase(join(scratch, 'book.db'))

  try {
    // ---------------------------------------------------------------- 2~3. 抓取层
    const repo = new SourcesRepository(db)
    /** 每个源要有独立的 `bookSourceUrl`：这是 UNIQUE 列，复用会让后一次 upsert 改掉前一个源 */
    let sourceSeq = 0
    const addSource = (name: string, rules: Record<string, unknown>): SourceRecord => {
      const url = `${base}/source-${++sourceSeq}`
      return repo.upsert({
        url,
        name,
        group: null,
        enabled: true,
        compatLevel: 'full',
        compatNote: null,
        ruleJson: JSON.stringify({ bookSourceUrl: url, bookSourceName: name, ...rules }),
        customOrder: 0,
        now: Date.now()
      }).record
    }

    const fullRecord = addSource('完整书源', DETAIL_RULES)
    const fullSource = toNetworkSource(fullRecord)
    check('完整书源归一后四段规则齐全', fullSource.broken === null && fullSource.info['name'] === 'h1@text')

    const broken = toNetworkSource({ ...fullRecord, ruleJson: '{不是 JSON' })
    check('坏记录被标出来而不是抛异常', broken.broken !== null, broken.broken ?? '')

    const detail = await fetchBookInfo(
      { http, source: fullSource, deadline: Date.now() + 20_000 },
      `${base}/detail/1`
    )
    check(
      '详情页字段提取正确',
      detail.info.title === '三体' &&
        detail.info.author === '刘慈欣' &&
        (detail.info.intro ?? '').includes('地球往事'),
      JSON.stringify(detail.info)
    )
    check('详情页的相对 tocUrl 被补全', detail.tocUrl === `${base}/toc/1`, detail.tocUrl)

    const toc = await fetchToc({ http, source: fullSource, deadline: Date.now() + 20_000 }, detail.tocUrl)
    check('两页目录拼成 4 章', toc.chapters.length === 4, `${toc.chapters.length}`)
    check('目录翻了 2 页', toc.pages === 2, `${toc.pages}`)
    check('章节标题与地址都取到', toc.chapters[0]?.title === '第1章 标题1' && toc.chapters[0]?.url === `${base}/c/1`)
    check(
      '「下一页」指回第一页时不死循环',
      toc.pages === 2 && toc.chapters.length === 4,
      `pages=${toc.pages} chapters=${toc.chapters.length}`
    )

    const chapter = await fetchChapter({ http, source: fullSource, deadline: Date.now() + 20_000 }, `${base}/c/1`)
    check('正文翻了两页并拼接', chapter.pages === 2 && chapter.html.includes('第一段') && chapter.html.includes('第三段'), `${chapter.pages} 页`)
    check('正文里的 script / img 被净化掉', !chapter.html.includes('alert') && !chapter.html.includes('img'), chapter.html.slice(0, 80))

    // ---------------------------------------------------------------- 4. 加入书架
    clearNetworkCache()
    const added = await addNetworkBook(db, { sourceId: fullRecord.id, bookUrl: `${base}/detail/1` }, { http })
    check('加入书架返回章节数', added.chapterCount === 4 && added.reused === false, JSON.stringify(added))
    check('书名取自详情页', added.title === '三体', added.title)

    const bookRow = db.prepare('SELECT source_type, source_url, format, chapter_count FROM books WHERE id = ?').get(added.bookId) as
      | { source_type: string; source_url: string; format: string; chapter_count: number }
      | undefined
    check(
      '书籍行标记为网络书并记录详情页',
      bookRow?.source_type === 'network' && bookRow.source_url === `${base}/detail/1` && bookRow.chapter_count === 4,
      JSON.stringify(bookRow)
    )

    const chapterRows = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(added.bookId) as { n: number }
    check('章节行按顺序落库', chapterRows.n === 4, `${chapterRows.n}`)

    const again = await addNetworkBook(db, { sourceId: fullRecord.id, bookUrl: `${base}/detail/1` }, { http })
    const bookCount = db.prepare(`SELECT COUNT(*) AS n FROM books WHERE source_type = 'network'`).get() as { n: number }
    check('重复加入不新建记录', again.reused === true && again.bookId === added.bookId && bookCount.n === 1, `count=${bookCount.n}`)

    // ---------------------------------------------------------------- 正文读取与缓存
    // 关掉预取：这一组断言数的是「读一章发几个请求」，预取会多打一次
    const NO_PREFETCH = { http, prefetch: false } as const
    const before = stats.paths.length
    const content = await getNetworkChapterContent(db, added.bookId, 0, NO_PREFETCH)
    check(
      '读第一章：内容正确、有下一章、没有上一章',
      content.html.includes('第一段') && content.hasNext && !content.hasPrev,
      `hasNext=${content.hasNext} hasPrev=${content.hasPrev}`
    )
    const fetched = stats.paths.length - before
    await getNetworkChapterContent(db, added.bookId, 0, NO_PREFETCH)
    check(
      '同一章再读一次走缓存（不再发请求）',
      stats.paths.length - before === fetched && fetched > 0,
      `requests=${fetched}`
    )

    // ---------------------------------------------------------------- 刷新目录
    totalChapters = 5
    const refreshed = await refreshNetworkToc(db, added.bookId, { http })
    const afterRow = db.prepare('SELECT chapter_count FROM books WHERE id = ?').get(added.bookId) as { chapter_count: number }
    check('刷新目录后章节数变 5', refreshed.total === 5 && afterRow.chapter_count === 5, `${refreshed.total}/${afterRow.chapter_count}`)

    const tail = db.prepare('SELECT title FROM chapters WHERE book_id = ? AND idx = 4').get(added.bookId) as
      | { title: string }
      | undefined
    check('新增的一章落在末尾', tail?.title === '第5章 标题5', tail?.title ?? '无')

    // ---------------------------------------------------------------- 5. 失败路径
    const noContentSource = toNetworkSource(addSource('缺正文规则', { ruleToc: DETAIL_RULES.ruleToc }))
    const noContent = await expectError(() =>
      fetchChapter({ http, source: noContentSource, deadline: Date.now() + 20_000 }, `${base}/c/1`)
    )
    check('缺正文规则时错误码是 E_NO_RULE', noContent.code === 'E_NO_RULE', `${noContent.code} ${noContent.message}`)

    const emptySource = toNetworkSource(addSource('空目录', DETAIL_RULES))
    const empty = await expectError(() =>
      fetchToc({ http, source: emptySource, deadline: Date.now() + 20_000 }, `${base}/toc/empty`)
    )
    check('目录页没有章节时报 E_EMPTY_TOC', empty.code === 'E_EMPTY_TOC', `${empty.code} ${empty.message}`)

    // 详情规则为空时不该发详情请求
    const noInfoRecord = addSource('无详情规则', { ruleToc: DETAIL_RULES.ruleToc, ruleContent: DETAIL_RULES.ruleContent })
    const detailHits = stats.paths.filter((path) => path.startsWith('/detail/')).length
    const withoutInfo = await addNetworkBook(
      db,
      { sourceId: noInfoRecord.id, bookUrl: `${base}/toc/1` },
      { http }
    )
    const detailHitsAfter = stats.paths.filter((path) => path.startsWith('/detail/')).length
    check(
      '没有详情规则时跳过详情请求，直接用详情页当目录页',
      withoutInfo.chapterCount === 5 && detailHitsAfter === detailHits,
      `hits=${detailHitsAfter - detailHits}`
    )

    repo.remove(fullRecord.id)
    const orphan = await expectError(() => getNetworkChapterContent(db, added.bookId, 0, NO_PREFETCH))
    check(
      '书源被删后取正文给出明确错误（不是崩溃）',
      orphan.code === 'E_NOT_FOUND' && orphan.message.includes('书源'),
      `${orphan.code} ${orphan.message}`
    )
  } catch (err) {
    check('阅读链路自检未抛异常', false, messageOf(err))
  } finally {
    await http.close()
    await Promise.all(servers.map((item) => new Promise<void>((resolve) => item.close(() => resolve()))))
    db.close()
    rmSync(scratch, { recursive: true, force: true })
  }

  return checks
}

async function expectError(task: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await task()
    return { code: 'NO_ERROR', message: '没有抛错' }
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err instanceof NetworkFetchError ? err.code : 'UNKNOWN')
    return { code, message: err instanceof Error ? err.message : String(err) }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
