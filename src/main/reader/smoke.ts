/**
 * M2-01 内容通路自检。
 *
 * 覆盖 `reader:content` 的全部承诺：
 *   1. TXT 按字节区间读出正确正文（UTF-8 / GBK 各一本，中文不能是乱码）
 *   2. 段落切分与 HTML 转义（正文里的 `<script>` 不能被当标签注入）
 *   3. 首行标题去重（DTO 已有 title，正文不该重复一遍）
 *   4. hasPrev / hasNext 边界
 *   5. 五种失败语义：根目录离线 / 文件缺失 / 书不存在 / 章节不存在 / EPUB 未实现
 *   6. LRU 只留 5 章 + 读完预取下一章
 *   7. 章节切换耗时（主进程冷读 + 渲染层走 IPC 的暖读）
 *
 * 只用真实链路：真实文件 → startImport（Python 解析出 anchor/length/encoding）→ 读正文。
 * 直接往库里塞假 anchor 会让「偏移算错、编码记错」这类问题完全测不到。
 *
 * 只在 !app.isPackaged && CTEXT_READER_SMOKE=1 时执行（临时库 + 临时目录）。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { AppError } from '@shared/errors'
import { getDb } from '../db/connection'
import { coversDir } from '../ipc/import'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { clearReaderCache, getChapterContent, readerCacheKeys } from './content'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const CHAPTERS = 8
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 与 verify-reader.mjs 里 python 生成的 GBK 样本保持一致 */
const GBK_MARK = 'GBK编码正文'

/**
 * 8 章样本。刻意安排：
 *   - 第 1 章两段（中间空行）+ 一行字面 `<script>`（转义测试）
 *   - 第 2 章两行连排（不隔空行也要分成两段）
 *   - 其余章各一段（够 LRU 淘汰与预取）
 *
 * **正文行不能以「第N章」开头**：M1-04 的章节识别是行首正则，正文里
 * 写「第3章的正文」会被当成一个新章标题（实测把 8 章切成了 14 章）。
 */
function sampleText(): string {
  const lines = ['作者：测试作者', '简介：M2-01 读取样本。', '']
  lines.push(
    '第1章 起点',
    '正文第一段，含尖括号 <script>alert(1)</script> 需要被转义。',
    '',
    '第二段，中间隔了一个空行。',
    ''
  )
  lines.push('第2章 两段', '这是第二章第一段。', '这是第二章第二段。', '')
  for (let i = 3; i <= CHAPTERS; i += 1) {
    lines.push(`第${i}章 第${i}章标题`, `这里是第 ${i} 章的正文。`, '')
  }
  return lines.join('\n')
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

async function waitUntil(fn: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(20)
  }
  return fn()
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length * 0.9)] * 10) / 10
}

/** 返回空串表示「按预期报了某个错」，否则返回实际拿到的结果 */
async function expectCode(fn: () => Promise<unknown>, code: string): Promise<string> {
  try {
    await fn()
    return '没有报错'
  } catch (err) {
    if (err instanceof AppError) return err.code === code ? '' : `实际 ${err.code}`
    return `非 AppError：${String(err)}`
  }
}

const countParagraphs = (html: string): number => (html.match(/<p>/g) ?? []).length

