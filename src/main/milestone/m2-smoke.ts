/**
 * M2 出口验收（阅读器）。
 *
 * 四条出口标准里，`verify:reader:big` 已经覆盖「200MB 不 OOM」，这里补另外三条：
 *   1. **20MB TXT 首屏 ≤1.5s**：从路由切换到正文出现在屏幕上（含 IPC + Python 解析 + 排版）
 *   2. **五套主题视觉验收**：不是肉眼看截图，而是算 **WCAG 对比度**——正文与背景
 *      低于 4.5:1 就算「看得见也读不清」，那是可测量的缺陷
 *   3. **进度与书签在拔插硬盘后无损**：拔盘（改目录名）→ 恢复 → 章、页、划线都还在
 *
 * 只在 `!app.isPackaged && CTEXT_M2_SMOKE=1` 时执行（临时库 + 临时目录）。
 */
import { closeSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { coversDir } from '../ipc/import'
import { checkAllRoots } from '../library/roots-monitor'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { loadProgress } from '../db/repositories/progress'
import { listBookmarks } from '../db/repositories/bookmarks'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const BIG_CHAPTERS = 200
/** 每章 ≈ 100KB，200 章 ≈ 20MB —— 对齐出口标准里的「20MB TXT」 */
const BODY_REPEAT = 1120
const FIRST_PAINT_BUDGET = 1500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function writeNovel(path: string): void {
  const body = '这是一段用于出口验收的正文内容，写得足够长以便让每章接近一百 KB。'.repeat(BODY_REPEAT)
  const fd = openSync(path, 'w')
  try {
    for (let i = 1; i <= BIG_CHAPTERS; i += 1) {
      writeSync(fd, `第${i}章 出口验收第${i}章\n${body}\n\n`)
    }
  } finally {
    closeSync(fd)
  }
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
    await sleep(50)
  }
  return null
}

/** WCAG 相对亮度，输入 `rgb(r, g, b)` */
function luminance(color: string): number {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!match) return 0
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

