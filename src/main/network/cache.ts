/**
 * 网络书正文磁盘缓存（M4-10）。
 *
 * 布局：`<root>/<bookId>/<chapterIdx>-<urlHash8>.html`，`root` 默认
 * `userData/cache/sources`（产品文档 §2.7 的口径）。
 *
 * 五处刻意的选择：
 *   1. **文件名里带章节 URL 的哈希**。`chapters.anchor` 对网络书存的是 URL，
 *      目录刷新后第 5 个 `idx` 可能已经指向另一章——只按 `idx` 命名会把 A 章的正文
 *      当成 B 章返回。带哈希后「URL 变了 = 文件名变了」，旧文件自然读不到，
 *      再由 `pruneBook` 清掉。
 *   2. **存 HTML 而不是纯文本**。正文在内存里已经是 `<p>` 段落 HTML（抓取层统一转换），
 *      落盘存原文，读回来不用再走一遍转换；扩展名用 `.html` 而不是产品文档写的 `.txt`，
 *      因为内容确实是 HTML，装成纯文本只会让后来的人误以为可以直接 `readFile` 展示。
 *   3. **TTL 只决定「要不要重抓」，不决定「删不删」**。过期的章节仍然留在盘上：
 *      断网时它就是唯一能读的东西（服务层在抓取失败时回退到过期缓存）。
 *      真正的删除只有两条路——用户点清理，或目录刷新后被 `pruneBook` 清掉。
 *   4. **写入走 `tmp + rename`**。半截文件比没有文件更糟：阅读器会拿到一段截断的正文，
 *      而且看起来「缓存命中了」。rename 在同一分区上是原子的。
 *   5. **路径全部由 bookId 现拼并校验**。`bookId` 来自 IPC，虽然上游是 ULID，
 *      但这一层不能假设调用方一定传了合法值——一个 `../..` 就能写到 userData 外面。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 缓存根目录（绝对路径）。测试用临时目录，生产用 `userData/cache/sources` */
