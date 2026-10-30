/**
 * M4-09 界面自检：网络搜索 → 加入书架 → 详情页刷新目录。
 *
 * `engine/source/book-smoke.ts` 覆盖「抓到的数据对不对」，这里覆盖「**接线对不对**」：
 * `source:addBook` / `source:refreshToc` 的通道名、zod schema、preload 白名单、
 * 搜索面板与详情页的 DOM 行为，任何一层写错纯函数测试都发现不了。
 *
 * 本地起一个 127.0.0.1 的假站点当书源；主进程读环境变量
 * `CTEXT_HTTP_ALLOW_LOCAL=1` 放行回环地址（只在自检里设）。
 *
 * 只在 `!app.isPackaged && CTEXT_SOURCE_BOOK_UI_SMOKE=1` 时执行。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { sourcesRepo } from '../db/repositories/sources'
import { importSources } from '../engine/source/import'
import { getChapterContent } from '../reader/content'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runBookUiSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 假站点
  let totalChapters = 4
  const servers: Server[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (body: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }

    if (url.pathname === '/search') {
      return send(`<html><body><ul id="result">
        <li><h3><a href="/detail/1">三体</a></h3><span class="author">刘慈欣</span>
        <p class="intro">地球往事三部曲第一部。</p></li>
      </ul></body></html>`)
    }
    if (url.pathname === '/detail/1') {
      return send(`<html><body><h1>三体</h1><span class="author">刘慈欣</span>
        <div id="intro">地球往事三部曲第一部。</div><a class="toc" href="/toc/1">目录</a></body></html>`)
    }
    if (url.pathname === '/toc/1') {
      const page = Number(url.searchParams.get('p') ?? '1')
      const from = page === 1 ? 0 : 3
      const to = page === 1 ? Math.min(3, totalChapters) : totalChapters
      const rows = Array.from({ length: Math.max(0, to - from) }, (_, i) => {
        const idx = from + i + 1
        return `<li><a href="/c/${idx}">第${idx}章 标题${idx}</a></li>`
      }).join('')
      const next = page === 1 ? '<a class="next" href="/toc/1?p=2">下一页</a>' : ''
      return send(`<html><body><div id="list">${rows}</div>${next}</body></html>`)
    }
    if (url.pathname.startsWith('/c/')) {
      return send('<html><body><div id="content"><p>第一段</p><p>第二段</p></div></body></html>')
    }
    send('<html><body>not found</body></html>')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    // ---------------------------------------------------------------- seed
    const repo = sourcesRepo(getDb())
    check('起始状态没有书源', repo.count() === 0, `count=${repo.count()}`)

    const seeded = await importSources(
      {
        kind: 'text',
        text: JSON.stringify([
          {
            bookSourceUrl: base,
            bookSourceName: '界面书源',
            searchUrl: '/search?q={{key}}',
            ruleSearch: {
              bookList: '#result>li',
              name: 'h3@text',
              author: '.author@text',
              bookUrl: 'h3>a@href'
            },
            ruleBookInfo: { name: 'h1@text', author: '.author@text', intro: '#intro@text', tocUrl: 'a.toc@href' },
            ruleToc: { chapterList: '#list>li', chapterName: 'text', chapterUrl: 'a@href', nextTocUrl: 'a.next@href' },
            ruleContent: { content: '#content@html' }
          }
        ])
      },
      { repo, now: Date.now }
    )
    check('seed 一条书源', seeded.imported === 1, JSON.stringify(seeded))

    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) return resolve()
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', () => resolve())
    })

    // ---------------------------------------------------------------- 搜索 → 加入书架
    const first = await win.webContents.executeJavaScript(String.raw`
      (async () => {
        const q = (s) => document.querySelector(s)
        const qa = (s) => Array.from(document.querySelectorAll(s))
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
        const waitFor = async (fn, timeout = 20000) => {
          const end = Date.now() + timeout
          while (Date.now() < end) {
            const v = fn()
            if (v) return v
            await sleep(100)
          }
          return null
        }
        const out = { problems: [], text: {}, info: {} }

        location.hash = '#/sources'
        const input = await waitFor(() => q('[data-source-search-input]'), 15000)
        if (!input) { out.problems.push('搜索输入框未渲染'); return out }
        input.value = '三体'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        // 等 Vue 把 keyword 渲染到 disabled 上：按钮在关键词为空时是禁用态，
        // 同一 tick 里点它会被浏览器直接忽略
        await sleep(80)
        q('[data-source-search-submit]').click()

        const item = await waitFor(() => q('[data-source-search-item]'))
        if (!item) {
          out.problems.push('搜索结果未渲染')
          out.text.summary = txt(q('[data-source-search-summary]'))
          out.text.error = txt(q('[data-source-search-error]'))
          out.text.loading = txt(q('[data-source-search-loading]'))
          out.text.empty = txt(q('[data-source-search-empty]'))
          out.text.failures = txt(q('[data-source-search-failures]'))
          out.text.body = txt(q('[data-source-search-input]')?.closest('div')?.parentElement)
          return out
        }
        out.info.groups = qa('[data-source-search-group]').length
        out.text.title = txt(q('[data-source-search-title]'))
        out.text.summary = txt(q('[data-source-search-summary]'))

        q('[data-source-search-add]').click()
        const openBtn = await waitFor(() => q('[data-source-search-open]'), 30000)
        if (!openBtn) { out.problems.push('加入书架后按钮未变成「已在书架」'); return out }
        out.text.added = txt(openBtn)
        openBtn.click()

        const nameEl = await waitFor(() => q('[data-detail-source-name]'), 15000)
        if (!nameEl) { out.problems.push('详情页没有进入或来源区块未渲染'); return out }
        out.text.sourceName = txt(nameEl)
        out.text.bookTitle = txt(q('[data-detail-name]'))
        out.text.chapterCount = txt(q('[data-detail-chapter-count]'))
        out.info.chapterRows = qa('[data-detail-chapter]').length
        out.info.hasRefresh = Boolean(q('[data-detail-refresh-toc]'))
        out.info.hasRematch = Boolean(q('[data-detail-rematch]'))
        return out
      })()
    `)

    check(
      '搜索面板点了就出结果',
      (first?.problems ?? ['没有返回结果']).length === 0,
      [
        first?.problems?.join(' / '),
        first?.text?.error,
        first?.text?.loading,
        first?.text?.summary,
        first?.text?.empty,
        first?.text?.failures,
        first?.text?.body
      ]
        .filter(Boolean)
        .join(' | ')
    )
    check('结果按书源分组', first?.info?.groups === 1, `${first?.info?.groups}`)
    check('结果行显示书名', first?.text?.title === '三体', first?.text?.title ?? '')
    check('汇总行给出条数与耗时', /共 1 条/.test(first?.text?.summary ?? ''), first?.text?.summary ?? '')
    check('加入书架后按钮变成「已在书架」', (first?.text?.added ?? '').includes('已在书架'), first?.text?.added ?? '')
    check('详情页书名来自详情规则', first?.text?.bookTitle === '三体', first?.text?.bookTitle ?? '')
    check('来源区块显示书源名', first?.text?.sourceName === '界面书源', first?.text?.sourceName ?? '')
    check('详情页章节目录已落库', first?.info?.chapterRows === 4, `${first?.info?.chapterRows}`)
    check('网络书用「刷新目录」而不是「重新识别」', first?.info?.hasRefresh === true && first?.info?.hasRematch === false)

    // ---------------------------------------------------------------- 主进程侧：落库 + 正文
    const db = getDb()
    const book = db
      .prepare(`SELECT id, chapter_count FROM books WHERE source_type = 'network'`)
      .get() as { id: string; chapter_count: number } | undefined
    check('库里有一条网络书', book !== undefined && book.chapter_count === 4, JSON.stringify(book))

    const content = book ? await getChapterContent(db, book.id, 0) : null
    check(
      '阅读器链路能读到网络章节',
      content !== null && content.html.includes('第一段') && content.hasNext,
      content === null ? '无内容' : content.html.slice(0, 40)
    )

    // ---------------------------------------------------------------- 刷新目录
    totalChapters = 5
    const second = await win.webContents.executeJavaScript(String.raw`
      (async () => {
        const q = (s) => document.querySelector(s)
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
        const waitFor = async (fn, timeout = 30000) => {
          const end = Date.now() + timeout
          while (Date.now() < end) {
            const v = fn()
            if (v) return v
            await sleep(100)
          }
          return null
        }
        const out = { problems: [], text: {} }
        const before = txt(q('[data-detail-chapter-count]'))
        q('[data-detail-refresh-toc]').click()
        const after = await waitFor(() => {
          const value = txt(q('[data-detail-chapter-count]'))
          return value && value !== before ? value : null
        })
        out.text.before = before
        out.text.after = after ?? txt(q('[data-detail-chapter-count]'))
        if (!after) out.problems.push('刷新目录后章节数没有变化')
        return out
      })()
    `)

    check(
      '刷新目录后详情页章节数变 5',
      (second?.problems ?? ['x']).length === 0 && (second?.text?.after ?? '').includes('5 章'),
      `${second?.text?.before ?? '?'} → ${second?.text?.after ?? '?'}`
    )

    const afterCount = db
      .prepare(`SELECT chapter_count FROM books WHERE source_type = 'network'`)
      .get() as { chapter_count: number } | undefined
    check('刷新目录写回了库', afterCount?.chapter_count === 5, `${afterCount?.chapter_count}`)

    // ---------------------------------------------------------------- 缓存卡片（M4-10）
    // 这一步之前主进程已经读过一章，盘上一定有缓存文件；预取可能再多一个文件，
    // 所以只断言「卡片渲染 + 文案里有保留天数」，不锁死章数
    const third = await win.webContents.executeJavaScript(String.raw`
      (async () => {
        const q = (s) => document.querySelector(s)
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
        const waitFor = async (fn, timeout = 15000) => {
          const end = Date.now() + timeout
          while (Date.now() < end) {
            const v = fn()
            if (v) return v
            await sleep(100)
          }
          return null
        }
        location.hash = '#/sources'
        const card = await waitFor(() => q('[data-source-cache]'))
        if (!card) return { card: false }
        return {
          card: true,
          summary: txt(q('[data-source-cache-size]')),
          hasClear: Boolean(q('[data-source-cache-clear]')),
          hasOpen: Boolean(q('[data-source-cache-open]'))
        }
      })()
    `)

    check(
      '书源页显示正文缓存卡片（用量 / 打开目录 / 清理）',
      third?.card === true && third?.hasClear === true && third?.hasOpen === true,
      JSON.stringify(third)
    )
    check(
      '缓存卡片给出体积、章节数与保留天数',
      /保留 \d+ 天/.test(third?.summary ?? ''),
      third?.summary ?? ''
    )

    // ---------------------------------------------------------------- 规则调试（M4-11）
    // 验收口径里有一条「面板无写库入口」，所以除了看界面，还要比对调试前后的表行数
    const beforeDebug = db
      .prepare(`SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM chapters) AS chapters`)
      .get() as { books: number; chapters: number }
    const sourceId = repo.list()[0]?.id ?? ''

    const fourth = await win.webContents.executeJavaScript(String.raw`
      (async () => {
        const q = (s) => document.querySelector(s)
        const qa = (s) => Array.from(document.querySelectorAll(s))
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
        const waitFor = async (fn, timeout = 30000) => {
          const end = Date.now() + timeout
          while (Date.now() < end) {
            const v = fn()
            if (v) return v
            await sleep(100)
          }
          return null
        }
        const out = { problems: [], text: {}, info: {} }

        location.hash = '#/sources/' + ${JSON.stringify(sourceId)}
        const open = await waitFor(() => q('[data-source-debug-open]'), 15000)
        if (!open) { out.problems.push('书源详情页没有「规则调试」入口'); return out }
        open.click()

        const urlInput = await waitFor(() => q('[data-source-debug-url]'))
        if (!urlInput) { out.problems.push('调试面板未渲染'); return out }
        urlInput.value = ${JSON.stringify(`${base}/detail/1`)}
        urlInput.dispatchEvent(new Event('input', { bubbles: true }))
        const kw = q('[data-source-debug-keyword]')
        kw.value = '三体'
        kw.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(80)
        q('[data-source-debug-submit]').click()

        const sections = await waitFor(() => {
          const list = qa('[data-source-debug-section]')
          return list.length > 0 ? list : null
        })
        if (!sections) {
          out.problems.push('调试没有返回结果')
          out.text.error = txt(q('[data-source-debug-error]'))
          out.text.running = txt(q('[data-source-debug-running]'))
          return out
        }
        out.info.sections = sections.length
        out.text.summary = txt(q('[data-source-debug-summary]'))
        out.text.heads = qa('[data-source-debug-section-head]').map((el) => txt(el)).join(' || ')

        // 成功的段默认收起（面板 90% 的用途是查失败段），展开「详情」看步骤
        const heads = qa('[data-source-debug-section-head]')
        heads[1]?.click()
        const steps = await waitFor(() => {
          const list = qa('[data-source-debug-step]')
          return list.length > 0 ? list : null
        }, 5000)
        out.info.steps = steps ? steps.length : 0
        out.text.firstStep = steps ? txt(steps[0]) : ''
        out.info.hasCopy = Boolean(q('[data-source-debug-copy]'))
        return out
      })()
    `)

    check(
      '书源详情页的「规则调试」能跑完四段',
      (fourth?.problems ?? ['没有返回结果']).length === 0 && fourth?.info?.sections === 4,
      [fourth?.problems?.join(' / '), fourth?.text?.error, fourth?.text?.running, fourth?.text?.summary]
        .filter(Boolean)
        .join(' | ')
    )
    check(
      '调试结果逐段给出结论',
      (fourth?.text?.heads ?? '').includes('详情') && (fourth?.text?.heads ?? '').includes('三体 · 刘慈欣'),
      fourth?.text?.heads ?? ''
    )
    check(
      '展开后逐条给出「请求 + 各字段规则」的步骤',
      (fourth?.info?.steps ?? 0) >= 5 && (fourth?.text?.firstStep ?? '').includes('详情页'),
      `${fourth?.info?.steps ?? 0} 步 · 首步「${fourth?.text?.firstStep ?? ''}」`
    )
    check('结果段可复制', fourth?.info?.hasCopy === true)

    const afterDebug = db
      .prepare(`SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM chapters) AS chapters`)
      .get() as { books: number; chapters: number }
    check(
      '调试不改数据库（书架与目录行数不变）',
      afterDebug.books === beforeDebug.books && afterDebug.chapters === beforeDebug.chapters,
      `${JSON.stringify(beforeDebug)} → ${JSON.stringify(afterDebug)}`
    )
  } catch (err) {
    check('阅读链路界面自检未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    await sleep(50)
    await Promise.all(servers.map((item) => new Promise<void>((resolve) => item.close(() => resolve()))))
  }

  return checks
}
