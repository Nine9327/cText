/**
 * M3-04 书籍详情页自检。
 *
 * 分两段：
 *   A. 主进程直调——`library:update` 只改元信息（不碰 `updated_at`）、空串归 NULL、
 *      空标题不生效、FTS 索引跟着改（改完能搜到新词、搜不到旧词）。
 *   B. 渲染层真点击——元信息展示、章节虚拟滚动（300 章 DOM 有界）、章节筛选、
 *      行内编辑标题目录、分类勾选、书架勾选、书签跳转带 offset、回书库后列表同步。
 *
 * 只在 !app.isPackaged && CTEXT_DETAIL_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { getBookDetail, listBooks, updateBookMeta } from '../db/repositories/books'
import { listChapters } from '../db/repositories/books'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const FACT_CHAPTERS = 300

/** fixture 只有书目没有章节，详情页要的目录与书签在这里补上 */
function seedChaptersAndBookmarks(): void {
  const db = getDb()
  const insert = db.prepare('INSERT OR REPLACE INTO chapters (book_id, idx, title, level) VALUES (?, ?, ?, 0)')
  db.transaction(() => {
    for (let i = 0; i < FACT_CHAPTERS; i += 1) {
      insert.run('b08', i, `第${i + 1}章 文明的曙光${i + 1}`)
    }
  })()
  // 分类（详情页的分类勾选要用；fixture 本身没有分类）
  const category = db.prepare('INSERT OR REPLACE INTO categories (id, name, color, sort) VALUES (?, ?, ?, ?)')
  category.run('ct1', '科幻', '#5b8def', 0)
  category.run('ct2', '历史', '#d08b3e', 1)

  const now = Date.now()
  const bookmark = db.prepare(
    'INSERT INTO bookmarks (id, book_id, chapter_idx, offset, end_offset, kind, text, note, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)'
  )
  bookmark.run('bm1', 'b08', 2, 120, 148, 'highlight', '这是一段划线文本', null, now)
  bookmark.run('bm2', 'b08', 5, 40, null, 'bookmark', null, '记得回看这里', now)
}

function runRepoChecks(): Check[] {
  const db = getDb()
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  check('目录可整本取回', listChapters(db, 'b08').length === FACT_CHAPTERS, `${listChapters(db, 'b08').length} 章`)

  const before = getBookDetail(db, 'b08')
  const beforeUpdatedAt = db.prepare('SELECT updated_at FROM books WHERE id = ?').get('b08') as { updated_at: number }

  updateBookMeta(db, 'b08', { title: '银河英雄传说' })
  const after = getBookDetail(db, 'b08')
  const afterUpdatedAt = db.prepare('SELECT updated_at FROM books WHERE id = ?').get('b08') as { updated_at: number }
  check('改书名生效', after?.title === '银河英雄传说', after?.title ?? '(空)')
  check(
    '改元信息不碰 updated_at（章节缓存版本号）',
    beforeUpdatedAt.updated_at === afterUpdatedAt.updated_at,
    `${beforeUpdatedAt.updated_at} → ${afterUpdatedAt.updated_at}`
  )
  check(
    '改元信息不动进度与章数',
    after?.progress === before?.progress && after?.chapterCount === before?.chapterCount,
    `progress=${after?.progress} / 章 ${after?.chapterCount}`
  )

  // FTS 由触发器同步：新词能搜到、旧词搜不到（这是「列表与搜索同步更新」的证据）
  const hit = listBooks(db, { keyword: '银河', offset: 0, limit: 10 })
  const miss = listBooks(db, { keyword: '三体', offset: 0, limit: 10 })
  check(
    '改书名后全文检索同步（触发器）',
    hit.items.length === 1 && hit.items[0]?.id === 'b08' && miss.total === 0,
    `新词 ${hit.items.length} 本 / 旧词 ${miss.total} 本`
  )

  updateBookMeta(db, 'b08', { author: '  田中芳树  ', intro: '宇宙歌剧。', publisher: '' })
  const filled = getBookDetail(db, 'b08')
  check('作者去掉首尾空白', filled?.author === '田中芳树', filled?.author ?? '(空)')
  check('空字符串字段归 NULL', filled?.publisher === null, String(filled?.publisher))

  updateBookMeta(db, 'b08', { title: '   ' })
  check('空书名不生效（保持原值）', getBookDetail(db, 'b08')?.title === '银河英雄传说', getBookDetail(db, 'b08')?.title ?? '')

  check('书不存在时返回 false', updateBookMeta(db, 'not-a-book', { title: 'x' }) === false, 'false')

  return checks
}

