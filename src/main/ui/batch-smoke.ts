/**
 * M3-05 批量与右键菜单自检。
 *
 * 分两段：
 *   A. 主进程——500 本的批量收藏 / 批量打标签耗时（验收要求 <2s）、
 *      软删除与恢复、`addBookCategories` 回传**真正新增**的 bookIds（撤销的依据）。
 *   B. 渲染层——右键菜单七项、单本收藏/加书架/打分类/重新识别/移出书库、
 *      批量模式（选中 / 全选 / 批量收藏 / 批量移出）以及撤销。
 *
 * 只在 !app.isPackaged && CTEXT_BATCH_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { listBooks, removeBooks, restoreBooks, setFavoriteMany } from '../db/repositories/books'
import { addBookCategories, createCategory, listCategories } from '../db/repositories/categories'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const PERF_COUNT = 500
const BUDGET_MS = 2000

const visibleCount = (): number => listBooks(getDb(), { offset: 0, limit: 2000 }).total

/** 造 500 本书（只为了量批量写入，UI 段开始前会删干净） */
function seedPerfBooks(): string[] {
  const db = getDb()
  const now = Date.now()
  const ids: string[] = []
  const insert = db.prepare(
    `INSERT INTO books (id, title, author, format, root_id, rel_path, file_hash, size_bytes,
                        chapter_count, source_type, created_at, updated_at)
     VALUES (?, ?, ?, 'txt', 'r1', ?, ?, 1024, 1, 'local', ?, ?)`
  )
  db.transaction(() => {
    for (let i = 0; i < PERF_COUNT; i += 1) {
      const id = `perf${String(i).padStart(4, '0')}`
      ids.push(id)
      insert.run(id, `压测样本${i}`, '批量测试', `perf/${id}.txt`, `hash-${id}`, now, now)
    }
  })()
  return ids
}

function clearPerfBooks(): void {
  getDb().prepare("DELETE FROM books WHERE id LIKE 'perf%'").run()
}

function runRepoChecks(): Check[] {
  const db = getDb()
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const ids = seedPerfBooks()
  check('压测样本就位', visibleCount() === PERF_COUNT + 16, `${visibleCount()} 本`)

  // 一次 UPDATE 覆盖 500 本：逐本发 IPC 光往返就远超 2 秒
  const started = Date.now()
  const updated = setFavoriteMany(db, ids, true)
  const favoriteMs = Date.now() - started
  check(
    `批量收藏 ${PERF_COUNT} 本 < ${BUDGET_MS}ms`,
    updated === PERF_COUNT && favoriteMs < BUDGET_MS,
    `${favoriteMs}ms / 命中 ${updated} 本`
  )

  createCategory(db, 'ct_perf', '压测标签', null)
  const tagStart = Date.now()
  const tagged = addBookCategories(db, ids, ['ct_perf'])
  const tagMs = Date.now() - tagStart
  check(
    `批量打标签 ${PERF_COUNT} 本 < ${BUDGET_MS}ms`,
    tagged.updated === PERF_COUNT && tagMs < BUDGET_MS,
    `${tagMs}ms / 写入 ${tagged.updated} 行`
  )
  check('回传真正受影响的 bookIds', tagged.bookIds.length === PERF_COUNT, `${tagged.bookIds.length} 个`)

  // 第二次打同一批标签：一行都不该新增，撤销范围也必须为空
  const again = addBookCategories(db, ids, ['ct_perf'])
  check('重复打标签不产生新增', again.updated === 0 && again.bookIds.length === 0, `${again.updated} 行 / ${again.bookIds.length} 个`)

  // 软删除与恢复
  const removed = removeBooks(db, ids.slice(0, 100))
  check('批量软删除只影响目标', removed === 100 && visibleCount() === PERF_COUNT - 100 + 16, `移除 ${removed} / 剩 ${visibleCount()}`)
  const restored = restoreBooks(db, ids.slice(0, 100))
  check('软删除可恢复', restored === 100 && visibleCount() === PERF_COUNT + 16, `恢复 ${restored} / 剩 ${visibleCount()}`)

  clearPerfBooks()
  getDb().prepare('DELETE FROM categories WHERE id = ?').run('ct_perf')
  check('压测样本已清理（回到 fixture）', visibleCount() === 16 && listCategories(db).length === 1, `${visibleCount()} 本`)

  return checks
}

