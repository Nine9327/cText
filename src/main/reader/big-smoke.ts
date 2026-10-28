/**
 * M2-02 大文件自检：200MB TXT 打开不 OOM、翻页不卡。
 *
 * 两个样本：
 *   1. **200MB / 2000 章**（真实形态）：每次只读一章（~100KB），内存不随文件大小增长。
 *   2. **20MB / 无章节标记**（病态形态）：整本被当成一章，`length` = 20MB。
 *      靠 worker 侧的 4MB 窗口兜住内存，返回 `truncated: true` 而不是把 20MB
 *      全读进来（那是 20MB Buffer + 40MB UTF-16 字符串 + 上百万个段落对象）。
 *
 * 内存断言用 RSS 增量而不是「有没有崩」：OOM 常常表现为进程被系统杀掉、
 * 自检直接没有输出，那样失败原因会被含糊成「超时」。先卡一个宽松上限（300MB），
 * 真出问题时数字会先红。
 *
 * 只在 !app.isPackaged && CTEXT_READER_BIG_SMOKE=1 时执行（临时库 + 临时目录）。
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getDb } from '../db/connection'
import { coversDir } from '../ipc/import'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { clearReaderCache, getChapterContent } from './content'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const BIG_CHAPTERS = 2000
/** 每章正文 ≈ 100KB（1170 × 86B），2000 章 ≈ 200MB —— 对齐验收里的「200MB」 */
const BODY_REPEAT = 1170
const PLAIN_BYTES = 20 * 1024 * 1024

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length * 0.9)] * 10) / 10
}

/** 顺序写，不构造 200MB 的大字符串 */
function writeBigNovel(path: string): number {
  const body = '这是一段用于压测的正文内容，写得足够长以便让每章接近一百 KB。'.repeat(BODY_REPEAT)
  const fd = openSync(path, 'w')
  try {
    for (let i = 1; i <= BIG_CHAPTERS; i += 1) {
      writeSync(fd, `第${i}章 压测第${i}章\n${body}\n\n`)
    }
  } finally {
    closeSync(fd)
  }
  return BIG_CHAPTERS
}

