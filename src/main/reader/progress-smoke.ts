/**
 * M2-08 进度自检。**两段进程，中间一次强杀**：
 *   - write 段：真实导入 → 打开阅读器 → 翻到第 2 章第 3 页 → 等满 1s 防抖 → 打印库里存的
 *     位置，然后**挂住不退出**，由验收脚本 `SIGKILL` 掉（不是正常关闭）。
 *   - read 段：同一个 userData 重新启动 → 从书库点进阅读器（URL 不带章号）→ 断言恢复到的
 *     章与页和强杀前**完全一致**。
 *
 * 为什么要真的强杀：`beforeunload` 里兜底保存看着很稳，但用户真正的退出方式是
 * 关窗口失败、任务管理器结束进程、蓝屏重启——这些都不会触发它。位置必须靠
 * 「停下来 1s 内已经落库」，而不是靠退出钩子。
 *
 * 只在 `!app.isPackaged && CTEXT_PROGRESS_SMOKE=1` 时执行。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { coversDir } from '../ipc/import'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { loadProgress } from '../db/repositories/progress'
import { patchSettings } from '../db/repositories/settings'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const CHAPTERS = 3
const CHAPTER_CHARS = 3300
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 正文行不能以「第N章」或数字开头（M1-04 的章节识别是行首正则） */
function writeSample(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const lines = ['书名：进度样本', '']
  for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
    lines.push(`第${chapter}章 第${chapter}章标题`)
    let total = 0
    let index = 0
    while (total < CHAPTER_CHARS) {
      const sentence = `山风从裂谷里灌上来，把火堆压得伏在地上，又把灰烬卷成一小股旋风。这是第${chapter}章的第${index}段，铺到三千字以上好让一章分出好几页。`
      lines.push(sentence.repeat(2))
      total += sentence.length * 2
      index += 1
    }
    lines.push('')
  }
  writeFileSync(join(dir, '进度样本.txt'), lines.join('\n'), 'utf8')
}

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

async function waitUntil<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(100)
  }
  return null
}

