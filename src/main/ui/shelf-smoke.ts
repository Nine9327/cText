/**
 * M3-02 书架自检：CRUD / 架内顺序 / 三处入口同步。
 *
 * 分两段：
 *   A. 仓储直调——新建追加到末尾、加入幂等、移出后序号压实、拖拽插入、
 *      「删除书架不删书」、侧栏排序、`shelfOrder` 排序（含「没有 shelfId 时退回」）。
 *   B. 渲染层真点击 + 真拖拽——侧栏新建、拖书进书架、改名、架内拖动、
 *      卡片移出、删除书架（二次确认）。
 *
 * 只在 !app.isPackaged && CTEXT_SHELF_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { listBooks } from '../db/repositories/books'
import {
  addBooksToShelf,
  createShelf,
  getShelf,
  listShelves,
  moveBookInShelf,
  removeBooksFromShelf,
  removeShelf,
  renameShelf,
  reorderShelves
} from '../db/repositories/shelves'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const shelfOf = (id: string): string[] =>
  (
    getDb()
      .prepare('SELECT book_id FROM shelf_books WHERE shelf_id = ? ORDER BY sort')
      .all(id) as { book_id: string }[]
  ).map((row) => row.book_id)

const bookTotal = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').get() as { n: number }).n

/** A. 仓储层断言（用一把临时书架折腾，不动 fixture 的 s1/s2） */
function runRepoChecks(): Check[] {
  const db = getDb()
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const created = createShelf(db, 'sh_tmp', '临时书架', Date.now())
  check('新建书架追加到末尾', created.sort === 2, `sort=${created.sort}`)

  check('加入书架返回新增条数', addBooksToShelf(db, 'sh_tmp', ['b01', 'b02'], Date.now()) === 2, '2')
  check('重复加入不产生重复行', addBooksToShelf(db, 'sh_tmp', ['b01'], Date.now()) === 0, '0')
  check('架内顺序按加入先后', shelfOf('sh_tmp').join(',') === 'b01,b02', shelfOf('sh_tmp').join(','))

  moveBookInShelf(db, 'sh_tmp', 'b02', 0)
  check('拖到首位后顺序更新', shelfOf('sh_tmp').join(',') === 'b02,b01', shelfOf('sh_tmp').join(','))

  removeBooksFromShelf(db, 'sh_tmp', ['b02'])
  const remaining = db
    .prepare('SELECT book_id, sort FROM shelf_books WHERE shelf_id = ? ORDER BY sort')
    .all('sh_tmp') as { book_id: string; sort: number }[]
  check(
    '移出后序号压实为 0..n-1',
    remaining.length === 1 && remaining[0]?.sort === 0,
    remaining.map((row) => `${row.book_id}:${row.sort}`).join(' ')
  )

  check('改名生效', renameShelf(db, 'sh_tmp', '改过的名')?.name === '改过的名', getShelf(db, 'sh_tmp')?.name ?? '')

  // 同一本书可以在多个书架：b01 同时在 s2 与 sh_tmp 里
  const inBoth = shelfOf('s2').includes('b01') && shelfOf('sh_tmp').includes('b01')
  check('同一本书可属于多个书架', inBoth, `s2=${shelfOf('s2').join(',')} / tmp=${shelfOf('sh_tmp').join(',')}`)

  const before = bookTotal()
  removeShelf(db, 'sh_tmp')
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM shelf_books WHERE shelf_id = ?').get('sh_tmp') as { n: number }
  check(
    '删除书架不删书、关联清空',
    bookTotal() === before && orphan.n === 0 && !listShelves(db).some((shelf) => shelf.id === 'sh_tmp'),
    `书 ${before} → ${bookTotal()} / 残留关联 ${orphan.n}`
  )

  reorderShelves(db, ['s2', 's1'])
  check('侧栏书架排序生效', listShelves(db).map((shelf) => shelf.id).join(',') === 's2,s1', listShelves(db).map((shelf) => shelf.id).join(','))
  reorderShelves(db, ['s1', 's2'])

  // shelfOrder：书架域按 shelf_books.sort 排
  const inShelf = listBooks(db, { shelfId: 's1', sort: { field: 'shelfOrder', direction: 'asc' }, offset: 0, limit: 20 })
  check(
    'shelfOrder 按架内顺序返回',
    inShelf.items.map((book) => book.id).join(',') === 'b03,b10,b12,b14',
    inShelf.items.map((book) => book.id).join(',')
  )

  // 没有 shelfId 却要 shelfOrder：退回导入时间倒序，不报错（排序菜单跨三入口共享）
  const fallback = listBooks(db, { sort: { field: 'shelfOrder', direction: 'asc' }, offset: 0, limit: 20 })
  check('无 shelfId 时 shelfOrder 退回导入时间', fallback.items.length === 16, `${fallback.items.length} 本`)

  return checks
}

