/**
 * M2-04 分页自检：在**真实渲染层**里读一章、翻页、改字号、缩放窗口。
 *
 * 验收标准是「改字号/缩放窗口后页码不跳错位；1 章 3000 字重排 <16ms」。
 * 这两条只能在真 DOM + 真排版引擎里量：
 *   - 分页结果是 `column-fill` 排出来的，任何「离线算一下」的替代品都不作数；
 *   - 重排耗时包含强制布局（读 rect 触发的那次 layout），jsdom 里恒为 0。
 *
 * 「不跳错位」的判据不是「页号不变」（改字号后页号必然变），而是
 * **重排前记下的页首字符，重排后仍然在当前页里**——这正是进度只存
 * 「章 + 字符偏移」而不存页号的原因。
 *
 * 只在 `!app.isPackaged && CTEXT_READER_UI_SMOKE=1` 时执行，
 * 样本目录由 `scripts/verify-reader-ui.mjs` 建好并通过 CTEXT_READER_UI_DIR 传入。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { coversDir } from '../ipc/import'
import { getTaskSnapshot, startImport } from '../library/import-task'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

interface Snap {
  page: number
  pages: number
  offset: number
  total: number
}

const CHAPTER_CHARS = 3300
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 生成一章。**正文行不能以「第N章」或数字开头**：M1-04 的章节识别是行首正则，
 * 「第3章的正文」会被当成新章标题（M2-01 已经踩过一次，8 章被切成 14 章）。
 */
function chapterBody(label: string): string[] {
  const lines: string[] = []
  let total = 0
  for (let i = 0; total < CHAPTER_CHARS; i += 1) {
    const sentence =
      `山风从裂谷里灌上来，把火堆压得伏在地上，又把灰烬卷成一小股旋风。` +
      `这是${label}的第${i}段，用来把一章铺到三千字以上，好让分页真的分出好几页来。`
    lines.push(sentence.repeat(2))
    total += sentence.length * 2
  }
  return lines
}