export async function runProgressSmoke(
  win: BrowserWindow,
  dir: string,
  phase: 'write' | 'read'
): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok: !!ok, detail })
    console.log(`SMOKE PROGRESS ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  }
  win.webContents.setBackgroundThrottling(false)

  const run = async (body: string): Promise<unknown> =>
    win.webContents.executeJavaScript(`(async () => {
      const q = (s) => document.querySelector(s)
      const qa = (s) => Array.from(document.querySelectorAll(s))
      const txt = (el) => (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim()
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout = 8000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await sleep(50)
        }
        return null
      }
${body}
    })()`)

  const title = async (): Promise<string> => (await run(`return txt(q('[data-reader-title]'))`)) as string
  const pageNow = async (): Promise<number> =>
    (await run(`const el = q('[data-page-content]'); return el ? Number(el.dataset.page) : -1`)) as number
  const totalPages = async (): Promise<number> =>
    (await run(`const el = q('[data-page-content]'); return el ? Number(el.dataset.pages) : -1`)) as number

  const findBook = (): { id: string; chapters: number } | undefined =>
    getDb()
      .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
      .get('进度样本.txt') as { id: string; chapters: number } | undefined

  // ---------------------------------------------------------------- write
  if (phase === 'write') {
    writeSample(dir)
    const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
    const imported = await waitForTask(taskId, 30_000)
    const book = findBook()
    check(
      '样本导入成功（3 章，各 3300 字）',
      imported === 'done' && book?.chapters === CHAPTERS,
      `${imported} / ${book?.chapters} 章`
    )
    if (!book) {
      report(checks)
      app.exit(1)
      return
    }

    await win.webContents.executeJavaScript('window.__CTEXT_SMOKE__ = true')
    await run(`location.hash = '#/reader/${book.id}'; return true`)
    const ready = await waitUntil(async () => {
      const probe = (await run(`return window.__ctextReader ? 1 : 0`)) as number
      return probe === 1 ? true : null
    }, 15_000)
    check('阅读器打开', ready === true, ready ? '分页探针就绪' : '15s 内没有分页探针')
    if (!ready) {
      report(checks)
      app.exit(1)
      return
    }

    // 翻到「第 2 章 第 3 页」：跨章 + 章内偏移都非零，才检验得出恢复是否精确
    let reached = false
    for (let step = 0; step < 40; step += 1) {
      const currentTitle = await title()
      const page = await pageNow()
      if (currentTitle.includes('第2章') && page === 2) {
        reached = true
        break
      }
      await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true`)
      await sleep(140)
    }
    const pages = await totalPages()
    check('翻到第 2 章第 3 页', reached, `当前「${await title()}」第 ${(await pageNow()) + 1}/${pages} 页`)

    // 等满 1s 防抖：这就是「停下来之后位置一定已经落库」
    await sleep(1300)
    const saved = loadProgress(getDb(), book.id)
    const pageAfter = await pageNow()
    console.log(
      `PROGRESS SAVED chapter=${saved?.chapterIdx ?? -1} offset=${saved?.offset ?? -1} page=${pageAfter} percent=${(saved?.percent ?? -1).toFixed(4)}`
    )
    check(
      '1s 防抖后进度已落库',
      !!saved && saved.chapterIdx === 1 && saved.offset > 0 && saved.percent > 0,
      saved ? `章 ${saved.chapterIdx + 1} / 偏移 ${saved.offset} / ${(saved.percent * 100).toFixed(1)}%` : '库里没有进度'
    )

    report(checks)
    // **不退出**：由验收脚本 SIGKILL，模拟「强杀进程」
    console.log('PROGRESS READY')
    await new Promise(() => undefined)
    return
  }

  // ---------------------------------------------------------------- read
  const book = findBook()
  if (!book) {
    check('重开后书还在', false, '库里没有 进度样本.txt')
    report(checks)
    return
  }

  await win.webContents.executeJavaScript('window.__CTEXT_SMOKE__ = true')
  // 关键：URL **不带 chapter**，模拟「从书库点进去」
  await run(`location.hash = '#/library'; return true`)
  await sleep(200)
  await run(`location.hash = '#/reader/${book.id}'; return true`)
  const restored = await waitUntil(async () => {
    const hasProbe = (await run(`return window.__ctextReader ? 1 : 0`)) as number
    if (hasProbe !== 1) return null
    const page = await pageNow()
    return page >= 0 ? page : null
  }, 15_000)

  const saved = loadProgress(getDb(), book.id)
  const restoredTitle = await title()
  const restoredPage = await pageNow()
  const snapshot = JSON.parse(
    (await run(`return JSON.stringify(window.__ctextReader.snapshot())`)) as string
  ) as { page: number; pages: number; offset: number; total: number }

  console.log(
    `PROGRESS RESTORED chapter=${saved?.chapterIdx ?? -1} offset=${snapshot.offset} page=${restoredPage}`
  )
  check(
    '强杀重启后仍能恢复（章 + 页）',
    restored !== null &&
      restoredTitle.includes('第2章') &&
      restoredPage === 2 &&
      saved?.chapterIdx === 1,
    `「${restoredTitle}」第 ${restoredPage + 1}/${snapshot.pages} 页`
  )
  check(
    '恢复的章内偏移与落库值完全一致（误差 0）',
    !!saved && snapshot.offset === saved.offset,
    `落库 ${saved?.offset} / 恢复 ${snapshot.offset}`
  )

  const bookRow = getDb()
    .prepare('SELECT progress, read_state, last_read_at FROM books WHERE id = ?')
    .get(book.id) as { progress: number; read_state: string; last_read_at: number | null } | undefined
  check(
    'books 表同步了进度与「在读」状态',
    !!bookRow && bookRow.progress > 0.2 && bookRow.read_state === 'reading' && (bookRow.last_read_at ?? 0) > 0,
    `progress=${bookRow?.progress.toFixed(3)} state=${bookRow?.read_state}`
  )

  // rememberProgress 关掉之后，再进来应该从第 1 章开始
  patchSettings(getDb(), { reader: { rememberProgress: false } })
  await run(`location.hash = '#/library'; return true`)
  await sleep(200)
  await run(`location.hash = '#/reader/${book.id}'; return true`)
  const fresh = await waitUntil(async () => {
    const hasProbe = (await run(`return window.__ctextReader ? 1 : 0`)) as number
    return hasProbe === 1 ? true : null
  }, 15_000)
  await sleep(400)
  check(
    '关掉「记住阅读位置」后从第 1 章开始',
    fresh === true && (await title()).includes('第1章') && (await pageNow()) === 0,
    `「${await title()}」第 ${(await pageNow()) + 1} 页`
  )

  report(checks)
  const failed = checks.filter((item) => !item.ok).length
  app.exit(failed === 0 && checks.length > 0 ? 0 : 1)
}

function report(checks: Check[]): void {
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE PROGRESS SUMMARY ${checks.length - failed}/${checks.length}`)
  // write 段要挂住等强杀，所以这里不调用 app.exit；read 段由调用方决定
}
