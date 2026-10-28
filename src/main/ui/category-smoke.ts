/**
 * M3-03 分类自检：多对多口径 + 筛选与排序叠加 + CRUD。
 *
 * 分两段：
 *   A. 仓储直调——名称唯一、整体替换、多对多（书有多个标签 / 标签有多本书）、
 *      删除分类不删书、筛选 OR 语义、筛选与排序叠加、计数一致。
 *   B. 渲染层真点击——勾选分类（1 个 / 2 个并集 / 清除）、管理面板新建、
 *      改名、上移、删除（二次确认）。
 *
 * 只在 !app.isPackaged && CTEXT_CATEGORY_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { countBooks, listBooks } from '../db/repositories/books'
import {
  categoriesOfBook,
  createCategory,
  findCategoryByName,
  getCategory,
  listCategories,
  removeCategory,
  setBookCategories,
  updateCategory
} from '../db/repositories/categories'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const ids = (query: Parameters<typeof listBooks>[1]): string[] =>
  listBooks(getDb(), query).items.map((book) => book.id)

const bookTotal = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').get() as { n: number }).n

/** A. 仓储层断言 */
function runRepoChecks(): Check[] {
  const db = getDb()
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // 三把分类：科幻 / 历史 / 技术（fixture 没有分类，由这里造）
  const sf = createCategory(db, 'ct1', '科幻', '#5b8def')
  createCategory(db, 'ct2', '历史', '#d08b3e')
  createCategory(db, 'ct3', '技术', null)
  check('新建分类追加到末尾', sf.sort === 0 && listCategories(db).length === 3, `${listCategories(db).length} 个`)

  check('重名分类可被检出', findCategoryByName(db, '历史') === 'ct2', String(findCategoryByName(db, '历史')))
  check(
    '改名时排除自己不算重名',
    findCategoryByName(db, '科幻', 'ct1') === null,
    String(findCategoryByName(db, '科幻', 'ct1'))
  )

  setBookCategories(db, 'b08', ['ct1'])
  setBookCategories(db, 'b15', ['ct1'])
  setBookCategories(db, 'b06', ['ct2'])
  setBookCategories(db, 'b11', ['ct2'])
  setBookCategories(db, 'b02', ['ct3'])
  setBookCategories(db, 'b13', ['ct3', 'ct1'])

  check(
    '一个分类可以有多本书',
    (getCategory(db, 'ct1')?.bookCount ?? 0) === 3,
    `科幻 ${getCategory(db, 'ct1')?.bookCount} 本`
  )
  check(
    '一本书可以有多个分类',
    categoriesOfBook(db, 'b13').map((item) => item.id).join(',') === 'ct1,ct3',
    categoriesOfBook(db, 'b13').map((item) => item.id).join(',')
  )

  // 整体替换：给 b13 改成只剩「技术」，不残留「科幻」
  setBookCategories(db, 'b13', ['ct3'])
  check(
    '设置分类是整体替换',
    categoriesOfBook(db, 'b13').map((item) => item.id).join(',') === 'ct3',
    categoriesOfBook(db, 'b13').map((item) => item.id).join(',')
  )
  setBookCategories(db, 'b13', ['ct3', 'ct1'])

  check(
    '单分类筛选',
    ids({ categoryIds: ['ct1'], offset: 0, limit: 50 }).sort().join(',') === 'b08,b13,b15',
    ids({ categoryIds: ['ct1'], offset: 0, limit: 50 }).sort().join(',')
  )
  check(
    '多分类是 OR 并集',
    ids({ categoryIds: ['ct1', 'ct2'], offset: 0, limit: 50 }).sort().join(',') === 'b06,b08,b11,b13,b15',
    ids({ categoryIds: ['ct1', 'ct2'], offset: 0, limit: 50 }).sort().join(',')
  )
  // 中文按码点序：万 4E07 < 三 4E09 < 明 660E < 沙 6C99 < 深 6DF1
  check(
    '筛选与排序叠加（分类 + 书名升序）',
    ids({ categoryIds: ['ct1', 'ct2'], sort: { field: 'title', direction: 'asc' }, offset: 0, limit: 50 }).join(',') ===
      'b11,b08,b06,b15,b13',
    ids({ categoryIds: ['ct1', 'ct2'], sort: { field: 'title', direction: 'asc' }, offset: 0, limit: 50 }).join(',')
  )
  check(
    '计数与列表同口径',
    countBooks(db, { categoryIds: ['ct1', 'ct2'] }) === 5,
    String(countBooks(db, { categoryIds: ['ct1', 'ct2'] }))
  )

  updateCategory(db, 'ct2', { name: '历史与纪实', color: '#c0504d' })
  check(
    '改名与改色',
    getCategory(db, 'ct2')?.name === '历史与纪实' && getCategory(db, 'ct2')?.color === '#c0504d',
    `${getCategory(db, 'ct2')?.name} / ${getCategory(db, 'ct2')?.color}`
  )
  // 排到最后：ct2 与 ct3 都写 2 会撞号，撞号后由 name 兜底（那是隐式行为，不该靠它）
  updateCategory(db, 'ct2', { sort: 3 })
  check(
    '排序写回后列表顺序变化',
    listCategories(db).map((item) => item.id).join(',') === 'ct1,ct3,ct2',
    listCategories(db).map((item) => item.id).join(',')
  )
  updateCategory(db, 'ct2', { sort: 1 })

  const before = bookTotal()
  removeCategory(db, 'ct3')
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM book_categories WHERE category_id = ?').get('ct3') as { n: number }
  check(
    '删除分类不删书、关联清空',
    bookTotal() === before && orphan.n === 0,
    `书 ${before} → ${bookTotal()} / 残留 ${orphan.n}`
  )

  return checks
}