export interface CacheEnv {
  root: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** bookId 是 ULID；这个白名单同时挡住了 `..`、分隔符和空串 */
const BOOK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 只认自己写出来的文件名，别的（`.tmp` 残留、用户塞进来的东西）不参与统计 */
const FILE_RE = /^(\d+)-[a-f0-9]{8}\.html$/

export interface CacheEntry {
  html: string
  bytes: number
  /** 文件写入时间（ms） */
  mtimeMs: number
  ageMs: number
  /** 超过 TTL：可以先用，但联网时应该重抓 */
  stale: boolean
}

export interface CacheClearResult {
  files: number
  bytes: number
}

export interface CacheBookUsage {
  bookId: string
  files: number
  bytes: number
}

export interface CacheStats {
  files: number
  bytes: number
  /** 其中超过 TTL 的部分（联网时会重抓，断网时仍可读） */
  expiredFiles: number
  expiredBytes: number
  /** 按占用空间降序 */
  books: CacheBookUsage[]
}

/**
 * 章节文件路径。
 *
 * 单独导出是因为 `pruneBook` 的调用方要自己算「哪些文件该留」——
 * 两边各拼一次名字，迟早会有一边改了而另一边没改。
 */
export function chapterFile(env: CacheEnv, bookId: string, idx: number, url: string): string {
  return join(bookDir(env, bookId), chapterFileName(idx, url))
}

export function chapterFileName(idx: number, url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
  return `${idx}-${hash}.html`
}

export function bookDir(env: CacheEnv, bookId: string): string {
  if (!BOOK_ID_RE.test(bookId)) throw new Error(`非法的书籍 ID：${bookId.slice(0, 32)}`)
  return join(env.root, bookId)
}

/**
 * 读一章。
 *
 * 返回 `stale: true` 的条目仍然是**有效内容**：调用方先当未命中去重抓，
 * 抓失败再拿它兜底（断网可读的验收项就落在这条路上）。
 */
export async function readChapter(
  env: CacheEnv,
  bookId: string,
  idx: number,
  url: string,
  ttlDays: number,
  now: number = Date.now()
): Promise<CacheEntry | null> {
  const file = chapterFile(env, bookId, idx, url)
  try {
    const [html, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    if (html === '') return null
    const ageMs = Math.max(0, now - info.mtimeMs)
    return {
      html,
      bytes: Buffer.byteLength(html, 'utf8'),
      mtimeMs: info.mtimeMs,
      ageMs,
      stale: ageMs > ttlDays * DAY_MS
    }
  } catch {
    // ENOENT 是常态（没缓存过）；权限/坏盘也按「没缓存」处理，让上层正常抓取
    return null
  }
}

/** 写一章。父目录不存在的场景只有「第一次缓存这本书」，`recursive` 一并解决 */
export async function writeChapter(
  env: CacheEnv,
  bookId: string,
  idx: number,
  url: string,
  html: string
): Promise<string> {
  const dir = bookDir(env, bookId)
  const file = join(dir, chapterFileName(idx, url))
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, html, 'utf8')
  await rename(tmp, file)
  return file
}

/**
 * 删掉这本书里不在 `keep` 中的文件（目录刷新后调用）。
 *
 * 返回删除的文件数。目录没变时 keep 与盘上完全一致，这里等于一次空转。
 */
export async function pruneBook(env: CacheEnv, bookId: string, keep: Set<string>): Promise<number> {
  let names: string[]
  try {
    names = await readdir(bookDir(env, bookId))
  } catch {
    return 0
  }

  let removed = 0
  for (const name of names) {
    if (keep.has(name)) continue
    if (!FILE_RE.test(name) && !name.endsWith('.html.tmp')) continue
    try {
      await unlink(join(bookDir(env, bookId), name))
      removed++
    } catch {
      // 单个文件删不掉（被占用/权限）不该让整次刷新失败
    }
  }
  return removed
}

export async function clearBook(env: CacheEnv, bookId: string): Promise<CacheClearResult> {
  const usage = await usageOf(env, bookId)
  try {
    await rm(bookDir(env, bookId), { recursive: true, force: true })
  } catch {
    return { files: 0, bytes: 0 }
  }
  return usage
}

/** 清空整棵缓存树。书架记录、阅读进度、目录都在 SQLite 里，一个都不会动 */
export async function clearAll(env: CacheEnv): Promise<CacheClearResult> {
  const usage = await usageOf(env)
  try {
    await rm(env.root, { recursive: true, force: true })
  } catch {
    return { files: 0, bytes: 0 }
  }
  return usage
}

export async function stats(env: CacheEnv, ttlDays: number, now: number = Date.now()): Promise<CacheStats> {
  const empty: CacheStats = { files: 0, bytes: 0, expiredFiles: 0, expiredBytes: 0, books: [] }

  let entries
  try {
    entries = await readdir(env.root, { withFileTypes: true })
  } catch {
    return empty
  }

  const books: CacheBookUsage[] = []
  let files = 0
  let bytes = 0
  let expiredFiles = 0
  let expiredBytes = 0

  for (const entry of entries) {
    if (!entry.isDirectory() || !BOOK_ID_RE.test(entry.name)) continue
    const dir = join(env.root, entry.name)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }

    let bookFiles = 0
    let bookBytes = 0
    for (const name of names) {
      if (!FILE_RE.test(name)) continue
      try {
        const info = await stat(join(dir, name))
        bookFiles++
        bookBytes += info.size
        if (now - info.mtimeMs > ttlDays * DAY_MS) {
          expiredFiles++
          expiredBytes += info.size
        }
      } catch {
        // 统计期间被删掉的文件直接跳过
      }
    }

    if (bookFiles === 0) continue
    books.push({ bookId: entry.name, files: bookFiles, bytes: bookBytes })
    files += bookFiles
    bytes += bookBytes
  }

  books.sort((a, b) => b.bytes - a.bytes)
  return { files, bytes, expiredFiles, expiredBytes, books }
}

/** 用量统计的公共部分；`bookId` 缺省表示整棵树 */
async function usageOf(env: CacheEnv, bookId?: string): Promise<CacheClearResult> {
  const result: CacheClearResult = { files: 0, bytes: 0 }
  const dirs: string[] = []

  if (bookId !== undefined) {
    dirs.push(bookDir(env, bookId))
  } else {
    try {
      const entries = await readdir(env.root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && BOOK_ID_RE.test(entry.name)) dirs.push(join(env.root, entry.name))
      }
    } catch {
      return result
    }
  }

  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!FILE_RE.test(name)) continue
      try {
        const info = await stat(join(dir, name))
        result.files++
        result.bytes += info.size
      } catch {
        // 同上
      }
    }
  }

  return result
}