export async function runDetailSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
  seedChaptersAndBookmarks()
  checks.push(...runRepoChecks())

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  const SCRIPT = String.raw`
    (async () => {
      const q = (s) => document.querySelector(s)
      const qa = (s) => Array.from(document.querySelectorAll(s))
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
      const waitFor = async (fn, timeout = 8000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await sleep(50)
        }
        return null
      }
      const out = { problems: [], text: {}, info: {} }

      try {
        // 从书库点「详情」按钮进详情页（不是直接改 hash，走真实入口）
        await waitFor(() => q('[data-book-grid] [data-book-detail]'), 15000)
        const card = q('[data-book-grid] [data-book-id="b08"]')
        card.closest('[data-fav-on]').querySelector('[data-book-detail]').click()
        await waitFor(() => location.hash.startsWith('#/book/b08'), 5000)
        await waitFor(() => q('[data-detail-name]'), 10000)

        out.text.title = txt(q('[data-detail-name]'))
        out.text.author = txt(q('[data-detail-author]'))
        out.text.chapterCount = txt(q('[data-detail-chapter-count]'))
        out.text.bookmarkCount = txt(q('[data-detail-bookmark-count]'))
        out.text.state = txt(q('[data-detail-state]'))

        // 章节虚拟滚动：300 章只能渲染十几行
        out.info.chapterRows = qa('[data-detail-chapter]').length
        out.info.chapterTotal = 300

        // 章节筛选
        const filter = q('[data-detail-chapter-filter]')
        filter.value = '第29'
        filter.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
        out.info.filteredRows = qa('[data-detail-chapter]').length
        out.text.filteredFirst = txt(q('[data-detail-chapter]'))
        filter.value = ''
        filter.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(120)

        // 行内编辑书名
        q('[data-detail-field="title"]').click()
        await waitFor(() => q('[data-detail-input="title"]'), 3000)
        const titleInput = q('[data-detail-input="title"]')
        titleInput.value = '银河英雄传说（修订版）'
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        titleInput.dispatchEvent(new Event('blur', { bubbles: true }))
        await waitFor(() => txt(q('[data-detail-name]')) === '银河英雄传说（修订版）', 6000)
        out.text.titleAfter = txt(q('[data-detail-name]'))

        // 行内编辑作者
        q('[data-detail-field="author"]').click()
        await waitFor(() => q('[data-detail-input="author"]'), 3000)
        const authorInput = q('[data-detail-input="author"]')
        authorInput.value = '田中芳树'
        authorInput.dispatchEvent(new Event('input', { bubbles: true }))
        authorInput.dispatchEvent(new Event('blur', { bubbles: true }))
        await waitFor(() => txt(q('[data-detail-author]')) === '田中芳树', 6000)
        out.text.authorAfter = txt(q('[data-detail-author]'))

        // 分类勾选
        q('[data-detail-categories]').click()
        await waitFor(() => q('[data-detail-category-dialog]'), 4000)
        q('[data-detail-category-toggle="ct1"]').click()
        q('[data-detail-category-ok]').click()
        const chip = await waitFor(() => q('[data-detail-category="ct1"]'), 6000)
        out.text.categoryChip = chip ? txt(chip) : ''

        // 书架勾选
        q('[data-detail-shelves]').click()
        await waitFor(() => q('[data-detail-shelf-toggle="s1"]'), 4000)
        const shelfBox = q('[data-detail-shelf-toggle="s1"]')
        shelfBox.checked = true
        shelfBox.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(600)

        // 书签跳转：URL 必须带 offset（否则只跳到章首）
        q('[data-detail-bookmark]').click()
        await waitFor(() => location.hash.includes('/reader/b08'), 5000)
        out.text.bookmarkRoute = location.hash

        // 回书库：列表里的书名已同步
        location.hash = '#/library'
        await waitFor(() => txt(q('[data-book-count]')) === '16 本', 8000)
        const back = await waitFor(() => q('[data-book-grid] [data-book-id="b08"]'), 8000)
        out.text.listTitle = back ? txt(back.closest('[data-fav-on]')) : 'missing'
      } catch (err) {
        out.problems.push(String((err && err.message) || err))
      }

      return JSON.stringify(out)
    })()
  `

  let raw: string
  try {
    raw = (await win.webContents.executeJavaScript(SCRIPT)) as string
  } catch (err) {
    check('渲染层脚本执行', false, err instanceof Error ? err.message : String(err))
    return finish(checks, win)
  }

  const out = JSON.parse(raw) as {
    problems: string[]
    info: Record<string, number>
    text: Record<string, string>
  }
  const info = out.info
  const text = out.text

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check('详情页显示书名', text['title'] === '银河英雄传说', text['title'] ?? '')
  check('详情页显示作者（仓储段的改动作效）', text['author'] === '田中芳树', text['author'] ?? '')
  check('详情页显示章数与书签数', text['chapterCount'] === '300 章' && text['bookmarkCount'] === '2 条', `${text['chapterCount']} / ${text['bookmarkCount']}`)
  check('详情页显示阅读状态', (text['state'] ?? '').length > 0, text['state'] ?? '')
  check(
    '章节列表虚拟滚动（300 章只渲染十几行）',
    info['chapterRows']! > 0 && info['chapterRows']! < 30,
    `DOM ${info['chapterRows']} 行 / 共 ${info['chapterTotal']} 章`
  )
  check('章节筛选只剩匹配项', info['filteredRows'] === 11, `DOM ${info['filteredRows']} 行 / 首行「${text['filteredFirst'] ?? ''}」`)
  check('行内编辑书名生效', text['titleAfter'] === '银河英雄传说（修订版）', text['titleAfter'] ?? '')
  check('行内编辑作者生效', text['authorAfter'] === '田中芳树', text['authorAfter'] ?? '')
  check('勾选分类后出现标签', (text['categoryChip'] ?? '').includes('科幻'), text['categoryChip'] ?? '')
  check(
    '书签跳转带章号与偏移',
    (text['bookmarkRoute'] ?? '').includes('chapter=2') && (text['bookmarkRoute'] ?? '').includes('offset=120'),
    text['bookmarkRoute'] ?? ''
  )
  check('回书库后列表书名已同步', (text['listTitle'] ?? '').includes('银河英雄传说（修订版）'), text['listTitle'] ?? '')

  // 落库校验
  const db = getDb()
  const stored = db.prepare('SELECT title, author FROM books WHERE id = ?').get('b08') as { title: string; author: string }
  check('书名已落库', stored.title === '银河英雄传说（修订版）', stored.title)
  const shelfRow = db.prepare('SELECT COUNT(*) AS n FROM shelf_books WHERE shelf_id = ? AND book_id = ?').get('s1', 'b08') as { n: number }
  check('书架勾选已落库', shelfRow.n === 1, `s1 里有 ${shelfRow.n} 条`)
  const tagRow = db.prepare('SELECT COUNT(*) AS n FROM book_categories WHERE book_id = ? AND category_id = ?').get('b08', 'ct1') as { n: number }
  check('分类勾选已落库', tagRow.n === 1, `ct1 关联 ${tagRow.n} 条`)

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE DETAIL ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE DETAIL SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