export async function runReaderSmoke(win: BrowserWindow): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const dir = process.env['CTEXT_READER_DIR']
  if (!dir) {
    check('收到样本目录', false, '缺少 CTEXT_READER_DIR')
    return checks
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'utf8.txt'), sampleText(), 'utf8')

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  const db = getDb()
  const { taskId } = startImport(dir, {}, { coversDir: coversDir() })
  const phase = await waitForTask(taskId, 120_000)
  const snapshot = getTaskSnapshot(taskId)
  check(
    '样本导入成功（8 章 TXT + GBK TXT + EPUB）',
    phase === 'done' && (snapshot?.imported ?? 0) === 3 && (snapshot?.failedTotal ?? -1) === 0,
    `${phase} 新增 ${snapshot?.imported} 失败 ${snapshot?.failedTotal}`
  )

  const findBook = (relPath: string): { id: string; format: string; chapters: number } | undefined =>
    db
      .prepare('SELECT id, format, chapter_count AS chapters FROM books WHERE rel_path = ?')
      .get(relPath) as { id: string; format: string; chapters: number } | undefined

  const utf8 = findBook('utf8.txt')
  const gbk = findBook('gbk.txt')
  const epub = findBook('toc_volume.epub')
  if (!utf8 || !gbk || !epub) {
    check('三本书都已入库', false, `utf8=${!!utf8} gbk=${!!gbk} epub=${!!epub}`)
    return checks
  }
  check('三本书都已入库', true, `utf8=${utf8.chapters}章 gbk=${gbk.chapters}章 epub=${epub.chapters}章`)
  check(
    'TXT 章数与样本一致（正文行没有被误判成标题）',
    utf8.chapters === CHAPTERS && gbk.chapters === 3,
    `utf8=${utf8.chapters}（期望 ${CHAPTERS}） gbk=${gbk.chapters}（期望 3）`
  )

  // ------------------------------------------------------------ 正文正确性
  const first = await getChapterContent(db, utf8.id, 0)
  check('首章标题取自目录', first.title === '第1章 起点', first.title)
  check('首章正文非空且是段落 HTML', countParagraphs(first.html) === 2 && first.html.startsWith('<p>'), `${countParagraphs(first.html)} 段`)
  check('正文含预期文字', first.html.includes('正文第一段'), first.html.slice(0, 40))
  check(
    '正文里的尖括号被转义（不能注入标签）',
    first.html.includes('&lt;script&gt;') && !first.html.includes('<script>'),
    first.html.includes('<script>') ? '出现未转义的 <script>' : 'ok'
  )
  check('正文不重复章节标题行', !first.html.includes('第1章 起点'), first.html.slice(0, 60))
  check('首章 hasPrev=false / hasNext=true', !first.hasPrev && first.hasNext, `${first.hasPrev}/${first.hasNext}`)

  const second = await getChapterContent(db, utf8.id, 1)
  check('连排两行也分成两段', countParagraphs(second.html) === 2, `${countParagraphs(second.html)} 段`)

  const last = await getChapterContent(db, utf8.id, CHAPTERS - 1)
  check('末章 hasNext=false / hasPrev=true', last.hasPrev && !last.hasNext, `${last.hasPrev}/${last.hasNext}`)

  const gbkFirst = await getChapterContent(db, gbk.id, 0)
  check(
    'GBK 书按 books.encoding 解码（不是乱码）',
    gbkFirst.html.includes(GBK_MARK),
    gbkFirst.html.slice(0, 60) || '空'
  )

  // ------------------------------------------------------------ 缓存与预取
  clearReaderCache()
  await getChapterContent(db, utf8.id, 2)
  const prefetched = await waitUntil(() => readerCacheKeys().some((key) => key.includes(`:3:`)))
  check('读完当前章会预取下一章', prefetched, readerCacheKeys().join(' | ') || '缓存为空')

  const cachedNext = await getChapterContent(db, utf8.id, 3)
  check('预取的章节能直接命中', cachedNext.title === '第4章 第4章标题', cachedNext.title)

  clearReaderCache()
  for (let i = 0; i < CHAPTERS; i += 1) await getChapterContent(db, utf8.id, i)
  await sleep(200)
  const keys = readerCacheKeys()
  check('LRU 只保留 5 章', keys.length === 5, `缓存 ${keys.length} 条`)
  check(
    'LRU 淘汰的是最早读的章',
    !keys.some((key) => key.includes(`:0:`)) && keys.some((key) => key.includes(`:${CHAPTERS - 1}:`)),
    keys.map((key) => key.split(':')[1]).join(',')
  )

  // ------------------------------------------------------------ 耗时
  clearReaderCache()
  const coldStart = performance.now()
  await getChapterContent(db, utf8.id, 5)
  const coldMs = performance.now() - coldStart
  check('冷读一章 < 100ms', coldMs < 100, `${coldMs.toFixed(1)}ms`)

  const warm: number[] = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    await getChapterContent(db, utf8.id, 5)
    warm.push(performance.now() - t0)
  }
  const warmP95 = p95(warm)
  check('缓存命中的读取 P95 < 20ms', warmP95 < 20, `p95=${warmP95}ms`)

  // ------------------------------------------------------------ 失败语义
  clearReaderCache()
  db.prepare("UPDATE library_roots SET state = 'offline'").run()
  const offline = await expectCode(() => getChapterContent(db, utf8.id, 0), 'E_ROOT_OFFLINE')
  check('根目录离线 → E_ROOT_OFFLINE', offline === '', offline || 'E_ROOT_OFFLINE')
  db.prepare("UPDATE library_roots SET state = 'online'").run()

  const filePath = join(dir, 'utf8.txt')
  renameSync(filePath, `${filePath}.bak`)
  clearReaderCache()
  const missing = await expectCode(() => getChapterContent(db, utf8.id, 0), 'E_NOT_FOUND')
  check('文件缺失 → E_NOT_FOUND', missing === '', missing || 'E_NOT_FOUND')
  renameSync(`${filePath}.bak`, filePath)

  const noBook = await expectCode(() => getChapterContent(db, 'no-such-book', 0), 'E_NOT_FOUND')
  check('书不存在 → E_NOT_FOUND', noBook === '', noBook || 'E_NOT_FOUND')

  clearReaderCache()
  const noChapter = await expectCode(() => getChapterContent(db, utf8.id, 999), 'E_NOT_FOUND')
  check('章节不存在 → E_NOT_FOUND', noChapter === '', noChapter || 'E_NOT_FOUND')

  clearReaderCache()
  const epubError = await expectCode(() => getChapterContent(db, epub.id, 0), 'E_NOT_IMPLEMENTED')
  check('EPUB 正文 → E_NOT_IMPLEMENTED（属 M2-03）', epubError === '', epubError || 'E_NOT_IMPLEMENTED')

  // ------------------------------------------------------------ 渲染层走 IPC
  const script = String.raw`
    (async () => {
      const out = { timings: [], htmlLen: 0, title: '', badCode: '' }
      for (let i = 0; i < 10; i += 1) {
        const t0 = performance.now()
        const r = await window.api.invoke('reader:content', { bookId: '${utf8.id}', chapterIdx: i % 2 })
        out.timings.push(performance.now() - t0)
        if (!r.ok) return JSON.stringify({ error: r.error.code })
        out.htmlLen = r.data.html.length
        out.title = r.data.title
      }
      out.timings.sort((a, b) => a - b)
      out.p95 = Math.round(out.timings[9] * 10) / 10
      const bad = await window.api.invoke('reader:content', { bookId: 'no-such-book', chapterIdx: 0 })
      out.badCode = bad.ok ? '' : bad.error.code
      return JSON.stringify(out)
    })()
  `
  let raw: string
  try {
    raw = (await win.webContents.executeJavaScript(script)) as string
  } catch (err) {
    check('渲染层 IPC 调用', false, err instanceof Error ? err.message : String(err))
    return checks
  }
  const out = JSON.parse(raw) as { error?: string; p95?: number; htmlLen?: number; title?: string; badCode?: string }
  check('渲染层能通过 IPC 拿到正文', !out.error && (out.htmlLen ?? 0) > 0, out.error ?? `${out.htmlLen} 字符 / ${out.title}`)
  check('IPC 章节切换 P95 < 100ms', (out.p95 ?? 999) < 100, `p95=${out.p95}ms`)
  check('渲染层收到的错误码未经降级', out.badCode === 'E_NOT_FOUND', out.badCode || '空')

  for (const item of checks) {
    console.log(`SMOKE READER ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE READER SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