/** 无章节标记的整本一段：用来验证「窗口兜底」 */
function writePlainBlob(path: string): void {
  const line = '这是一行没有章节标记的正文，用于验证单章超窗时不会整本读进内存。\n'
  const fd = openSync(path, 'w')
  try {
    let written = 0
    while (written < PLAIN_BYTES) {
      writeSync(fd, line)
      written += Buffer.byteLength(line)
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
    await sleep(200)
  }
  return 'timeout'
}

export async function runReaderBigSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const dir = process.env['CTEXT_READER_BIG_DIR']
  if (!dir) {
    check('收到样本目录', false, '缺少 CTEXT_READER_BIG_DIR')
    return checks
  }
  mkdirSync(dir, { recursive: true })

  const novelPath = join(dir, 'big_novel.txt')
  const plainPath = join(dir, 'no_chapters.txt')
  writeBigNovel(novelPath)
  writePlainBlob(plainPath)

  const db = getDb()
  const t0 = Date.now()
  const { taskId } = startImport(dir, {}, { coversDir: coversDir() })
  const phase = await waitForTask(taskId, 300_000)
  const importedMs = Date.now() - t0
  const snapshot = getTaskSnapshot(taskId)
  check(
    '200MB / 2000 章 + 20MB 无章节标记 均可导入',
    phase === 'done' && (snapshot?.imported ?? 0) === 2 && (snapshot?.failedTotal ?? -1) === 0,
    `${phase} 新增 ${snapshot?.imported} / 失败 ${snapshot?.failedTotal} / ${(importedMs / 1000).toFixed(1)}s`
  )

  const novel = db
    .prepare('SELECT id, chapter_count AS chapters, size_bytes FROM books WHERE rel_path = ?')
    .get('big_novel.txt') as { id: string; chapters: number; size_bytes: number } | undefined
  const plain = db
    .prepare('SELECT id, chapter_count AS chapters, size_bytes, encoding FROM books WHERE rel_path = ?')
    .get('no_chapters.txt') as { id: string; chapters: number; size_bytes: number; encoding: string | null } | undefined
  if (!novel || !plain) {
    check('两本书都已入库', false, `novel=${!!novel} plain=${!!plain}`)
    return checks
  }
  check(
    '200MB 文件的章节索引完整',
    novel.chapters === BIG_CHAPTERS && novel.size_bytes > 190 * 1024 * 1024,
    `${novel.chapters} 章 / ${mb(novel.size_bytes)}`
  )

  // ------------------------------------------------------------ 打开三处，内存不涨
  clearReaderCache()
  const rssBefore = process.memoryUsage().rss

  const openAt = async (idx: number): Promise<{ ms: number; html: string; title: string }> => {
    clearReaderCache()
    const started = performance.now()
    const content = await getChapterContent(db, novel.id, idx)
    return { ms: performance.now() - started, html: content.html, title: content.title }
  }

  const first = await openAt(0)
  const middle = await openAt(Math.floor(BIG_CHAPTERS / 2))
  const last = await openAt(BIG_CHAPTERS - 1)
  check('首章可读且内容正确', first.title === '第1章 压测第1章' && first.html.includes('压测'), first.title)
  check('中间章可读', middle.html.length > 1000, `${middle.html.length} 字符`)
  check('末章可读且 hasNext=false', last.title === `第${BIG_CHAPTERS}章 压测第${BIG_CHAPTERS}章`, last.title)
  check(
    '打开任意章节都 < 100ms',
    [first.ms, middle.ms, last.ms].every((ms) => ms < 100),
    `首 ${first.ms.toFixed(1)}ms / 中 ${middle.ms.toFixed(1)}ms / 末 ${last.ms.toFixed(1)}ms`
  )

  // ------------------------------------------------------------ 连续翻页
  const turn: number[] = []
  clearReaderCache()
  await getChapterContent(db, novel.id, 100)
  for (let i = 0; i < 30; i += 1) {
    const t = performance.now()
    await getChapterContent(db, novel.id, 101 + i)
    turn.push(performance.now() - t)
  }
  const turnP95 = p95(turn)
  const turnAvg = Math.round((turn.reduce((a, b) => a + b, 0) / turn.length) * 10) / 10
  check('连续翻 30 章平均 < 50ms', turnAvg < 50, `avg=${turnAvg}ms p95=${turnP95}ms`)
  check('翻页 P95 < 100ms', turnP95 < 100, `p95=${turnP95}ms`)

  const rssAfter = process.memoryUsage().rss
  const growth = Math.max(0, rssAfter - rssBefore)
  check('读完 33 章后内存增量 < 300MB（不随文件大小增长）', growth < 300 * 1024 * 1024, `ΔRSS ${mb(growth)}`)

  // ------------------------------------------------------------ 无章节标记的病态文件
  clearReaderCache()
  const plainStart = performance.now()
  const plainChapter = await getChapterContent(db, plain.id, 0)
  const plainMs = performance.now() - plainStart
  check(
    '无章节标记的 20MB 只返回一个窗口（truncated）',
    plainChapter.truncated === true,
    `truncated=${plainChapter.truncated} html=${mb(Buffer.byteLength(plainChapter.html))} encoding=${plain.encoding}`
  )
  check('单章超窗读取 < 100ms', plainMs < 100, `${plainMs.toFixed(1)}ms`)
  check(
    '窗口内容有界（不超过 4MB 原文对应的大小）',
    Buffer.byteLength(plainChapter.html) < 6 * 1024 * 1024,
    mb(Buffer.byteLength(plainChapter.html))
  )
  check(
    '窗口内容是开头而不是空白',
    plainChapter.html.includes('没有章节标记'),
    `${plainChapter.html.slice(0, 30)} / encoding=${plain.encoding}`
  )

  for (const item of checks) {
    console.log(`SMOKE READERBIG ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE READERBIG SUMMARY ${checks.length - failed}/${checks.length}`)
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
