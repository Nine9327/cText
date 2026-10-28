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
import { loadSettings } from '../db/repositories/settings'
import { exportBookmarks, listBookmarks } from '../db/repositories/bookmarks'

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

/** 4 卷 × 300 章 = 1204 条目录项（卷也是章节，占用 idx） */
const TOC_VOLUMES = 4
const TOC_PER_VOLUME = 300

/**
 * 千章样本。目录项数要真的上千，才能验「虚拟滚动下 DOM 行数恒定」——
 * 用 30 章的数据测出来的行数上限没有意义。
 */
function writeThousand(dir: string): string {
  const lines = ['书名：千章样本', '']
  let chapter = 0
  for (let volume = 1; volume <= TOC_VOLUMES; volume += 1) {
    lines.push(`第${volume}卷 卷${volume}`, `本卷共 ${TOC_PER_VOLUME} 章。`)
    for (let i = 0; i < TOC_PER_VOLUME; i += 1) {
      chapter += 1
      lines.push(`第${chapter}章 第${chapter}章标题`, `这里是第${chapter}章的正文。`, '')
    }
  }
  const path = join(dir, '千章样本.txt')
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
  // 逐条打印而不是最后统一打印：这套自检跑 25+ 条，卡住时「没有任何输出」
  // 会让人完全看不出停在哪一步（第一次跑千章目录时就是这么超时的）
  const check: CheckFn = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail })
    console.log(`SMOKE READERUI ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  }

  // 整段包在 try 里：抛异常时如果没人接住，进程会一直挂着等超时，
  // 表现成「没有任何断言输出」——那是最难查的一种失败。
  try {
    await scenario(win, dir, check)
  } catch (err) {
    const message = err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err)
    check('自检脚本执行', false, message.slice(0, 300))
  }
  emit(checks)
}

type CheckFn = (name: string, ok: boolean, detail?: string) => void

async function scenario(win: BrowserWindow, dir: string, check: CheckFn): Promise<void> {
  // 关掉后台节流：窗口一旦被别的窗口遮住，Chromium 会把 rAF 降到每秒一两次，
  // 于是「改字号后重排」被拖到几秒、翻页也不生效。自动化测试必须关掉它，
  // 否则同一份代码在「窗口在前台」和「被遮住」时跑出两种结果。
  win.webContents.setBackgroundThrottling(false)

  // 窗口尺寸先固定：分页结果与视口大小强相关，不定死的话基线会随环境漂
  win.setSize(1280, 860)
  await sleep(300)

  writeSample(dir)
  writeThousand(dir)
  const taskId = startImport(dir, { registerAsRoot: true }, { coversDir: coversDir() }).taskId
  const phase = await waitForTask(taskId, 30_000)
  const row = getDb()
    .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('分页样本.txt') as { id: string; chapters: number } | undefined
  const epub = getDb()
    .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('toc_volume.epub') as { id: string; chapters: number } | undefined
  const thousand = getDb()
    .prepare('SELECT id, chapter_count AS chapters FROM books WHERE rel_path = ? AND deleted_at IS NULL')
    .get('千章样本.txt') as { id: string; chapters: number } | undefined
  check(
    '样本导入成功（3 章 TXT + 千章 TXT + 1 本 EPUB）',
    phase === 'done' && row?.chapters === 3 && !!epub && thousand?.chapters === TOC_VOLUMES * (TOC_PER_VOLUME + 1),
    `${phase} 章数 ${row?.chapters} / 千章 ${thousand?.chapters ?? '缺'} / epub ${epub?.chapters ?? '缺'}`
  )
  if (!row) {
    check('样本可用', false, '库里没有找到 分页样本.txt')
    return
  }

  // 验收探针要在组件挂载**之前**开：它只在 onMounted 时装一次
  await win.webContents.executeJavaScript('window.__CTEXT_SMOKE__ = true')
  await win.webContents.executeJavaScript(`location.hash = '#/reader/${row.id}'`)

  const opened = await waitUntil(async () => stateOf(win), 15_000)
  check('阅读器打开并出正文', !!opened && opened.total >= CHAPTER_CHARS, opened ? `total=${opened.total}` : '10s 内没拿到分页快照')
  if (!opened) {
    check('阅读器可打开', false, '拿不到分页快照')
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
  // 字号控件在排版面板里（M2-07）：面板是覆盖层，不改变正文容器宽度，
  // 所以这一段的「改字号 → 重排 → 位置不跳」结论不受面板开合影响
  await run(win, `
    q('[data-reader-settings]').click()
    await sleep(250)
    for (let i = 0; i < 3; i += 1) {
      q('[data-font-up]').click()
      await sleep(120)
    }
    q('[data-settings-close]').click()
    await sleep(250)
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
  // 页数不一定变：3000 字这个量级，18→21px 有可能刚好还是同样的页数。
  // 「重排生效」的判据是**页边界变了**（页数或当前页首偏移），而不是页数一定增加。
  check(
    '改字号确实重排了（字号变了，且页数或页边界随之改变）',
    zoomed.fontSize !== fontSizeBefore && (zoomed.pages !== before.pages || zoomInfo.pageStart !== before.offset),
    `${fontSizeBefore} → ${zoomed.fontSize}，${before.pages} → ${zoomed.pages} 页，页首 ${before.offset} → ${zoomInfo.pageStart}`
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
  const geometryBefore = (await run(win, 'return JSON.stringify(window.__ctextReader.geometry())')) as string
  win.setSize(980, 700)
  // 等视口真的变了再断言：setSize 不是同步生效的（窗口动画、系统负载都会推迟），
  // 固定 sleep 450ms 在忙的时候会读到旧尺寸，把「没缩放」误判成「位置跳了」
  await waitUntil(async () => {
    const now = (await run(win, 'return JSON.stringify(window.__ctextReader.geometry())')) as string
    return now !== geometryBefore ? true : null
  }, 5000)
  await sleep(250)
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

  // ---------------------------------------------------------------- 目录（M2-06）
  if (thousand) {
    await run(win, `location.hash = '#/reader/${thousand.id}'; return true`)
    await waitUntil(async () => ((await readerTitle(win)).includes('千章样本') ? true : null), 10_000)
    // 首章是「第1卷」这个卷标题，正文只有一行；这里顺带确认正文真的渲染出来了。
    // 标题在 `library:get` 返回时就变了，正文要等 `reader:content`——所以要轮询正文，
    // 只等标题会读到「容器还不存在」的那一帧。
    const firstBody = await waitUntil(async () => {
      const text = (await run(win, `
        const el = q('[data-scroll-content]') || q('[data-page-content]')
        return el ? el.textContent.trim() : ''
      `)) as string
      return text.length > 0 ? text : null
    }, 8000)
    check('千章样本首章渲染出正文', !!firstBody, firstBody ? firstBody.slice(0, 30) : '8s 内正文仍为空')

    await run(win, `q('[data-reader-toc]').click(); return true`)

    const tocOpenState = await waitUntil(async () => {
      const state = await tocStateOf(win)
      return state.total > 0 ? state : null
    }, 10_000)
    check(
      '千章目录一次加载完整（4 卷 + 1200 章）',
      tocOpenState?.chapters === TOC_VOLUMES * (TOC_PER_VOLUME + 1),
      tocOpenState ? `${tocOpenState.chapters} 章 / 可见 ${tocOpenState.total} 行` : '10s 内抽屉没打开'
    )
    check(
      '虚拟滚动：千章目录的 DOM 行数保持在一屏量级',
      (tocOpenState?.rows ?? 999) < 60,
      `DOM ${tocOpenState?.rows} 行 / 逻辑 ${tocOpenState?.total} 行`
    )

    if (shot) writeFileSync(shot.replace(/\.png$/i, '-toc.png'), (await win.capturePage()).toPNG())

    // 滚到底：DOM 行数不能跟着总数涨，且能滚到最后一条
    // 滚到底后轮询：虚拟滚动是 scroll 事件驱动的一帧更新，固定 sleep 在忙时会读到旧窗口
    const bottom = (await (async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const snapshot = (await run(win, `
          const box = q('[data-toc-total]')
          if (box.scrollTop !== box.scrollHeight) box.scrollTop = box.scrollHeight
          await sleep(120)
          const rows = qa('[data-toc-row]')
          const last = rows[rows.length - 1]
          return JSON.stringify({
            rows: rows.length,
            last: last ? Number(last.dataset.tocRow) : -1,
            lastText: last ? txt(last) : ''
          })
        `)) as string
        const parsed = JSON.parse(snapshot) as { rows: number; last: number; lastText: string }
        if (parsed.last >= TOC_VOLUMES * (TOC_PER_VOLUME + 1) - 1) return snapshot
      }
      return (await run(win, `return JSON.stringify({ rows: 0, last: -1, lastText: '' })`)) as string
    })())
    const bottomState = JSON.parse(bottom as string) as { rows: number; last: number; lastText: string }
    check(
      '滚到目录末尾：DOM 行数仍受限，且能到最后一条',
      bottomState.rows < 60 && bottomState.last === TOC_VOLUMES * (TOC_PER_VOLUME + 1) - 1,
      `DOM ${bottomState.rows} 行，末尾 idx=${bottomState.last}（${bottomState.lastText.slice(0, 14)}）`
    )

    // 折叠第一卷：可见行数应减少 300，且耗时在 100ms 内（含一帧）
    const collapse = await run(win, `
      const box = q('[data-toc-total]')
      box.scrollTop = 0
      await sleep(120)
      const toggle = q('[data-toc-toggle]')
      const before = Number(q('[data-toc-total]').dataset.tocTotal)
      const started = performance.now()
      toggle.click()
      await new Promise((r) => requestAnimationFrame(r))
      const cost = performance.now() - started
      await sleep(120)
      return JSON.stringify({
        before,
        after: Number(q('[data-toc-total]').dataset.tocTotal),
        cost,
        rows: qa('[data-toc-row]').length
      })
    `)
    const collapsed = JSON.parse(collapse as string) as {
      before: number
      after: number
      cost: number
      rows: number
    }
    check(
      '折叠一卷：可见行数减少 300 行且 DOM 仍然有界',
      collapsed.after === collapsed.before - TOC_PER_VOLUME && collapsed.rows < 60,
      `${collapsed.before} → ${collapsed.after} 行，DOM ${collapsed.rows} 行`
    )
    check(
      '折叠耗时 < 100ms（含一帧渲染）',
      collapsed.cost < 100,
      `${collapsed.cost.toFixed(1)}ms`
    )

    const expand = await run(win, `
      q('[data-toc-toggle]').click()
      await sleep(150)
      return Number(q('[data-toc-total]').dataset.tocTotal)
    `)
    check('再展开恢复到全部 1204 行', Number(expand) === TOC_VOLUMES * (TOC_PER_VOLUME + 1), `${expand} 行`)

    // 跳转：滚到第 600 行附近点一条
    const jump = await run(win, `
      const box = q('[data-toc-total]')
      box.scrollTop = 580 * 30
      await sleep(200)
      const row = qa('[data-toc-row]').find((el) => Number(el.dataset.tocRow) >= 600)
      if (!row) return JSON.stringify({ ok: false })
      const idx = Number(row.dataset.tocRow)
      const title = txt(row)
      row.click()
      await sleep(600)
      return JSON.stringify({ ok: true, idx, title })
    `)
    const jumped = JSON.parse(jump as string) as { ok: boolean; idx: number; title: string }
    const afterTitle = await readerTitle(win)
    const drawerClosed = !(await run(win, `return !!q('[data-toc]')`))
    check(
      '点目录跳转：抽屉关闭、正文切到该章',
      jumped.ok && drawerClosed && afterTitle.includes(jumped.title.slice(0, 8)),
      jumped.ok ? `跳到「${jumped.title}」→ 当前「${afterTitle}」` : '没找到可点的行'
    )

    const margins = JSON.parse(
      (await run(win, `
        const stage = q('[data-reader-stage]')
        const content = q('[data-scroll-content]') || q('[data-page-content]')
        const para = content ? content.querySelector('p') : null
        const stageBox = stage.getBoundingClientRect()
        return JSON.stringify({
          stageLeft: Math.round(stageBox.left),
          stagePad: getComputedStyle(stage).paddingLeft,
          contentLeft: content ? Math.round(content.getBoundingClientRect().left) : -1,
          paraLeft: para ? Math.round(para.getBoundingClientRect().left) : -1,
          fontSize: content ? getComputedStyle(content).fontSize : ''
        })
      `)) as string
    ) as { stageLeft: number; stagePad: string; contentLeft: number; paraLeft: number; fontSize: string }
    check('正文左边距 = 排版设置的页边距', margins.contentLeft >= 64, JSON.stringify(margins))

    if (shot) writeFileSync(shot.replace(/\.png$/i, '-jump.png'), (await win.capturePage()).toPNG())

    // 重新打开：当前章要高亮
    await run(win, `q('[data-reader-toc]').click(); await sleep(300); return true`)
    const active = (await run(win, `
      const el = q('[data-toc-active]')
      return el ? Number(el.dataset.tocRow) : -1
    `)) as number
    check('重开目录：当前章高亮且自动滚到可视区', active === jumped.idx, `高亮 idx=${active} / 跳转 idx=${jumped.idx}`)
    await run(win, `q('[data-toc-close]').click(); await sleep(200); return true`)
  }

  // ---------------------------------------------------------------- 书签与划线（M2-09）
  await run(win, `location.hash = '#/reader/${row.id}'; return true`)
  await waitUntil(async () => ((await readerTitle(win)).includes('分页样本') ? true : null), 10_000)
  await run(win, `q('[data-mode="paged"]').click(); await sleep(300); return true`)

  // 用真实的 Range + mouseup 走一遍选区链路（拖拽本身由浏览器负责，这里测的是我们的换算）
  const selected = (await run(win, `
    const content = q('[data-page-content]')
    const paragraph = content.querySelector('p')
    const textNode = paragraph.firstChild
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 14)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    content.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await sleep(150)
    const bar = q('[data-selection-bar]')
    return JSON.stringify({
      bar: !!bar,
      text: bar ? txt(q('[data-selection-text]')) : '',
      expected: content.textContent.slice(0, 14)
    })
  `)) as string
  const picked = JSON.parse(selected) as { bar: boolean; text: string; expected: string }
  check(
    '选中正文后出现操作条，且选区文字与正文一致',
    picked.bar && picked.text === picked.expected && picked.expected.length === 14,
    `「${picked.text}」/ 期望「${picked.expected}」`
  )

  await run(win, `q('[data-highlight]').click(); await sleep(400); return true`)
  const marks = JSON.parse(
    (await run(win, `return JSON.stringify(window.__ctextReader.marks())`)) as string
  ) as { id: string; offset: number; endOffset: number; text: string }[]
  check(
    '划线立刻画到正文上（mark 覆盖同一段文字）',
    marks.length === 1 && marks[0]!.text === picked.expected && marks[0]!.offset === 0 && marks[0]!.endOffset === 14,
    marks.length ? `偏移 ${marks[0]!.offset}-${marks[0]!.endOffset}「${marks[0]!.text}」` : '没有 mark'
  )

  await run(win, `q('[data-reader-notes]').click(); await sleep(250); return true`)
  const listText = (await run(win, `
    return JSON.stringify({
      count: txt(q('[data-notes-count]')),
      first: txt(q('[data-note-text]'))
    })
  `)) as string
  const listed = JSON.parse(listText) as { count: string; first: string }
  check(
    '侧栏列出划线（条数与摘录一致）',
    listed.count === '1' && listed.first === picked.expected,
    `计数 ${listed.count} / 摘录「${listed.first}」`
  )
  await run(win, `q('[data-notes-close]').click(); await sleep(200); return true`)

  // 改字号：划线必须还在同一段文字上，且偏移不变（「重排后位置不漂」）
  await run(win, `
    q('[data-reader-settings]').click()
    await sleep(250)
    q('[data-font-up]').click()
    await sleep(200)
    q('[data-font-up]').click()
    await sleep(300)
    q('[data-settings-close]').click()
    await sleep(300)
    return true
  `)
  const marksAfter = JSON.parse(
    (await run(win, `return JSON.stringify(window.__ctextReader.marks())`)) as string
  ) as { id: string; offset: number; endOffset: number; text: string }[]
  check(
    '改字号重排后划线位置不漂（偏移与文字都不变）',
    marksAfter.length === 1 &&
      marksAfter[0]!.offset === marks[0]!.offset &&
      marksAfter[0]!.endOffset === marks[0]!.endOffset &&
      marksAfter[0]!.text === marks[0]!.text,
    marksAfter.length ? `偏移 ${marksAfter[0]!.offset}-${marksAfter[0]!.endOffset}「${marksAfter[0]!.text}」` : 'mark 丢了'
  )

  // 备注
  await run(win, `
    q('[data-reader-notes]').click()
    await sleep(250)
    q('[data-note-edit]').click()
    await sleep(250)
    const input = q('[data-note-input]')
    input.value = '这段写得好'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    q('[data-note-save]').click()
    await sleep(350)
    return true
  `)
  if (shot) writeFileSync(shot.replace(/\.png$/i, '-notes.png'), (await win.capturePage()).toPNG())

  const noteText = (await run(win, `const el = q('[data-note-note]'); return el ? txt(el) : ''`)) as string
  check('备注保存后显示在列表里', noteText === '这段写得好', noteText || '没有备注')

  // Ctrl+D：当前位置加纯书签
  await run(win, `
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
    await sleep(400)
    return true
  `)
  const afterBookmark = (await run(win, `return txt(q('[data-notes-count]'))`)) as string
  check('Ctrl+D 在当前位置加书签', afterBookmark === '2', `计数 ${afterBookmark}`)

  // 跳到第 2 章，再从列表点回第 1 章的那条
  await run(win, `q('[data-notes-close]').click(); await sleep(200); return true`)
  await run(win, `
    for (let i = 0; i < 12; i += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await sleep(120)
      if (txt(q('[data-reader-title]')).includes('第2章')) break
    }
    await sleep(200)
    return true
  `)
  const atChapter2 = (await readerTitle(win)).includes('第2章')
  await run(win, `
    q('[data-reader-notes]').click()
    await sleep(250)
    const first = q('[data-note-id]')
    if (first) first.querySelector('[data-note-text]').click()
    await sleep(600)
    return true
  `)
  const jumpedBack = await readerTitle(win)
  const panelClosed = (await run(win, `return !!q('[data-notes-panel]')`)) === false
  check(
    '从列表跳转回第 1 章（面板关闭）',
    atChapter2 && jumpedBack.includes('第1章') && panelClosed,
    `${atChapter2 ? '先到第 2 章' : '没翻到第 2 章'} → 跳转后「${jumpedBack}」`
  )

  // 导出内容（对话框那三行不自动化，验的是排版逻辑）
  const markdown = exportBookmarks(getDb(), row.id, '分页样本')
  check(
    '导出 Markdown 含摘录与备注',
    markdown.includes(picked.expected) && markdown.includes('这段写得好') && markdown.startsWith('# 《分页样本》'),
    markdown.split('\n').slice(0, 3).join(' / ')
  )
  const stored = listBookmarks(getDb(), row.id)
  check(
    '划线落库为「章 + 起止偏移」两个整数',
    stored.length === 2 &&
      stored.some((item) => item.kind === 'highlight' && item.offset === 0 && item.endOffset === 14) &&
      stored.some((item) => item.kind === 'bookmark' && item.endOffset === null),
    stored.map((item) => `${item.kind}@${item.offset}-${item.endOffset ?? '·'}`).join(' / ')
  )

  // ---------------------------------------------------------------- 排版与主题（M2-07）
  await run(win, `location.hash = '#/reader/${row.id}'; return true`)
  await waitUntil(async () => ((await readerTitle(win)).includes('分页样本') ? true : null), 10_000)
  // 上一节把模式切成了滚动，这里切回分页：本节的断言都基于分页容器
  await run(win, `q('[data-mode="paged"]').click(); await sleep(300); return true`)
  await run(win, `q('[data-reader-settings]').click(); await sleep(250); return true`)
  check(
    '排版面板可打开',
    (await run(win, `return !!q('[data-settings-panel]')`)) === true,
    '未出现 [data-settings-panel]'
  )

  // 面板里的控件不能溢出窗口：主题色块有 5 个，最容易在窄面板里被挤出去
  const overflow = JSON.parse(
    (await run(win, `
      const aside = q('[data-settings-panel] aside')
      const buttons = qa('[data-theme]')
      const inner = window.innerWidth
      return JSON.stringify({
        inner,
        asideRight: Math.round(aside.getBoundingClientRect().right),
        asideWidth: Math.round(aside.getBoundingClientRect().width),
        worstRight: Math.round(Math.max(...buttons.map((b) => b.getBoundingClientRect().right))),
        lastLabel: buttons.length ? txt(buttons[buttons.length - 1]) : ''
      })
    `)) as string
  ) as { inner: number; asideRight: number; asideWidth: number; worstRight: number; lastLabel: string }
  check(
    '排版面板不溢出窗口（5 个主题色块都完整可见）',
    overflow.asideRight <= overflow.inner && overflow.worstRight <= overflow.inner,
    `窗口 ${overflow.inner} / 面板宽 ${overflow.asideWidth} 右缘 ${overflow.asideRight} / 最后一个色块右缘 ${overflow.worstRight}`
  )

  const stageBg = async (): Promise<string> =>
    (await run(win, `return getComputedStyle(q('[data-reader-stage]')).backgroundColor`)) as string

  await run(win, `q('[data-theme="night"]').click(); await sleep(300); return true`)
  const nightBg = await stageBg()
  check('主题实时生效：夜间背景变深', nightBg === 'rgb(23, 24, 27)', nightBg)

  // 上一节改过字号（18 → 21）并已落库，这里按「相对 +1px」断言，不写死绝对值
  const fontBefore = (await run(win, `return parseFloat(getComputedStyle(q('[data-page-content]')).fontSize)`)) as number
  await run(win, `q('[data-font-up]').click(); await sleep(250); return true`)
  const zoomedFont = (await run(win, `return parseFloat(getComputedStyle(q('[data-page-content]')).fontSize` + `)`)) as number
  check(
    '字号实时生效（点一次 +1px）',
    zoomedFont === fontBefore + 1,
    `${fontBefore}px → ${zoomedFont}px`
  )

  // 行距用 range 驱动：值 + input 事件就是用户拖动滑块的等价路径
  await run(win, `
    const el = q('[data-range="lineHeight"]')
    el.value = '2.2'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    return true
  `)
  const lineHeightPx = (await run(win, `
    const el = q('[data-page-content]')
    return parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize)
  `)) as number
  check('行距实时生效：1.9 → 2.2 倍', Math.abs(lineHeightPx - 2.2) < 0.05, `${lineHeightPx.toFixed(2)} 倍`)

  await run(win, `
    const el = q('[data-range="margin"]')
    el.value = '40'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    return true
  `)
  const marginLeft = (await run(win, `return Math.round(q('[data-page-content]').getBoundingClientRect().left)`)) as number
  check('页边距实时生效：64 → 40px', marginLeft === 40, `左边距 ${marginLeft}px`)

  // 自定义色叠加在主题之上
  await run(win, `
    const el = q('[data-custom-bg]')
    el.value = '#102030'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(250)
    return true
  `)
  const customBg = await stageBg()
  await run(win, `q('[data-custom-clear]').click(); await sleep(250); return true`)
  const clearedBg = await stageBg()
  check(
    '自定义背景色覆盖主题，且能一键回到主题色',
    customBg === 'rgb(16, 32, 48)' && clearedBg === nightBg,
    `${customBg} → ${clearedBg}`
  )

  // 落库：等过 300ms 的节流窗口，再由主进程直接读库（不经过渲染层的任何缓存）
  await sleep(600)
  const saved = loadSettings(getDb()).reader
  check(
    '设置已落库（字号/行距/页边距/主题）',
    saved.fontSize === zoomedFont &&
      Math.abs(saved.lineHeight - 2.2) < 0.001 &&
      saved.margin === 40 &&
      saved.theme === 'night',
    `fontSize=${saved.fontSize}（期望 ${zoomedFont}） lineHeight=${saved.lineHeight} margin=${saved.margin} theme=${saved.theme}`
  )

  if (shot) writeFileSync(shot.replace(/\.png$/i, '-night.png'), (await win.capturePage()).toPNG())

  // 重新加载渲染层 ≈ 重开应用：设置要能自己回来（这一段没有探针，只看 DOM）
  //
  // 必须等导航结束再注入脚本：页面正在换帧时 executeJavaScript 可能既不 resolve
  // 也不 reject，整段自检就挂在那里（表现成「跑到一半没有任何输出」）。
  await new Promise<void>((resolve) => {
    const done = (): void => resolve()
    win.webContents.once('did-finish-load', done)
    win.webContents.reload()
    setTimeout(done, 10_000)
  })
  const restored = await waitUntil(async () => {
    const state = (await run(win, `
      const content = q('[data-page-content]') || q('[data-scroll-content]')
      const stage = q('[data-reader-stage]')
      if (!content || !stage) return null
      const text = txt(q('[data-reader-title]'))
      if (!text.includes('分页样本')) return null
      return JSON.stringify({
        font: getComputedStyle(content).fontSize,
        bg: getComputedStyle(stage).backgroundColor,
        left: Math.round(content.getBoundingClientRect().left)
      })
    `)) as string
    return state ? (JSON.parse(state) as { font: string; bg: string; left: number }) : null
  }, 15_000)
  check(
    '重启后设置自动恢复（字号/主题/页边距）',
    restored?.font === `${zoomedFont}px` && restored.bg === 'rgb(23, 24, 27)' && restored.left === 40,
    restored ? `font=${restored.font}（期望 ${zoomedFont}px） bg=${restored.bg} left=${restored.left}px` : '15s 内没重新进入阅读器'
  )

  // ---------------------------------------------------------------- 退出
  await run(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200); return true`)
  const hash = (await run(win, 'return location.hash')) as string
  check('按 Esc 回到书库', hash.startsWith('#/library'), hash)
}

/** 每次注入都重新声明这几个助手（executeJavaScript 每次是独立作用域） */
function run(win: BrowserWindow, body: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {
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

/**
 * 只读阅读器标题。TOC 这一段跑在**滚动模式**下（上一节的模式切换留下的状态），
 * 此时 `__ctextReader` 探针不存在——凡是要断言「当前是哪一章」的地方都不能走分页快照。
 */
async function readerTitle(win: BrowserWindow): Promise<string> {
  return (await run(win, `return txt(q('[data-reader-title]'))`)) as string
}

/** 目录抽屉的状态：章节数、逻辑行数、当前 DOM 行数 */
async function tocStateOf(
  win: BrowserWindow
): Promise<{ chapters: number; total: number; rows: number }> {
  const raw = (await run(win, `
    const box = q('[data-toc-total]')
    return JSON.stringify({
      chapters: box ? Number(box.dataset.tocChapters) : -1,
      total: box ? Number(box.dataset.tocTotal) : -1,
      rows: qa('[data-toc-row]').length
    })
  `)) as string
  return JSON.parse(raw) as { chapters: number; total: number; rows: number }
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
  // 每条在 check() 里已经打印过了，这里只补总结与退出码
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE READERUI SUMMARY ${checks.length - failed}/${checks.length}`)
  app.exit(failed === 0 ? 0 : 1)
}
