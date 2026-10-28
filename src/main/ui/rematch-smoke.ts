/**
 * M3-06 重新识别自检：覆盖元信息与目录、保留用户数据、失败不写库。
 *
 * 这条链路要真的调 Python worker（编码探测 / 元信息 / 目录），所以样本必须是
 * 磁盘上的真文件——这也是本套件唯一需要真实文件系统的原因。
 *
 * 分两段：
 *   A. 主进程——导入真 TXT → 手改元信息 + 加进度/收藏/书架/分类 → 重新识别
 *      → 元信息与章数被文件覆盖、用户数据全部还在、`updated_at` 被 bump；
 *      追加章节后再识别 → 章数变化；删文件后识别 → 抛错且**一个字段都没变**；
 *      目录离线 → 抛 E_ROOT_OFFLINE。
 *   B. 渲染层——详情页「重新识别」按钮与右键菜单入口都能跑通并给出结果提示。
 *
 * 只在 !app.isPackaged && CTEXT_REMATCH_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { getBookDetail, setFavorite, updateBookMeta } from '../db/repositories/books'
import { setBookCategories } from '../db/repositories/categories'
import { addBooksToShelf } from '../db/repositories/shelves'
import { checkAllRoots } from '../library/roots-monitor'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { coversDir } from '../ipc/import'
import { rematchBook } from '../library/rematch'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const REL_PATH = '重识别样本.txt'

const CHAPTERS_3 = [
  '第一章 开端',
  '这是第一章的正文内容，用于验证重新识别能否重新切出章节。',
  '第二章 发展',
  '这是第二章的正文内容，长度足够让切章规则正常命中。',
  '第三章 结局',
  '这是第三章的正文内容，收尾。'
].join('\n')

const CHAPTERS_5 = `${CHAPTERS_3}
第四章 余波
追加的第四章，用来验证重新识别后章数会变。
第五章 尾声
追加的第五章。`

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

interface Sample {
  dir: string
  file: string
  bookId: string
}

async function prepareSample(baseDir: string): Promise<Sample | null> {
  const dir = join(baseDir, 'rematch-lib')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, REL_PATH)
  writeFileSync(file, CHAPTERS_3, 'utf8')
  const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
  const phase = await waitForTask(taskId, 60_000)
  const row = getDb()
    .prepare('SELECT id FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get(REL_PATH) as { id: string } | undefined
  return phase === 'done' && row ? { dir, file, bookId: row.id } : null
}

export async function runRematchSmoke(win: BrowserWindow, baseDir: string): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // fixture 提供书架/根目录；分类自己造一个（fixture 没有分类）
  seedUiFixture(getDb())
  getDb()
    .prepare('INSERT OR REPLACE INTO categories (id, name, color, sort) VALUES (?, ?, ?, 0)')
    .run('ct1', '科幻', '#5b8def')
  const sample = await prepareSample(baseDir)
  check('真 TXT 样本导入成功', !!sample, sample ? `${sample.bookId}` : '导入失败')
  if (!sample) return finish(checks, win)

  const db = getDb()
  const beforeImport = getBookDetail(db, sample.bookId)
  check('初始按文件名识别书名', beforeImport?.title === '重识别样本', beforeImport?.title ?? '')
  check('初始切出 3 章', beforeImport?.chapterCount === 3, `${beforeImport?.chapterCount} 章`)

  // 模拟用户手改 + 加进度/收藏/书架/分类
  updateBookMeta(db, sample.bookId, { title: '用户手改的书名', author: '用户手改的作者' })
  db.prepare('UPDATE books SET progress = 0.42, read_state = ? WHERE id = ?').run('reading', sample.bookId)
  db.prepare('INSERT OR REPLACE INTO reading_progress (book_id, chapter_idx, offset, percent, updated_at) VALUES (?, 1, 240, 0.42, ?)').run(
    sample.bookId,
    Date.now()
  )
  setFavorite(db, sample.bookId, true)
  addBooksToShelf(db, 's1', [sample.bookId], Date.now())
  setBookCategories(db, sample.bookId, ['ct1'])

  // ① 重新识别：元信息被文件覆盖
  const first = await rematchBook(db, sample.bookId)
  const afterFirst = getBookDetail(db, sample.bookId)
  check(
    '重新识别把手改的书名/作者覆盖回识别值',
    afterFirst?.title === '重识别样本' && afterFirst?.author === null,
    `${afterFirst?.title} / ${afterFirst?.author ?? '无作者'}`
  )
  check('变化摘要说明了改了什么', first.changed.includes('书名') && first.changed.includes('作者'), first.changed.join('、') || '空')
  check(
    '保留进度 / 收藏 / 书架 / 分类',
    afterFirst?.progress === 0.42 &&
      afterFirst?.favorite === true &&
      afterFirst?.shelves.some((item) => item.id === 's1') &&
      afterFirst?.categories.some((item) => item.id === 'ct1'),
    `进度 ${afterFirst?.progress} / 收藏 ${afterFirst?.favorite} / 书架 ${afterFirst?.shelves.length} / 分类 ${afterFirst?.categories.length}`
  )
  const progressRow = db.prepare('SELECT chapter_idx, offset FROM reading_progress WHERE book_id = ?').get(sample.bookId) as
    | { chapter_idx: number; offset: number }
    | undefined
  check('阅读位置（章 + 偏移）原样保留', progressRow?.chapter_idx === 1 && progressRow?.offset === 240, `${progressRow?.chapter_idx} / ${progressRow?.offset}`)

  // ② 文件变了 → 章数跟着变，且 updated_at 被 bump（阅读器缓存必须失效）
  const stampBefore = (db.prepare('SELECT updated_at FROM books WHERE id = ?').get(sample.bookId) as { updated_at: number }).updated_at
  writeFileSync(sample.file, CHAPTERS_5, 'utf8')
  await sleep(5)
  await rematchBook(db, sample.bookId)
  const afterSecond = getBookDetail(db, sample.bookId)
  const stampAfter = (db.prepare('SELECT updated_at FROM books WHERE id = ?').get(sample.bookId) as { updated_at: number }).updated_at
  check('文件追加章节后重新识别到 5 章', afterSecond?.chapterCount === 5, `${afterSecond?.chapterCount} 章`)
  check('bump 了 updated_at（章节缓存失效）', stampAfter !== stampBefore, `${stampBefore} → ${stampAfter}`)

  // ③ 失败回退：删掉文件再识别，必须抛错且一个字段都不变
  const snapshot = getBookDetail(db, sample.bookId)
  rmSync(sample.file, { force: true })
  let failedMessage = ''
  try {
    await rematchBook(db, sample.bookId)
  } catch (err) {
    failedMessage = err instanceof Error ? err.message : String(err)
  }
  const afterFail = getBookDetail(db, sample.bookId)
  check('文件不存在时重新识别报错', failedMessage.length > 0, failedMessage.slice(0, 60))
  check(
    '失败后原值一字未改',
    afterFail?.title === snapshot?.title &&
      afterFail?.author === snapshot?.author &&
      afterFail?.chapterCount === snapshot?.chapterCount &&
      afterFail?.progress === snapshot?.progress,
    `${afterFail?.title} / ${afterFail?.chapterCount} 章 / 进度 ${afterFail?.progress}`
  )

  // ④ 根目录离线：抛 E_ROOT_OFFLINE，同样不写库
  writeFileSync(sample.file, CHAPTERS_3, 'utf8')
  const detached = `${sample.dir}-detached`
  renameSync(sample.dir, detached)
  await checkAllRoots({ reason: 'manual' })
  let offlineCode = ''
  try {
    await rematchBook(db, sample.bookId)
  } catch (err) {
    offlineCode = (err as { code?: string }).code ?? ''
  }
  renameSync(detached, sample.dir)
  await checkAllRoots({ reason: 'manual' })
  check('目录离线时拒绝重新识别（E_ROOT_OFFLINE）', offlineCode === 'E_ROOT_OFFLINE', offlineCode || '没有报错')

  // ---------------------------------------------------------------- 渲染层
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
      const waitFor = async (fn, timeout = 15000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await sleep(50)
        }
        return null
      }
      const out = { problems: [], text: {} }
      try {
        location.hash = '#/book/' + ${JSON.stringify(sample.bookId)}
        await waitFor(() => q('[data-detail-rematch]'))
        if (!q('[data-detail-rematch]')) {
          out.problems.push('详情页没有重新识别按钮')
          return JSON.stringify(out)
        }
        q('[data-detail-rematch]').click()
        await waitFor(() => qa('[data-toast]').some((el) => txt(el).includes('重新识别')), 20000)
        out.text.detailToast = qa('[data-toast]').map(txt).join(' | ')
        out.text.chapterCount = txt(q('[data-detail-chapter-count]'))

        // 右键菜单里的入口同样接上了（不再是「将在 M3-06 提供」）
        location.hash = '#/library'
        await waitFor(() => q('[data-book-grid] [data-book-id]'))
        const card = q('[data-book-id="' + ${JSON.stringify(sample.bookId)} + '"]')
        if (!card) {
          out.problems.push('书库列表里找不到样本')
          return JSON.stringify(out)
        }
        const rect = card.getBoundingClientRect()
        card.closest('[data-fav-on]').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10
        }))
        await waitFor(() => q('[data-menu-rematch]'))
        q('[data-menu-rematch]').click()
        await waitFor(() => qa('[data-toast]').some((el) => txt(el).includes('重新识别完成')), 20000)
        out.text.menuToast = qa('[data-toast]').map(txt).join(' | ')
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
  const out = JSON.parse(raw) as { problems: string[]; text: Record<string, string> }
  const text = out.text

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check('详情页重新识别给出结果提示', (text['detailToast'] ?? '').includes('重新识别完成'), text['detailToast'] ?? '')
  check('识别后详情页章数回到 3 章', text['chapterCount'] === '3 章', text['chapterCount'] ?? '')
  check('右键菜单的重新识别已接通', (text['menuToast'] ?? '').includes('重新识别完成'), text['menuToast'] ?? '')

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE REMATCH ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE REMATCH SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