export async function runShelfSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
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
      const ids = () => qa('[data-book-grid] [data-book-id]').map((el) => el.getAttribute('data-book-id'))
      // 直接传元素，不传选择器：属性标记会在多次拖拽之间残留，q() 取到的是
      // 文档顺序里第一个匹配项（可能是上一轮留下的侧栏书架），落点就跑偏了
      const dragBetween = (from, to, mime) => {
        if (!from || !to) return false
        const dt = new DataTransfer()
        dt.setData(mime, '')
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        return true
      }
      const out = { problems: [], text: {}, info: {} }

      try {
        await waitFor(() => q('[data-shelf-item]'), 15000)
        out.info.shelfItems0 = qa('[data-shelf-item]').length

        // ① 侧栏新建书架
        q('[data-shelf-create]').click()
        await waitFor(() => q('[data-shelf-name-input]'), 4000)
        const input = q('[data-shelf-name-input]')
        input.value = '待读'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        q('[data-shelf-dialog-ok]').click()
        await waitFor(() => qa('[data-shelf-item]').length === 3, 6000)
        out.info.shelfItems1 = qa('[data-shelf-item]').length
        out.text.newShelf = qa('[data-shelf-item]').map(txt).join(' | ')

        // ② 把书库里的第一本书拖到侧栏的「待读」书架上
        await waitFor(() => q('[data-book-grid] [data-book-id]'), 10000)
        const firstCard = q('[data-book-grid] [data-fav-on]')
        out.text.dragId = firstCard.querySelector('[data-book-id]').getAttribute('data-book-id')
        const newShelfItem = qa('[data-shelf-item]').find((el) => txt(el).includes('待读'))
        dragBetween(firstCard, newShelfItem, 'text/ctext-book')
        await waitFor(() => txt(newShelfItem).includes('1'), 6000)
        out.text.newShelfAfterDrop = txt(newShelfItem)

        // ③ 书架总览页：改名
        q('[data-nav="shelves"]').click()
        await waitFor(() => qa('[data-shelf-card]').length === 3, 6000)
        out.info.shelfCards = qa('[data-shelf-card]').length
        const target = qa('[data-shelf-card]').find((el) => txt(el).includes('待读'))
        target.querySelector('[data-shelf-rename]').click()
        await waitFor(() => q('[data-shelf-name-input]'), 4000)
        const renameInput = q('[data-shelf-name-input]')
        out.text.renamePrefill = renameInput.value
        renameInput.value = '周末读'
        renameInput.dispatchEvent(new Event('input', { bubbles: true }))
        q('[data-shelf-dialog-ok]').click()
        const renamed = await waitFor(() => qa('[data-shelf-card]').some((el) => txt(el).includes('周末读')), 6000)
        out.text.renamed = renamed ? '1' : '0'

        // ④ 进「技术书」(s2)：架内顺序 = 加入顺序 b02,b13,b01
        location.hash = '#/shelves/s2'
        await waitFor(() => q('[data-page-title]') && txt(q('[data-page-title]')).includes('技术书'), 8000)
        await waitFor(() => ids().length === 3, 8000)
        out.text.order0 = ids().join(',')
        out.text.sortLabel = txt(q('[data-sort-label]'))

        // ⑤ 架内拖拽：把第 2 张（b13）拖到第 3 张（b01）上
        const cards = qa('[data-book-grid] [data-book-id]')
        const dragCard = cards[1].closest('[data-fav-on]')
        const dropCard = cards[2].closest('[data-fav-on]')
        dragBetween(dragCard, dropCard, 'text/ctext-book')
        await waitFor(() => ids().join(',') === 'b02,b01,b13', 6000)
        out.text.order1 = ids().join(',')

        // ⑥ 移出书架：卡片上的 ✕ 只解除分组（移出的是第一张 b02）
        q('[data-book-grid] [data-shelf-remove]').click()
        await waitFor(() => ids().length === 2, 6000)
        out.text.afterRemove = ids().join(',')
        out.text.toasts = qa('[data-toast]').map(txt).join(' | ')

        // ⑦ 回总览页删除「周末读」：二次确认后侧栏只剩 2 个书架
        q('[data-nav="shelves"]').click()
        await waitFor(() => qa('[data-shelf-card]').length === 3, 6000)
        const del = qa('[data-shelf-card]').find((el) => txt(el).includes('周末读'))
        del.querySelector('[data-shelf-remove-btn]').click()
        await waitFor(() => q('[data-confirm-dialog]'), 4000)
        out.text.confirmDesc = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => qa('[data-shelf-card]').length === 2, 6000)
        out.info.shelfCardsAfterDelete = qa('[data-shelf-card]').length
        out.info.shelfItemsAfterDelete = qa('[data-shelf-item]').length

        // ⑧ 书架详情页直接删除整个书架（M3-02 补入口）：删完退回总览，书还在
        location.hash = '#/shelves/s1'
        await waitFor(() => q('[data-shelf-delete]'), 8000)
        out.text.detailTitle = txt(q('[data-page-title]'))

        // ⑨ 批量「移出书架」：只解分组、可撤销（撤销后不保证原顺序，只保证本数回来）
        await waitFor(() => ids().length === 4, 8000)
        q('[data-batch-toggle]').click()
        await waitFor(() => q('[data-batch-unshelf]'), 4000)
        q('[data-batch-all]').click()
        await sleep(200)
        out.text.batchSelected = txt(q('[data-batch-count]'))
        q('[data-batch-unshelf]').click()
        await waitFor(() => ids().length === 0, 6000)
        out.text.batchToast = qa('[data-toast]').map(txt).join(' | ')
        q('[data-undo-action]').click()
        await waitFor(() => ids().length === 4, 6000)
        out.info.afterUndoCount = ids().length
        q('[data-batch-toggle]').click()
        await sleep(200)

        // ⑩ 删除整个书架：二次确认 → 退回总览
        q('[data-shelf-delete]').click()
        await waitFor(() => q('[data-confirm-dialog]'), 4000)
        out.text.detailConfirmDesc = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => location.hash === '#/shelves', 6000)
        out.info.shelfItemsAfterDetailDelete = qa('[data-shelf-item]').length
        out.text.detailToast = qa('[data-toast]').map(txt).join(' | ')

        // ⑪ 侧栏书架菜单：右键 / 「⋯」都能打开，项是重命名与删除
        const restShelf = q('[data-shelf-row]')
        restShelf.querySelector('[data-shelf-more]').click()
        await waitFor(() => q('[data-shelf-menu]'), 4000)
        out.text.menuTitle = txt(q('[data-shelf-menu-title]'))
        out.text.menuItems = qa('[data-shelf-menu] .ct-menu-item').map(txt).join(' | ')
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await sleep(150)
        out.info.menuClosed = q('[data-shelf-menu]') ? 0 : 1
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
  check('侧栏初始 2 个书架', info['shelfItems0'] === 2, `${info['shelfItems0']} 个`)
  check('侧栏新建书架后变成 3 个', info['shelfItems1'] === 3, `${info['shelfItems1']} 个 / ${text['newShelf'] ?? ''}`)
  check(
    '拖书到侧栏书架即加入（计数 1 本）',
    /\s*待读\s*1$/.test((text['newShelfAfterDrop'] ?? '').trim()),
    text['newShelfAfterDrop'] ?? ''
  )
  check('重命名时输入框预填原名', text['renamePrefill'] === '待读', text['renamePrefill'] ?? '')
  check('重命名后书架名更新', text['renamed'] === '1', text['renamed'] ?? '')
  check('书架页默认「架内顺序」', text['sortLabel'] === '架内顺序', text['sortLabel'] ?? '')
  check('架内顺序 = 加入顺序', text['order0'] === 'b02,b13,b01', text['order0'] ?? '')
  check('拖拽后顺序按落点重排', text['order1'] === 'b02,b01,b13', text['order1'] ?? '')
  check('移出书架后卡片消失', text['afterRemove'] === 'b01,b13', text['afterRemove'] ?? '')
  check('移出时说明「文件仍在书库」', (text['toasts'] ?? '').includes('仍在书库'), text['toasts'] ?? '')
  check(
    '删除书架有二次确认且说明不影响书',
    (text['confirmDesc'] ?? '').includes('不会被删除'),
    (text['confirmDesc'] ?? '').slice(0, 60)
  )
  check('删除后侧栏只剩 2 个书架', info['shelfItemsAfterDelete'] === 2, `${info['shelfItemsAfterDelete']} 个`)

  // 书架详情页的删除入口（M3-02 补齐）：站在书架里就能处理这个书架
  check('书架详情页显示当前书架标题', text['detailTitle'] === '睡前读物', text['detailTitle'] ?? '')

  // 批量移出书架（书架域专用按钮）
  check('书架页全选后显示已选本数', (text['batchSelected'] ?? '').includes('4'), text['batchSelected'] ?? '')
  check(
    '批量移出书架提示文件仍在书库',
    (text['batchToast'] ?? '').includes('文件仍在书库中'),
    text['batchToast'] ?? ''
  )
  check('撤销批量移出后书回到书架', info['afterUndoCount'] === 4, `${info['afterUndoCount']} 本`)
  check(
    '详情页删除同样二次确认且说明不删书',
    (text['detailConfirmDesc'] ?? '').includes('不会被删除'),
    (text['detailConfirmDesc'] ?? '').slice(0, 60)
  )
  check('详情页删除后侧栏只剩 1 个书架', info['shelfItemsAfterDetailDelete'] === 1, `${info['shelfItemsAfterDetailDelete']} 个`)
  check(
    '详情页删除后提示书籍仍在书库',
    (text['detailToast'] ?? '').includes('仍保留在书库中'),
    text['detailToast'] ?? ''
  )

  // 侧栏菜单：重命名 / 删除书架两条路都从这里进
  check('侧栏「⋯」打开书架菜单', (text['menuTitle'] ?? '').length > 0, text['menuTitle'] ?? '')
  check('书架菜单含重命名与删除', (text['menuItems'] ?? '').includes('重命名') && (text['menuItems'] ?? '').includes('删除书架'), text['menuItems'] ?? '')
  check('ESC 关闭书架菜单', info['menuClosed'] === 1, `${info['menuClosed']}`)

  // 落库校验：整个流程走完，书籍一本没少
  check('全程书籍一本没少（16 本）', bookTotal() === 16, `${bookTotal()} 本`)
  const s2 = shelfOf('s2')
  check('s2 的架内顺序已落库', s2.join(',') === 'b01,b13', s2.join(','))

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE SHELF ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE SHELF SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
