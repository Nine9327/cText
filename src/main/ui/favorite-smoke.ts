/**
 * M3-01 收藏自检：开关口径（主进程）+ 三处状态同步（渲染层）。
 *
 * 分两段：
 *   A. 仓储直调——收藏是**纯标记**：不碰 `updated_at`（它是章节缓存的版本号）、
 *      不碰进度与章数、传目标值幂等、书不存在时返回 false 而不是静默成功。
 *   B. 渲染层真点击——星标状态、侧栏计数、（收藏页取消收藏后）卡片消失与 toast、
 *      以及「点星标不会顺手把书打开」。
 *
 * 只在 !app.isPackaged && CTEXT_FAVORITE_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { setFavorite } from '../db/repositories/books'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

interface BookRow {
  favorite: number
  updated_at: number
  progress: number
  read_state: string
  chapter_count: number
}

const rowOf = (id: string): BookRow | undefined =>
  getDb()
    .prepare('SELECT favorite, updated_at, progress, read_state, chapter_count FROM books WHERE id = ?')
    .get(id) as BookRow | undefined

/** A. 仓储层断言：先把「收藏到底改了什么」钉死 */
function runRepoChecks(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const before = rowOf('b02')
  const ok = setFavorite(getDb(), 'b02', true)
  const after = rowOf('b02')

  check('收藏写入成功', ok === true && after?.favorite === 1, `favorite=${after?.favorite}`)
  // updated_at 是阅读器章节缓存的版本号：收藏改它 = 点一下星标把整章缓存作废
  check(
    '收藏不改 updated_at（章节缓存版本号）',
    before?.updated_at === after?.updated_at,
    `${before?.updated_at} → ${after?.updated_at}`
  )
  check(
    '收藏不改进度 / 阅读状态 / 章数',
    after?.progress === before?.progress &&
      after?.read_state === before?.read_state &&
      after?.chapter_count === before?.chapter_count,
    `progress=${after?.progress} state=${after?.read_state} chapters=${after?.chapter_count}`
  )

  // 传目标值而不是「切换」：连点两次 value=true 仍应是「已收藏」
  setFavorite(getDb(), 'b02', true)
  check('重复写入目标值幂等', rowOf('b02')?.favorite === 1, `favorite=${rowOf('b02')?.favorite}`)

  setFavorite(getDb(), 'b02', false)
  check('取消收藏', rowOf('b02')?.favorite === 0, `favorite=${rowOf('b02')?.favorite}`)

  check('书不存在时返回 false', setFavorite(getDb(), 'not-a-book', true) === false, 'false')

  const total = getDb()
    .prepare('SELECT COUNT(*) AS n FROM books WHERE favorite = 1 AND deleted_at IS NULL')
    .get() as { n: number }
  check('计数与库内一致（fixture 5 本）', total.n === 5, `${total.n} 本`)

  // 软删除的书不能被收藏：否则侧栏计数里会出现一个点不开的幽灵
  getDb().prepare('UPDATE books SET deleted_at = ? WHERE id = ?').run(Date.now(), 'b04')
  const softDeleted = setFavorite(getDb(), 'b04', true)
  getDb().prepare('UPDATE books SET deleted_at = NULL WHERE id = ?').run('b04')
  check('软删除的书拒绝收藏', softDeleted === false, String(softDeleted))

  return checks
}

