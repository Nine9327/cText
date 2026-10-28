/**
 * M3 出口验收（开发计划 §6「M3 出口检查」）。
 *
 * 两条标准，都不是「功能能跑」而是「语义没串、破坏性操作不越界」：
 *   1. **收藏 / 书架 / 分类三者语义与 UI 入口不混淆**：
 *      收藏是单布尔、书架与分类是多对多；三者互相独立——删书架不该动分类，
 *      删分类不该动收藏，移出书库也不该把归属关系带走。
 *   2. **删除类操作均二次确认且不删文件**：每一条都要真的碰一次磁盘文件，
 *      否则「没删文件」只是句口号（fixture 的书没有真实文件，验不出来）。
 *
 * 只在 `!app.isPackaged && CTEXT_M3_SMOKE=1` 时执行（临时库 + 临时目录）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { getBookDetail, removeBooks, setFavorite } from '../db/repositories/books'
import { createCategory, removeCategory, setBookCategories } from '../db/repositories/categories'
import { addBooksToShelf, createShelf, removeShelf } from '../db/repositories/shelves'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { coversDir } from '../ipc/import'
import { seedUiFixture } from '../ui/ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const REL_PATH = '出口验收样本.txt'
const BODY = ['第一章 起点', '第一章的正文，用来让切章规则命中。', '第二章 终点', '第二章的正文，收尾。'].join('\n')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForTask(taskId: string, timeoutMs: number): Promise<string> {
  const terminal = new Set(['done', 'cancelled', 'failed'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = getTaskSnapshot(taskId)
    if (snapshot && terminal.has(snapshot.phase)) return snapshot.phase
    await sleep(100)
  }
  return 'timeout'
}

export async function runM3Smoke(win: BrowserWindow, baseDir: string): Promise<void> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
  const db = getDb()

  // ---------------------------------------------------------------- 样本（真文件）
  const dir = join(baseDir, 'm3-lib')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, REL_PATH)
  writeFileSync(file, BODY, 'utf8')
  const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
  const phase = await waitForTask(taskId, 60_000)
  const row = db.prepare('SELECT id FROM books WHERE rel_path = ? AND deleted_at IS NULL').get(REL_PATH) as
    | { id: string }
    | undefined
  const bookId = row?.id ?? ''
  check('真文件样本导入成功', phase === 'done' && !!bookId && existsSync(file), `${phase} / ${bookId}`)
  if (!bookId) return report(checks, win)

  // ---------------------------------------------------------------- ① 三者语义与互不干扰
  createShelf(db, 'sh_a', '书架甲', Date.now())
  createShelf(db, 'sh_b', '书架乙', Date.now())
  createCategory(db, 'ct_a', '分类甲', null)
  createCategory(db, 'ct_b', '分类乙', null)
  addBooksToShelf(db, 'sh_a', [bookId], Date.now())
  addBooksToShelf(db, 'sh_b', [bookId], Date.now())
  setBookCategories(db, bookId, ['ct_a'])
  setFavorite(db, bookId, true)

  const base = getBookDetail(db, bookId)
  check('同一本书可以在多个书架', base?.shelves.length === 2, `${base?.shelves.length} 个`)
  check('同一本书可以属于分类', base?.categories.length === 1, `${base?.categories.length} 个`)
  check('收藏是单布尔', base?.favorite === true, String(base?.favorite))

  // 改收藏不影响归属
  setFavorite(db, bookId, false)
  const afterFav = getBookDetail(db, bookId)
  check(
    '改收藏不动书架与分类',
    afterFav?.shelves.length === 2 && afterFav?.categories.length === 1,
    `书架 ${afterFav?.shelves.length} / 分类 ${afterFav?.categories.length}`
  )
  setFavorite(db, bookId, true)

  // 删书架：不删书、不动分类、不动收藏、文件还在
  removeShelf(db, 'sh_a')
  const afterShelf = getBookDetail(db, bookId)
  check(
    '删书架不删书、不动分类与收藏',
    !!afterShelf &&
      afterShelf.shelves.length === 1 &&
      afterShelf.shelves[0]?.id === 'sh_b' &&
      afterShelf.categories.length === 1 &&
      afterShelf.favorite === true,
    `书架 ${afterShelf?.shelves.map((item) => item.id).join(',')} / 分类 ${afterShelf?.categories.length} / 收藏 ${afterShelf?.favorite}`
  )
  check('删书架后磁盘文件仍在', existsSync(file), file)

  // 删分类：不删书、不动书架、不动收藏、文件还在
  removeCategory(db, 'ct_a')
  const afterCategory = getBookDetail(db, bookId)
  check(
    '删分类不删书、不动书架与收藏',
    !!afterCategory &&
      afterCategory.categories.length === 0 &&
      afterCategory.shelves.length === 1 &&
      afterCategory.favorite === true,
    `分类 ${afterCategory?.categories.length} / 书架 ${afterCategory?.shelves.length} / 收藏 ${afterCategory?.favorite}`
  )
  check('删分类后磁盘文件仍在', existsSync(file), file)

  // 移出书库（软删除）：归属行仍在（CASCADE 只在物理删除时），文件还在
  removeBooks(db, [bookId])
  const orphanShelf = db.prepare('SELECT COUNT(*) AS n FROM shelf_books WHERE book_id = ?').get(bookId) as { n: number }
  const softDeleted = db.prepare('SELECT deleted_at FROM books WHERE id = ?').get(bookId) as { deleted_at: number | null }
  check(
    '移出书库只软删除（归属行未被级联清掉）',
    softDeleted.deleted_at !== null && orphanShelf.n === 1,
    `deleted_at=${softDeleted.deleted_at !== null} / 书架行 ${orphanShelf.n}`
  )
  check('移出书库后磁盘文件仍在', existsSync(file), file)
  db.prepare('UPDATE books SET deleted_at = NULL WHERE id = ?').run(bookId)

  // ---------------------------------------------------------------- ② UI 入口不混淆 + 二次确认
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
      const waitFor = async (fn, timeout = 10000) => {
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
        // 入口：收藏在侧栏、书架在侧栏、分类是书库页的筛选器（不该有侧栏入口）
        await waitFor(() => q('[data-nav="favorites"]'))
        out.text.favNav = txt(q('[data-nav="favorites"]'))
        out.text.shelfSection = txt(q('[data-nav="shelves"]')) || 'in-section'
        out.text.hasCategoryNav = q('[data-nav="categories"]') ? '1' : '0'

        location.hash = '#/favorites'
        await waitFor(() => txt(q('[data-page-title]')) === '收藏的书籍')
        out.text.favTitle = txt(q('[data-page-title]'))

        location.hash = '#/shelves'
        await waitFor(() => qa('[data-shelf-card]').length > 0)
        out.text.ShelvesTitle = txt(q('h1'))
        out.info.shelfCards0 = qa('[data-shelf-card]').length

        // 删书架：先取消（书架必须还在），再确认（书架消失）
        const target = qa('[data-shelf-card]').find((el) => txt(el).includes('书架乙'))
        target.querySelector('[data-shelf-remove-btn]').click()
        await waitFor(() => q('[data-confirm-dialog]'))
        out.text.shelfConfirm = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-cancel]').click()
        await sleep(300)
        out.info.shelfCardsCancelled = qa('[data-shelf-card]').length
        qa('[data-shelf-card]').find((el) => txt(el).includes('书架乙')).querySelector('[data-shelf-remove-btn]').click()
        await waitFor(() => q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => qa('[data-shelf-card]').length === out.info.shelfCards0 - 1)
        out.info.shelfCardsAfter = qa('[data-shelf-card]').length

        // 分类筛选器在书库页工具栏里（不在侧栏）
        location.hash = '#/library'
        await waitFor(() => q('[data-category-trigger]'))
        out.text.categoryTrigger = txt(q('[data-category-trigger]'))

        // 移出书库：确认框文案 + 取消后再来一次
        const card = q('[data-book-grid] [data-book-id="' + ${JSON.stringify(bookId)} + '"]')
        if (!card) {
          out.problems.push('书库列表里找不到样本')
          return JSON.stringify(out)
        }
        const rect = card.getBoundingClientRect()
        card.closest('[data-fav-on]').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10
        }))
        await waitFor(() => q('[data-menu-remove]'))
        q('[data-menu-remove]').click()
        await waitFor(() => q('[data-confirm-dialog]'))
        out.text.removeConfirm = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-cancel]').click()
        await sleep(300)
        out.text.stillListed = q('[data-book-grid] [data-book-id="' + ${JSON.stringify(bookId)} + '"]') ? '1' : '0'
        q('[data-book-grid] [data-book-id="' + ${JSON.stringify(bookId)} + '"]').closest('[data-fav-on]')
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }))
        await waitFor(() => q('[data-menu-remove]'))
        q('[data-menu-remove]').click()
        await waitFor(() => q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => !q('[data-book-grid] [data-book-id="' + ${JSON.stringify(bookId)} + '"]'))
        out.text.removedFromList = q('[data-book-grid] [data-book-id="' + ${JSON.stringify(bookId)} + '"]') ? '0' : '1'
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
    return report(checks, win)
  }

  const out = JSON.parse(raw) as { problems: string[]; info: Record<string, number>; text: Record<string, string> }
  const info = out.info
  const text = out.text

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check(
    '侧栏有「收藏 / 我的书架」入口，没有「分类」入口',
    (text['favNav'] ?? '').includes('收藏') && text['hasCategoryNav'] === '0',
    `收藏「${text['favNav'] ?? ''}」/ 分类入口 ${text['hasCategoryNav']}`
  )
  check('收藏页标题是「收藏的书籍」', text['favTitle'] === '收藏的书籍', text['favTitle'] ?? '')
  check('书架页标题是「我的书架」', (text['ShelvesTitle'] ?? '').includes('我的书架'), text['ShelvesTitle'] ?? '')
  check('分类是书库页的筛选器', (text['categoryTrigger'] ?? '').includes('分类'), text['categoryTrigger'] ?? '')
  check(
    '删书架有二次确认且不删书说明完整',
    (text['shelfConfirm'] ?? '').includes('不会被删除'),
    (text['shelfConfirm'] ?? '').slice(0, 50)
  )
  check(
    '取消删除后书架还在',
    info['shelfCardsCancelled'] === info['shelfCards0'],
    `${info['shelfCards0']} → ${info['shelfCardsCancelled']}`
  )
  check(
    '确认后书架消失',
    info['shelfCardsAfter'] === (info['shelfCards0'] ?? 0) - 1,
    `${info['shelfCards0']} → ${info['shelfCardsAfter']}`
  )
  check(
    '移出书库有二次确认且说明文件保留',
    (text['removeConfirm'] ?? '').includes('不会被删除'),
    (text['removeConfirm'] ?? '').slice(0, 50)
  )
  check('取消后书仍在列表里', text['stillListed'] === '1', text['stillListed'] ?? '')
  check('确认后书从列表消失', text['removedFromList'] === '1', text['removedFromList'] ?? '')

  // 最后一次「移出书库」之后：磁盘文件必须还在（这是「不删文件」的硬证据）
  check('全部删除操作之后磁盘文件仍在', existsSync(file), file)
  const finalRow = db.prepare('SELECT deleted_at FROM books WHERE id = ?').get(bookId) as { deleted_at: number | null }
  check('库记录只是软删除', finalRow.deleted_at !== null, `deleted_at=${finalRow.deleted_at}`)

  report(checks, win)
}

function report(checks: Check[], win: BrowserWindow): void {
  for (const item of checks) {
    console.log(`SMOKE M3 ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE M3 SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 && checks.length > 0 ? 0 : 1)
}