function writeSample(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const lines = ['书名：分页样本', '作者：验收', '']
  lines.push('第1章 起风', ...chapterBody('第一章'), '')
  lines.push('第2章 落雪', ...chapterBody('第二章'), '')
  lines.push('第3章 尾声', '只有一小段，用来验证末章边界。', '')
  const path = join(dir, '分页样本.txt')
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
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

export async function runReaderUiSmoke(win: BrowserWindow, dir: string): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok: !!ok, detail })
  }

  // 窗口尺寸先固定：分页结果与视口大小强相关，不定死的话基线会随环境漂
  win.setSize(1280, 860)
  await sleep(300)

  const file = writeSample(dir)
  const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
  const phase = await waitForTask(taskId, 30_000)
  const row = getDb()
    .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('分页样本.txt') as { id: string; chapters: number } | undefined
  const epub = getDb()
    .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('toc_volume.epub') as { id: string; chapters: number } | undefined
  check('样本导入成功（3 章 TXT + 1 本 EPUB）', phase === 'done' && row?.chapters === 3 && !!epub, `${phase} 章数 ${row?.chapters} / epub ${epub?.chapters ?? '缺'} / ${file}`)
  if (!row) {
    emit(checks)
    return
  }

  // 验收探针要在组件挂载**之前**开：它只在 onMounted 时装一次
  await win.webContents.executeJavaScript('window.__CTEXT_SMOKE__ = true')
  await win.webContents.executeJavaScript(`location.hash = '#/reader/${row.id}'`)

  const opened = await waitUntil(async () => stateOf(win), 15_000)
  check('阅读器打开并出正文', !!opened && opened.total >= CHAPTER_CHARS, opened ? `total=${opened.total}` : '10s 内没拿到分页快照')
  if (!opened) {
    emit(checks)
    return
  }

  check('首屏就有多页（3000 字不是一屏能放下的）', opened.pages >= 3, `${opened.pages} 页 / total=${opened.total}`)

  // 需要人眼复核版式时设 CTEXT_READER_UI_SHOT=<png 路径>，把首屏截下来
  const shot = process.env['CTEXT_READER_UI_SHOT']
  if (shot) writeFileSync(shot, (await win.capturePage()).toPNG())
  check('页码显示 1 / N', opened.label === `1 / ${opened.pages}`, opened.label)
  check('章标题正确', opened.title.includes('第1章'), opened.title)

  // ---------------------------------------------------------------- 页码映射
  const offsets = (await run(win, `
    const probe = window.__ctextReader
    return JSON.stringify(Array.from({ length: probe.pages() }, (_, p) => probe.offsetAtPage(p)))
  `)) as string
  const pageOffsets = JSON.parse(offsets) as number[]
  const increasing = pageOffsets.every((value, i) => i === 0 || pageOffsets[i - 1]! < value)
  check(
    '页首偏移严格递增（每页都有新内容、没有空页）',
    increasing && pageOffsets[0] === 0 && pageOffsets[pageOffsets.length - 1]! < opened.total,
    `${pageOffsets.length} 页 / 首 ${pageOffsets[0]} 末 ${pageOffsets[pageOffsets.length - 1]} / total ${opened.total}`
  )

  // ---------------------------------------------------------------- 翻页
  const afterRight = await press(win, 'ArrowRight')
  check(
    '按 → 翻到第二页',
    afterRight.page === 1 && afterRight.label === `2 / ${opened.pages}` && afterRight.offset === pageOffsets[1],
    `page=${afterRight.page} offset=${afterRight.offset} label=${afterRight.label}`
  )

  const afterLeft = await press(win, 'ArrowLeft')
  check('按 ← 回到第一页', afterLeft.page === 0 && afterLeft.offset === 0, `page=${afterLeft.page} offset=${afterLeft.offset}`)

  // 首页再往前 → 换到上一章？当前已是第一章，什么都不该发生
  const atFirst = await press(win, 'ArrowLeft')
  check('第一章首页再往前不出错、不跳章', atFirst.page === 0 && atFirst.title.includes('第1章'), `${atFirst.title} page=${atFirst.page}`)

  // 翻到末页，再往前一格 → 进入下一章
  await run(win, `
    const probe = window.__ctextReader
    const snap = probe.snapshot()
    for (let i = snap.page; i < snap.pages - 1; i += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await sleep(60)
    }
    return true
  `)
  const nextChapter = await press(win, 'ArrowRight', 600)
  check(
    '本章末页再往后 → 进入下一章且回到首页',
    nextChapter.title.includes('第2章') && nextChapter.page === 0 && nextChapter.offset === 0,
    `${nextChapter.title} page=${nextChapter.page} offset=${nextChapter.offset}`
  )

  const prevChapter = await press(win, 'ArrowLeft', 600)
  check(
    '新章首页再往前 → 回到上一章且停在末页',
    prevChapter.title.includes('第1章') && prevChapter.page === prevChapter.pages - 1,
    `${prevChapter.title} page=${prevChapter.page + 1}/${prevChapter.pages}`
  )

  // ---------------------------------------------------------------- 改字号
  // 先走到第 3 页，让「当前页首字符」是个章中间的偏移（第 1 页恒为 0，测不出漂移）
  const before = await gotoPage(win, 2)
  check('跳到第 3 页（为改字号准备锚点）', before.page === 2 && before.offset > 0, `page=${before.page} offset=${before.offset}`)

  const fontSizeBefore = before.fontSize
  await run(win, `
    for (let i = 0; i < 3; i += 1) {
      q('[data-font-up]').click()
      await sleep(120)
    }
    return true
  `)
  await sleep(250)
  const zoomed = await stateOf(win)
  const zoomCheck = await run(win, `
    const probe = window.__ctextReader
    const anchor = ${before.offset}
    const page = probe.snapshot().page
    return JSON.stringify({
      page,
      pageStart: probe.offsetAtPage(page),
      anchorPage: probe.pageOfOffset(anchor)
    })
  `)
  const zoomInfo = JSON.parse(zoomCheck as string) as { page: number; pageStart: number; anchorPage: number }
  check(
    '改字号确实重排了（字号变大、页数变多）',
    zoomed.fontSize !== fontSizeBefore && zoomed.pages > before.pages,
    `${fontSizeBefore} → ${zoomed.fontSize}，${before.pages} → ${zoomed.pages} 页`
  )
  check(
    '改字号后位置不跳：锚点字符仍在当前页',
    zoomInfo.anchorPage === zoomed.page && zoomInfo.pageStart <= before.offset,
    `锚点 ${before.offset} 落在第 ${zoomInfo.anchorPage + 1} 页（当前第 ${zoomed.page + 1} 页，页首 ${zoomInfo.pageStart}）`
  )
  check(
    '改字号后页码与页数自洽',
    zoomed.label === `${zoomed.page + 1} / ${zoomed.pages}` && zoomed.page === zoomInfo.page,
    `${zoomed.label} / page=${zoomed.page}`
  )

  // ---------------------------------------------------------------- 窗口缩放
  const anchor2 = zoomed.offset
  win.setSize(980, 700)
  await sleep(450)
  const resized = await stateOf(win)
  const resizeCheck = JSON.parse(
    (await run(win, `
      const probe = window.__ctextReader
      const anchor = ${anchor2}
      const page = probe.snapshot().page
      return JSON.stringify({ page, pageStart: probe.offsetAtPage(page), anchorPage: probe.pageOfOffset(anchor) })
    `)) as string
  ) as { page: number; pageStart: number; anchorPage: number }
  check(
    '窗口缩放后位置不跳：锚点字符仍在当前页',
    resizeCheck.anchorPage === resized.page && resizeCheck.pageStart <= anchor2,
    `视口 ${JSON.stringify((await run(win, 'return JSON.stringify(window.__ctextReader.geometry())')) as string)}，锚点 ${anchor2} → 第 ${resizeCheck.anchorPage + 1} 页 / 当前第 ${resized.page + 1} 页`
  )
  check('缩放后页数随之变化（重排生效）', resized.pages !== zoomed.pages, `${zoomed.pages} → ${resized.pages} 页`)

  // ---------------------------------------------------------------- 重排耗时
  win.setSize(1280, 860)
  await sleep(400)
  const costs = (await run(win, `
    const probe = window.__ctextReader
    const samples = []
    for (let i = 0; i < 5; i += 1) samples.push(probe.reflowCost())
    return JSON.stringify(samples)
  `)) as string
  const samples = (JSON.parse(costs) as number[]).map((value) => Math.round(value * 100) / 100)
  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
  check(
    '3000 字一章重排 < 16ms（脏布局 + 强制重排，5 次取中位）',
    median < 16 && median > 0,
    `样本 ${samples.join(' / ')} ms，中位 ${median}ms`
  )

  // ---------------------------------------------------------------- 阅读模式（M2-05）
  // 先看 EPUB 的默认模式：此刻用户还没手动选过（store 里 mode = null），
  // 默认值只由格式决定，一旦点过切换就再也测不到这个分支了
  if (epub) {
    await run(win, `location.hash = '#/reader/${epub.id}'; return true`)
    const epubState = await waitUntil(async () => {
      const state = (await run(win, `
        const root = q('[data-reader]')
        const content = q('[data-scroll-content]')
        const text = content ? content.textContent.trim() : ''
        return JSON.stringify({
          mode: root ? root.dataset.readerMode : '',
          rendered: text.length,
          hasBody: text.includes('正文')
        })
      `)) as string
      const parsed = JSON.parse(state) as { mode: string; rendered: number; hasBody: boolean }
      return parsed.mode === 'scroll' && parsed.hasBody ? parsed : null
    }, 10_000)
    check(
      'EPUB 默认以滚动模式打开且渲染出正文',
      epubState?.mode === 'scroll' && epubState.hasBody === true,
      epubState ? `mode=${epubState.mode} 正文 ${epubState.rendered} 字` : '10s 内没进滚动模式'
    )

    await run(win, `location.hash = '#/reader/${row.id}'; return true`)
    await waitUntil(async () => ((await stateOf(win)) as SnapshotState | null), 10_000)
  }

  const beforeSwitch = await stateOf(win)
  const restoreMode = (await run(win, `return q('[data-reader]').dataset.readerMode`)) as string
  check('TXT 默认分页模式', restoreMode === 'paged', restoreMode)

  await run(win, `q('[data-mode="scroll"]').click(); await sleep(400); return true`)
  const inScroll = await scrollStateOf(win)
  check(
    '切到滚动：视图换成滚动容器，且顶部字符就是刚才的页首字符',
    inScroll.mode === 'scroll' && Math.abs(inScroll.offset - beforeSwitch.offset) <= 2,
    `mode=${inScroll.mode} 滚动顶部 ${inScroll.offset} / 分页页首 ${beforeSwitch.offset}`
  )

  if (shot) writeFileSync(shot.replace(/\.png$/i, '-scroll.png'), (await win.capturePage()).toPNG())

  // 单行 + 整屏两种滚动都要能走（↑/↓ 与 PgDn 的步长不同）
  await run(win, `
    for (let i = 0; i < 10; i += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await sleep(40)
    }
    return true
  `)
  await sleep(200)
  const byLine = await scrollStateOf(win)
  await run(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })); return true`)
  await sleep(250)
  const byPage = await scrollStateOf(win)
  check(
    '滚动模式：↓ 单行走、PgDn 整屏走',
    byLine.offset > inScroll.offset && byPage.offset > byLine.offset && byPage.scrollTop > byLine.scrollTop,
    `顶部字符 ${inScroll.offset} → ${byLine.offset}（↓×10）→ ${byPage.offset}（PgDn）`
  )

  const anchor = byPage.offset
  await run(win, `q('[data-mode="paged"]').click(); await sleep(400); return true`)
  const backToPaged = await stateOf(win)
  const mapped = JSON.parse(
    (await run(win, `
      const probe = window.__ctextReader
      const page = probe.snapshot().page
      return JSON.stringify({ page, pageStart: probe.offsetAtPage(page), anchorPage: probe.pageOfOffset(${anchor}) })
    `)) as string
  ) as { page: number; pageStart: number; anchorPage: number }
  check(
    '切回分页：落在包含该字符的那一页（不是回到第 1 页）',
    mapped.anchorPage === backToPaged.page && mapped.pageStart <= anchor && backToPaged.page > 0,
    `滚动顶部 ${anchor} → 第 ${mapped.anchorPage + 1}/${backToPaged.pages} 页（页首 ${mapped.pageStart}）`
  )

  await run(win, `q('[data-mode="scroll"]').click(); await sleep(400); return true`)
  const backToScroll = await scrollStateOf(win)
  check(
    '再切回滚动：顶部字符与切走时一致',
    Math.abs(backToScroll.offset - anchor) <= 2,
    `锚点 ${anchor} → 顶部 ${backToScroll.offset}`
  )

  // ---------------------------------------------------------------- 退出
  await run(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200); return true`)
  const hash = (await run(win, 'return location.hash')) as string
  check('按 Esc 回到书库', hash.startsWith('#/library'), hash)

  emit(checks)
}