export async function runFavoriteSmoke(win: BrowserWindow): Promise<Check[]> {
  // 关掉后台节流：自检窗口一旦被遮住，rAF/定时器降到每秒一两次，所有
  // 「点击后等一帧」的断言都会随机超时（同一份代码时好时坏）
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
  // 上一段的写操作会改 b02 的状态，跑完先复位，让渲染层从 5 本收藏起步
  getDb().prepare('UPDATE books SET favorite = 0 WHERE id = ?').run('b02')
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
        await waitFor(() => q('[data-book-grid] [data-book-id]'), 15000)
        if (!q('[data-book-grid] [data-book-id]')) {
          out.problems.push('书库列表未渲染')
          return JSON.stringify(out)
        }
        await waitFor(() => txt(q('[data-fav-count]')) === '5', 10000)
        out.text.favCount0 = txt(q('[data-fav-count]'))
        out.text.bookCount0 = txt(q('[data-book-count]'))

        // ① 挑一张未收藏的卡，点它的星标
        const card = qa('[data-book-grid] [data-fav-on="0"]')[0]
        if (!card) {
          out.problems.push('当前视口内没有未收藏的卡片')
          return JSON.stringify(out)
        }
        const id = (card.querySelector('[data-book-id]') || { getAttribute: () => '' }).getAttribute('data-book-id')
        out.text.id = id
        out.text.on0 = card.getAttribute('data-fav-on')

        const star = card.querySelector('[data-fav-toggle]')
        if (!star) {
          out.problems.push('卡片上没有星标按钮')
          return JSON.stringify(out)
        }
        star.click()
        await waitFor(() => {
          const el = q('[data-book-grid] [data-book-id="' + id + '"]')
          return el && el.closest('[data-fav-on="1"]')
        }, 6000)
        await waitFor(() => txt(q('[data-fav-count]')) === '6', 6000)
        out.text.favCount1 = txt(q('[data-fav-count]'))
        out.text.bookCount1 = txt(q('[data-book-count]'))
        out.text.on1 = (q('[data-book-grid] [data-book-id="' + id + '"]') || { closest: () => null })
          .closest('[data-fav-on]')
          ?.getAttribute('data-fav-on')
        // 点星标不能顺手把书打开（星标是卡片的兄弟节点，不是子节点）
        out.text.routeAfterStar = location.hash

        // ② 进收藏页：那本书在里面
        q('[data-nav="favorites"]').click()
        await waitFor(() => location.hash.startsWith('#/favorites'), 5000)
        await waitFor(() => q('[data-book-grid] [data-book-id="' + id + '"]'), 6000)
        out.text.inFavorites = q('[data-book-grid] [data-book-id="' + id + '"]') ? '1' : '0'
        out.text.favPageTitle = txt(q('[data-page-title]'))
        out.info.favPageCards = qa('[data-book-grid] [data-book-id]').length

        // ③ 在收藏页取消收藏：卡片当场消失 + 一条解释性 toast
        const card2 = q('[data-book-grid] [data-book-id="' + id + '"]')?.closest('[data-fav-on]')
        card2.querySelector('[data-fav-toggle]').click()
        const gone = await waitFor(
          () => !q('[data-book-grid] [data-book-id="' + id + '"]'),
          6000
        )
        out.text.gone = gone ? '1' : '0'
        await waitFor(() => txt(q('[data-fav-count]')) === '5', 6000)
        out.text.favCount2 = txt(q('[data-fav-count]'))
        out.text.toast = txt(q('[data-toast]'))

        // ④ 回书库：那张卡的星标确实恢复成未收藏
        q('[data-nav="library"]').click()
        await waitFor(() => location.hash.startsWith('#/library'), 5000)
        const back = await waitFor(() => q('[data-book-grid] [data-book-id="' + id + '"]'), 8000)
        out.text.on2 = back ? back.closest('[data-fav-on]').getAttribute('data-fav-on') : 'missing'
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

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check('首屏收藏计数 5', out.text['favCount0'] === '5', out.text['favCount0'] ?? '')
  check('挑中的卡片初始是未收藏', out.text['on0'] === '0', `book=${out.text['id']} on=${out.text['on0']}`)
  check('点星标后卡片变为已收藏', out.text['on1'] === '1', `on=${out.text['on1']}`)
  check('侧栏收藏计数 +1（5 → 6）', out.text['favCount1'] === '6', out.text['favCount1'] ?? '')
  check(
    '点星标不改变书籍总数',
    out.text['bookCount0'] === out.text['bookCount1'],
    `${out.text['bookCount0']} → ${out.text['bookCount1']}`
  )
  check('点星标不会打开阅读器', (out.text['routeAfterStar'] ?? '').startsWith('#/library'), out.text['routeAfterStar'] ?? '')
  check(
    '收藏页里能看到刚收藏的书',
    out.text['inFavorites'] === '1' && out.text['favPageTitle'] === '收藏的书籍',
    `${out.text['favPageTitle'] ?? ''} / 卡片 ${out.info['favPageCards']}`
  )
  check('收藏页取消收藏后卡片立即消失', out.text['gone'] === '1', `gone=${out.text['gone']}`)
  check('侧栏收藏计数 -1（6 → 5）', out.text['favCount2'] === '5', out.text['favCount2'] ?? '')
  check(
    '卡片消失时给出解释性提示',
    (out.text['toast'] ?? '').includes('取消收藏'),
    out.text['toast'] || '无 toast'
  )
  check('回到书库后该卡恢复未收藏', out.text['on2'] === '0', `on=${out.text['on2']}`)

  // 落库校验：渲染层的点击真的写进了数据库（不是只改了内存里的那张卡）
  const persisted = rowOf(out.text['id'] ?? '')
  check(
    '点击结果已落库',
    persisted?.favorite === 0,
    `${out.text['id']} favorite=${persisted?.favorite}`
  )

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE FAVORITE ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE FAVORITE SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