export async function runM2Smoke(win: BrowserWindow, dir: string): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok: !!ok, detail })
    console.log(`SMOKE M2 ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  }

  win.webContents.setBackgroundThrottling(false)
  win.setSize(1280, 860)
  await sleep(300)

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

  // ---------------------------------------------------------------- 样本
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '出口验收.txt')
  writeNovel(file)
  const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
  const phase = await waitForTask(taskId, 120_000)
  const book = getDb()
    .prepare('SELECT id, chapter_count AS chapters, size_bytes FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('出口验收.txt') as { id: string; chapters: number; size_bytes: number } | undefined
  check(
    '20MB / 200 章样本导入成功',
    phase === 'done' && book?.chapters === BIG_CHAPTERS && (book?.size_bytes ?? 0) > 19 * 1024 * 1024,
    `${phase} / ${book?.chapters} 章 / ${((book?.size_bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`
  )
  if (!book) {
    report(checks)
    return
  }

  await win.webContents.executeJavaScript('window.__CTEXT_SMOKE__ = true')

  // ---------------------------------------------------------------- ① 首屏 ≤1.5s
  const started = Date.now()
  await run(`location.hash = '#/reader/${book.id}'; return true`)
  const firstPaint = await waitUntil(async () => {
    const value = (await run(`
      const el = q('[data-page-content]')
      if (!el) return 0
      const text = el.textContent.trim()
      return text.length > 100 ? Date.now() : 0
    `)) as number
    return value > 0 ? value : null
  }, 10_000)
  const paintMs = firstPaint ? Date.now() - started : -1
  check(
    `20MB 首屏 ≤ ${FIRST_PAINT_BUDGET}ms`,
    paintMs > 0 && paintMs <= FIRST_PAINT_BUDGET,
    `${paintMs}ms（含 IPC + 正文读取 + 分页排版）`
  )

  // ---------------------------------------------------------------- ② 五套主题对比度
  await run(`q('[data-reader-settings]').click(); await sleep(300); return true`)
  const themes: { value: string; label: string }[] = [
    { value: 'day', label: '日间' },
    { value: 'night', label: '夜间' },
    { value: 'eye', label: '护眼绿' },
    { value: 'paper', label: '纸张黄' },
    { value: 'system', label: '跟随系统' }
  ]
  for (const theme of themes) {
    await run(`
      const button = q('[data-theme="${theme.value}"]')
      if (button) button.click()
      await sleep(350)
      return true
    `)
    const colors = JSON.parse(
      (await run(`
        const stage = q('[data-reader-stage]')
        const style = getComputedStyle(stage)
        return JSON.stringify({ fg: style.color, bg: style.backgroundColor })
      `)) as string
    ) as { fg: string; bg: string }
    const ratio = contrastRatio(colors.fg, colors.bg)
    check(
      `${theme.label}主题对比度 ≥ 4.5:1`,
      ratio >= 4.5,
      `${ratio}:1（文字 ${colors.fg} / 背景 ${colors.bg}）`
    )
  }
  await run(`q('[data-theme="day"]').click(); await sleep(250); q('[data-settings-close]').click(); await sleep(200); return true`)

  // ---------------------------------------------------------------- ③ 拔插硬盘后进度与书签无损
  // 先走到第 3 章第 2 页，划一条线，等进度落库
  // 每章 100KB ≈ 30 页，靠方向键翻到第 3 章要按近百次；这里用 URL 直达（与目录跳转同一条路径），
  // 再往后翻一页，让「章内偏移」也不是 0
  await run(`location.hash = '#/reader/${book.id}?chapter=2'; return true`)
  // 等**标题变成第 3 章**，不能只等「正文有字」：换章期间上一章的正文还挂在 DOM 里，
  // 「有字」立刻就成立，接下来的翻页会翻在上一章上，然后被新章加载覆盖掉（偏移恒为 0，
  // 「位置不变」的断言就成了同义反复）。
  const chapterReady = await waitUntil(async () => {
    const ready = (await run(`
      const content = q('[data-page-content]')
      return txt(q('[data-reader-title]')).includes('第3章') && content && content.textContent.trim().length > 100 ? 1 : 0
    `)) as number
    return ready === 1 ? true : null
  }, 10_000)
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true`)
  // 页码必须真的动了：只断言「前后偏移相等」在偏移恒为 0 时也成立，验不出东西
  const pageTurned = await waitUntil(async () => {
    const page = (await run(`return window.__ctextReader ? window.__ctextReader.snapshot().page : -1`)) as number
    return page > 0 ? page : null
  }, 3000)
  await run(`
    const content = q('[data-page-content]')
    const paragraph = content.querySelector('p')
    // 从**当前页首字符**开始划：这样划线的偏移与进度的偏移都不是 0，
    // 「恢复后位置不变」才是有内容可比的断言
    const start = window.__ctextReader.snapshot().offset
    const node = paragraph.firstChild
    const range = document.createRange()
    range.setStart(node, Math.min(start, node.length - 1))
    range.setEnd(node, Math.min(start + 12, node.length))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    content.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await sleep(200)
    const button = q('[data-highlight]')
    if (button) button.click()
    await sleep(1400)
    return true
  `)
  const marksBefore = JSON.parse(
    (await run(`return JSON.stringify(window.__ctextReader.marks())`)) as string
  ) as { id: string; offset: number; endOffset: number; text: string }[]
  const progressBefore = loadProgress(getDb(), book.id)
  const bookmarksBefore = listBookmarks(getDb(), book.id)
  const titleBefore = (await run(`return txt(q('[data-reader-title]'))`)) as string
  check(
    '拔盘前：已翻到第 3 章第 2 页并划线',
    !!progressBefore &&
      marksBefore.length === 1 &&
      bookmarksBefore.length === 1 &&
      titleBefore.includes('第3章') &&
      chapterReady === true &&
      (pageTurned ?? 0) > 0 &&
      (progressBefore?.offset ?? 0) > 0 &&
      (marksBefore[0]?.offset ?? 0) > 0,
    `章 ${(progressBefore?.chapterIdx ?? -1) + 1} / 第 ${(pageTurned ?? 0) + 1} 页 / 偏移 ${progressBefore?.offset} / 划线从 ${marksBefore[0]?.offset} 起「${marksBefore[0]?.text ?? '无'}」`
  )

  // 拔盘：整个书库目录改名 + 让主进程复核一次根目录状态
  const detached = `${dir}-detached`
  renameSync(dir, detached)
  await checkAllRoots({ reason: 'manual' })
  await run(`location.hash = '#/library'; return true`)
  await sleep(200)
  await run(`location.hash = '#/reader/${book.id}'; return true`)
  const offlinePanel = await waitUntil(async () => {
    const raw = (await run(`
      const title = q('[data-empty-title]')
      return JSON.stringify({ title: title ? txt(title) : '', root: !!q('[data-reader-relocate-root]') })
    `)) as string
    const state = JSON.parse(raw) as { title: string; root: boolean }
    return state.title.includes('离线') ? state : null
  }, 10_000)
  check(
    '拔盘后给出离线提示与恢复入口',
    offlinePanel?.title.includes('离线') === true && offlinePanel.root === true,
    offlinePanel ? `「${offlinePanel.title}」` : '10s 内没有离页面板'
  )

  // 插回硬盘（目录改回来），点「重新指定目录」恢复
  renameSync(detached, dir)
  const originalDialog = dialog.showOpenDialog
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
  await run(`q('[data-reader-relocate-root]').click(); return true`)

  const restored = await waitUntil(async () => {
    const raw = (await run(`
      const panel = q('[data-reader-panel]')
      const content = q('[data-page-content]')
      const marks = window.__ctextReader ? window.__ctextReader.marks() : []
      return JSON.stringify({
        panel: !!panel,
        text: content ? content.textContent.trim().length : 0,
        title: txt(q('[data-reader-title]')),
        marks
      })
    `)) as string
    const state = JSON.parse(raw) as { panel: boolean; text: number; title: string; marks: unknown[] }
    return !state.panel && state.text > 100 ? state : null
  }, 15_000)
  dialog.showOpenDialog = originalDialog

  // 内容一到就断言页码会读到「还没排完」的中间态，等两帧让重排落定
  await sleep(400)
  const pageAfter = (await run(`return window.__ctextReader ? window.__ctextReader.snapshot().page : -1`)) as number
  const progressAfter = loadProgress(getDb(), book.id)
  const marksAfter = (restored?.marks ?? []) as { offset: number; endOffset: number; text: string }[]
  check(
    '插回硬盘后位置不变（章 + 页 + 偏移）',
    !!progressAfter &&
      progressAfter.chapterIdx === progressBefore?.chapterIdx &&
      progressAfter.offset === progressBefore?.offset &&
      pageAfter === pageTurned &&
      restored?.title.includes('第3章') === true,
    `章 ${(progressAfter?.chapterIdx ?? -1) + 1} / 第 ${pageAfter + 1} 页 / 偏移 ${progressAfter?.offset}（拔盘前第 ${(pageTurned ?? 0) + 1} 页 / 偏移 ${progressBefore?.offset}）`
  )
  check(
    '插回硬盘后划线仍在原位',
    marksAfter.length === 1 &&
      marksAfter[0]!.offset === marksBefore[0]!.offset &&
      marksAfter[0]!.endOffset === marksBefore[0]!.endOffset &&
      marksAfter[0]!.text === marksBefore[0]!.text,
    marksAfter.length ? `偏移 ${marksAfter[0]!.offset}-${marksAfter[0]!.endOffset}「${marksAfter[0]!.text}」` : '划线丢了'
  )

  report(checks)
}

function report(checks: Check[]): void {
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE M2 SUMMARY ${checks.length - failed}/${checks.length}`)
  app.exit(failed === 0 && checks.length > 0 ? 0 : 1)
}