export async function runBatchSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO categories (id, name, color, sort) VALUES (?, ?, ?, 0)').run('ct1', '科幻', '#5b8def')
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
      const count = () => txt(q('[data-book-count]'))
      const cardOf = (id) => q('[data-book-grid] [data-book-id="' + id + '"]')
      const rightClick = (el) => {
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20
        }))
      }
      const out = { problems: [], text: {}, info: {} }

      try {
        await waitFor(() => count() === '16 本', 15000)

        // ① 右键菜单七项
        out.text.firstId = q('[data-book-grid] [data-book-id]').getAttribute('data-book-id')
        rightClick(cardOf(out.text.firstId))
        await waitFor(() => q('[data-book-menu]'), 4000)
        out.info.menuItems = qa('[data-book-menu] .ct-menu-item').length
        out.info.hasSeven = ['read','detail','favorite','shelf','category','rematch','remove']
          .filter((key) => q('[data-menu-' + key + ']')).length

        // ② 单本收藏（菜单里）
        q('[data-menu-favorite]').click()
        await waitFor(() => {
          const el = cardOf(out.text.firstId)
          return el && el.closest('[data-fav-on="1"]')
        }, 6000)
        out.text.favAfterMenu = cardOf(out.text.firstId).closest('[data-fav-on]').getAttribute('data-fav-on')

        // ③ 加入书架（二级列表）
        rightClick(cardOf(out.text.firstId))
        await waitFor(() => q('[data-menu-shelf]'), 4000)
        q('[data-menu-shelf]').click()
        await waitFor(() => q('[data-menu-shelf-option="s1"]'), 4000)
        out.info.submenuItems = qa('[data-book-menu] .ct-menu-item').length
        q('[data-menu-shelf-option="s1"]').click()
        await sleep(600)

        // ④ 打上分类（二级列表）
        rightClick(cardOf(out.text.firstId))
        await waitFor(() => q('[data-menu-category]'), 4000)
        q('[data-menu-category]').click()
        await waitFor(() => q('[data-menu-category-option="ct1"]'), 4000)
        q('[data-menu-category-option="ct1"]').click()
        await sleep(600)

        // ⑤ 重新识别（M3-06 未实现，只给提示）
        rightClick(cardOf(out.text.firstId))
        await waitFor(() => q('[data-menu-rematch]'), 4000)
        q('[data-menu-rematch]').click()
        await sleep(300)
        out.text.rematchToast = qa('[data-toast]').map(txt).join(' | ')

        // ⑥ 单本移出书库：二次确认 + 撤销
        rightClick(cardOf(out.text.firstId))
        await waitFor(() => q('[data-menu-remove]'), 4000)
        q('[data-menu-remove]').click()
        await waitFor(() => q('[data-confirm-dialog]'), 4000)
        out.text.confirmDesc = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => count() === '15 本', 6000)
        out.text.countAfterRemove = count()
        const undoBar = await waitFor(() => q('[data-undo-bar]'), 4000)
        out.text.undoLabel = undoBar ? txt(undoBar) : ''
        q('[data-undo-action]').click()
        await waitFor(() => count() === '16 本', 6000)
        out.text.countAfterUndo = count()

        // ⑦ 批量模式：卡片点击变选中，不跳转
        q('[data-batch-toggle]').click()
        await waitFor(() => q('[data-batch-bar]'), 4000)
        const hashBefore = location.hash
        cardOf('b02').click()
        await sleep(200)
        out.text.batchCount1 = txt(q('[data-batch-count]'))
        out.text.routeStable = location.hash === hashBefore ? '1' : '0'

        // ⑧ 全选本页 → 批量收藏 → 撤销
        q('[data-batch-all]').click()
        await waitFor(() => txt(q('[data-batch-count]')) === '已选 16 本', 4000)
        out.text.batchCount2 = txt(q('[data-batch-count]'))
        out.text.favCountBefore = txt(q('[data-fav-count]'))
        q('[data-batch-favorite]').click()
        await waitFor(() => txt(q('[data-fav-count]')) === '16', 8000)
        out.text.favCountAfter = txt(q('[data-fav-count]'))
        out.text.undoBatch = txt(q('[data-undo-bar]'))
        q('[data-undo-action]').click()
        await waitFor(() => txt(q('[data-fav-count]')) === '5', 8000)
        out.text.favCountUndone = txt(q('[data-fav-count]'))

        // ⑨ 批量移出书库 → 撤销
        q('[data-batch-all]').click()
        await waitFor(() => txt(q('[data-batch-count]')) === '已选 16 本', 4000)
        q('[data-batch-remove]').click()
        await waitFor(() => q('[data-confirm-dialog]'), 4000)
        q('[data-confirm-ok]').click()
        await waitFor(() => count() === '0 本', 8000)
        out.text.countAllRemoved = count()
        q('[data-undo-action]').click()
        await waitFor(() => count() === '16 本', 8000)
        out.text.countAllRestored = count()
        q('[data-batch-toggle]').click()
        await sleep(200)
        out.text.batchBarGone = q('[data-batch-bar]') ? '0' : '1'
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
  check('右键菜单共 7 项', info['menuItems'] === 7, `${info['menuItems']} 项`)
  check(
    '七项齐全（阅读/详情/收藏/书架/分类/识别/移除）',
    info['hasSeven'] === 7,
    `命中 ${info['hasSeven']} 项`
  )
  check('菜单里的收藏立即生效', text['favAfterMenu'] === '1', text['favAfterMenu'] ?? '')
  check('二级列表可用', info['submenuItems']! > 1, `${info['submenuItems']} 行`)
  check('重新识别给出未实现提示', (text['rematchToast'] ?? '').includes('M3-06'), text['rematchToast'] ?? '')
  check(
    '移出书库有二次确认且说明文件保留',
    (text['confirmDesc'] ?? '').includes('不会被删除'),
    (text['confirmDesc'] ?? '').slice(0, 50)
  )
  check('单本移出后列表少一本', text['countAfterRemove'] === '15 本', text['countAfterRemove'] ?? '')
  check('移出后出现撤销条', (text['undoLabel'] ?? '').includes('移出书库'), text['undoLabel'] ?? '')
  check('撤销后书回到列表', text['countAfterUndo'] === '16 本', text['countAfterUndo'] ?? '')
  check('批量模式下点击是选中而非打开', text['batchCount1'] === '已选 1 本' && text['routeStable'] === '1', `${text['batchCount1']} / 路由未变 ${text['routeStable']}`)
  check('全选本页选中 16 本', text['batchCount2'] === '已选 16 本', text['batchCount2'] ?? '')
  // 起点不是 5：上面「菜单里的收藏」已经让 b16 变成收藏，所以这里只断言「推到 16」，
  // 起点用实测值比对——写死数字会在前后步骤的顺序变化时立刻失效
  check(
    '批量收藏把侧栏计数推到 16',
    text['favCountAfter'] === '16',
    `${text['favCountBefore']} → ${text['favCountAfter']}`
  )
  check('批量操作后可撤销', (text['undoBatch'] ?? '').includes('收藏'), text['undoBatch'] ?? '')
  check(
    '撤销批量收藏后计数回到操作前',
    text['favCountUndone'] === text['favCountBefore'],
    `${text['favCountBefore']} → 16 → ${text['favCountUndone']}`
  )
  check('批量移出全部后列表为空', text['countAllRemoved'] === '0 本', text['countAllRemoved'] ?? '')
  check('撤销后 16 本全部回来', text['countAllRestored'] === '16 本', text['countAllRestored'] ?? '')
  check('退出批量后操作条消失', text['batchBarGone'] === '1', `batchBar=${text['batchBarGone']}`)

  // 落库校验
  const firstId = text['firstId'] ?? ''
  const row = db
    .prepare(
      `SELECT b.favorite,
              (SELECT COUNT(*) FROM shelf_books WHERE book_id = b.id AND shelf_id = 's1') AS on_shelf,
              (SELECT COUNT(*) FROM book_categories WHERE book_id = b.id AND category_id = 'ct1') AS tagged
       FROM books b WHERE b.id = ?`
    )
    .get(firstId) as { favorite: number; on_shelf: number; tagged: number } | undefined
  check(
    '右键加书架 / 打标签已落库',
    row?.on_shelf === 1 && row?.tagged === 1,
    `${firstId} 书架 ${row?.on_shelf} / 标签 ${row?.tagged}`
  )
  check('全程书籍 16 本未丢', visibleCount() === 16, `${visibleCount()} 本`)

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE BATCH ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE BATCH SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