export async function runCategorySmoke(win: BrowserWindow): Promise<Check[]> {
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
      const count = () => txt(q('[data-book-count]'))
      const rowIds = () => qa('[data-category-row]').map((el) => el.getAttribute('data-category-id'))
      const out = { problems: [], text: {}, info: {} }

      try {
        await waitFor(() => count() === '16 本', 15000)
        out.text.count0 = count()

        // ① 勾一个分类
        q('[data-category-trigger]').click()
        await waitFor(() => q('[data-category-option="ct1"]'), 4000)
        q('[data-category-option="ct1"]').click()
        await waitFor(() => count() === '3 本', 6000)
        out.text.count1 = count()
        out.text.cardIds1 = qa('[data-book-grid] [data-book-id]').map((el) => el.getAttribute('data-book-id')).sort().join(',')
        out.text.triggerLabel = txt(q('[data-category-label]'))

        // ② 再勾一个：OR 并集
        q('[data-category-option="ct2"]').click()
        await waitFor(() => count() === '5 本', 6000)
        out.text.count2 = count()

        // ③ 清除
        q('[data-category-clear]').click()
        await waitFor(() => count() === '16 本', 6000)
        out.text.count3 = count()
        out.text.triggerLabelAfter = txt(q('[data-category-label]'))

        // ④ 管理面板：新建
        q('[data-category-trigger]').click()
        await waitFor(() => q('[data-category-manage]'), 4000)
        q('[data-category-manage]').click()
        await waitFor(() => q('[data-category-manager]'), 4000)
        out.info.rows0 = qa('[data-category-row]').length
        const newName = q('[data-category-new-name]')
        newName.value = '武侠'
        newName.dispatchEvent(new Event('input', { bubbles: true }))
        q('[data-category-create]').click()
        await waitFor(() => qa('[data-category-row]').length === 3, 6000)
        out.text.rowIds1 = rowIds().join(',')
        const created = rowIds()[2]

        // ⑤ 改名（失焦提交）
        const row = q('[data-category-row][data-category-id="' + created + '"]')
        const nameInput = row.querySelector('[data-category-name]')
        out.text.nameBefore = nameInput.value
        nameInput.value = '江湖'
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
        nameInput.dispatchEvent(new Event('blur', { bubbles: true }))
        await waitFor(() => {
          const el = q('[data-category-row][data-category-id="' + created + '"] [data-category-name]')
          return el && el.value === '江湖'
        }, 6000)
        out.text.nameAfter = q('[data-category-row][data-category-id="' + created + '"] [data-category-name]').value

        // ⑥ 上移
        q('[data-category-row][data-category-id="' + created + '"] [data-category-up]').click()
        await waitFor(() => rowIds()[1] === created, 6000)
        out.text.rowIds2 = rowIds().join(',')

        // ⑦ 删除（二次确认）
        q('[data-category-row][data-category-id="' + created + '"] [data-category-remove]').click()
        await waitFor(() => q('[data-confirm-dialog]'), 4000)
        out.text.confirmDesc = txt(q('[data-confirm-dialog]'))
        q('[data-confirm-ok]').click()
        await waitFor(() => qa('[data-category-row]').length === 2, 6000)
        out.text.rowIds3 = rowIds().join(',')
        q('[data-category-manager-close]').click()
        await sleep(200)
        out.text.count4 = count()
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
  check('首屏 16 本', text['count0'] === '16 本', text['count0'] ?? '')
  check('勾「科幻」后 3 本', text['count1'] === '3 本', text['count1'] ?? '')
  check(
    '筛选结果正是带该标签的书',
    text['cardIds1'] === 'b08,b13,b15',
    text['cardIds1'] ?? ''
  )
  check('触发器显示已选数量', (text['triggerLabel'] ?? '').includes('1'), text['triggerLabel'] ?? '')
  check('再勾「历史」是 OR 并集（5 本）', text['count2'] === '5 本', text['count2'] ?? '')
  check('清除后回到 16 本', text['count3'] === '16 本', text['count3'] ?? '')
  check('清除后触发器回到「分类」', text['triggerLabelAfter'] === '分类', text['triggerLabelAfter'] ?? '')
  check('管理面板初始 2 个分类', info['rows0'] === 2, `${info['rows0']} 个`)
  check('新建分类出现在列表末尾', (text['rowIds1'] ?? '').split(',').length === 3, text['rowIds1'] ?? '')
  check('改名输入框预填原名', text['nameBefore'] === '武侠', text['nameBefore'] ?? '')
  check('改名后输入框显示新名', text['nameAfter'] === '江湖', text['nameAfter'] ?? '')
  check(
    '上移改变了分类顺序',
    (text['rowIds2'] ?? '').split(',')[1] === (text['rowIds1'] ?? '').split(',')[2],
    text['rowIds2'] ?? ''
  )
  check(
    '删除分类有二次确认且说明不影响书',
    (text['confirmDesc'] ?? '').includes('不受影响'),
    (text['confirmDesc'] ?? '').slice(0, 50)
  )
  check('删除后只剩 2 个分类', (text['rowIds3'] ?? '').split(',').length === 2, text['rowIds3'] ?? '')
  check('删除分类后书籍仍是 16 本', text['count4'] === '16 本', text['count4'] ?? '')

  // 落库校验
  check('全程书籍一本没少（16 本）', bookTotal() === 16, `${bookTotal()} 本`)
  check(
    '分类型关联已落库（b13 两个标签）',
    categoriesOfBook(getDb(), 'b13').map((item) => item.id).join(',') === 'ct1',
    categoriesOfBook(getDb(), 'b13').map((item) => item.id).join(',')
  )

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE CATEGORY ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE CATEGORY SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