/** 每次注入都重新声明这几个助手（executeJavaScript 每次是独立作用域） */
function run(win: BrowserWindow, body: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
    const q = (s) => document.querySelector(s)
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
}

type SnapshotState = Snap & { title: string; label: string; page: number; fontSize: string }

/**
 * 主进程侧的轮询等待。渲染层里那份 `waitFor` 只能在页面内跑，
 * 而「阅读器有没有打开」要跨进程反复问，所以这里再写一个。
 */
async function waitUntil<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(100)
  }
  return null
}

async function stateOf(win: BrowserWindow): Promise<SnapshotState> {
  return (await run(win, `
    const probe = window.__ctextReader
    const snap = probe ? probe.snapshot() : null
    const content = q('[data-page-content]')
    return snap ? {
      ...snap,
      title: txt(q('[data-reader-title]')),
      label: txt(q('[data-reader-page]')),
      page: content ? Number(content.dataset.page) : -1,
      fontSize: content ? getComputedStyle(content).fontSize : ''
    } : null
  `)) as SnapshotState
}

/** 滚动模式的状态：模式标记、顶部字符偏移、scrollTop */
async function scrollStateOf(win: BrowserWindow): Promise<{ mode: string; offset: number; scrollTop: number }> {
  const raw = (await run(win, `
    const root = q('[data-reader]')
    const probe = window.__ctextScroll
    return JSON.stringify({
      mode: root ? root.dataset.readerMode : '',
      offset: probe ? probe.offsetAtTop() : -1,
      scrollTop: probe ? probe.scrollTop() : -1
    })
  `)) as string
  return JSON.parse(raw) as { mode: string; offset: number; scrollTop: number }
}

/** 按一次键并等重排/换章落定 */
async function press(win: BrowserWindow, key: string, wait = 300): Promise<SnapshotState> {
  await run(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); return true`)
  await sleep(wait)
  return stateOf(win)
}

async function gotoPage(win: BrowserWindow, page: number): Promise<SnapshotState> {
  // 两个方向都要处理：上一个用例可能把当前位置留在末页
  await run(win, `
    const probe = window.__ctextReader
    const key = (dir) => window.dispatchEvent(new KeyboardEvent('keydown', { key: dir, bubbles: true }))
    let guard = 0
    while (probe.snapshot().page < ${page} && guard++ < 200) {
      key('ArrowRight')
      await sleep(80)
    }
    while (probe.snapshot().page > ${page} && guard++ < 200) {
      key('ArrowLeft')
      await sleep(80)
    }
    return true
  `)
  await sleep(200)
  return stateOf(win)
}

function emit(checks: Check[]): void {
  for (const item of checks) {
    console.log(`SMOKE READERUI ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE READERUI SUMMARY ${checks.length - failed}/${checks.length}`)
  app.exit(failed === 0 ? 0 : 1)
}
