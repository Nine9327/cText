/**
 * 网络书服务（M4-09 / M4-10）：加入书架 / 刷新目录 / 取正文 / 缓存治理。
 *
 * 夹在「抓取层（engine/source/book.ts）」和「IPC」之间，只做三件事：
 * 把书源记录变成可抓取的 source、把抓到的目录写进库、把库里的章节 URL 变成正文。
 *
 * 七处刻意的选择：
 *   1. **加入书架是「先抓完再写库」**。抓一半写一半会留下没有目录的书，
 *      阅读器点进去就是空白——比直接失败更难解释。
 *   2. **重复加入同一本书不新建记录**，只刷新目录并返回 `reused`。用户在两个源里
 *      各点一次「加入书架」，书架上不该出现两本一模一样的书。
 *   3. **书源被删除时不级联删书**（与 M4-07 的约束一致）。书籍保留，正文读取时报
 *      「书源已移除」——用户还能看到目录和自己的进度。
 *   4. **正文两级缓存：内存 LRU（5 章）+ 磁盘（按章一个文件）**。内存解决「同一章
 *      来回翻」，磁盘解决「关掉应用再打开」与「断网还能读」（M4-10）。
 *   5. **TTL 过期只触发重抓，不删文件**。过期章节在断网时是唯一能读的东西，
 *      读失败要能回退到它；真删只有用户点清理这一条路。
 *   6. **预取下一章延迟 1.2 秒再发**。同站 1 秒间隔是产品口径的礼貌值，
 *      预取如果紧跟当前章发出，等于把 QPS 抬到 2——延迟后即使用独立连接池也不越界。
 *   7. **每次操作独立连接池**。与搜索同理：书源抓取是突发型负载，常驻连接池只会
 *      留下一堆空闲 socket 和不会释放的 host 队列。
 */
import { join } from 'node:path'
import { app } from 'electron'
import type { ChapterContentDTO, SourceCacheStatsDTO } from '@shared/dto'
import { AppError, ERROR_CODES, type ErrorCode } from '@shared/errors'
import type { Db } from '../db/connection'
import {
  bookTitles,
  findNetworkBook,
  getNetworkBook,
  getNetworkChapter,
  insertNetworkBook,
  listNetworkChapterUrls,
  replaceNetworkChapters,
  setBookCover,
  type NetworkChapterRow
} from '../db/repositories/network'
import { sourcesRepo } from '../db/repositories/sources'
import { loadSettings } from '../db/repositories/settings'
import { createHttpClient, type HttpClient } from '../engine/http/client'
import {
  NetworkFetchError,
  fetchBookInfo,
  fetchChapter,
  fetchToc,
  toNetworkSource,
  type NetworkFetchCode,
  type NetworkSource
} from '../engine/source/book'
import { cleanTitle } from '../engine/source/search'
import {
  chapterFileName,
  clearAll,
  clearBook,
  pruneBook,
  readChapter,
  stats as cacheStats,
  writeChapter,
  type CacheEnv
} from './cache'
import { downloadCover } from './cover'
import { createLogger } from '../log'

const log = createLogger('network')

/** 加入书架要跑完详情 + 最多 20 页目录；同站 1s 间隔下 20 页就要 20s，预算必须放宽 */
const ADD_BOOK_BUDGET_MS = 60_000
/** 单章正文：最多 5 页 */
const CHAPTER_BUDGET_MS = 30_000
/** 缓存保留天数缺省值：与产品文档 §2.7 的「默认保留 30 天」对齐（§7.6 遗留的口径不一致） */
const DEFAULT_TTL_DAYS = 30
/** 预取下一章的延迟：同站 1s 间隔 + 一点余量 */
const PREFETCH_DELAY_MS = 1200

const CODE_MAP: Record<NetworkFetchCode, ErrorCode> = {
  E_BAD_RECORD: ERROR_CODES.parseFailed,
  E_UNSUPPORTED: ERROR_CODES.notImplemented,
  E_NO_RULE: ERROR_CODES.parseFailed,
  E_BAD_URL: ERROR_CODES.invalidArgument,
  E_REQUEST: ERROR_CODES.io,
  E_TIMEOUT: ERROR_CODES.timeout,
  E_HTTP: ERROR_CODES.io,
  E_RULE: ERROR_CODES.parseFailed,
  E_EMPTY_TOC: ERROR_CODES.parseFailed,
  E_EMPTY_CONTENT: ERROR_CODES.parseFailed
}

/**
 * 抓取错误 → AppError。非抓取错误原样抛出：真 bug 不该被伪装成用户错误。
 *
 * 返回而不是直接 throw，是因为 `catch { rethrow() }` 配 `finally` 时 TS 的控制流分析
 * 不认「catch 里调了个 never 函数」，会报「缺少 return」。`throw toAppError(err)` 没这个问题。
 */
/** 日志里要的是原始错误文本；`messageOf` 是「错误码 → 用户文案」，两者别混用 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toAppError(err: unknown): AppError {
  if (err instanceof NetworkFetchError) return new AppError(CODE_MAP[err.code], err.message)
  if (err instanceof AppError) return err
  throw err
}

/**
 * 取一个出网通道。
 *
 * 自检要连 127.0.0.1（默认被 SSRF 策略拒绝），所以允许注入——注入的通道由调用方
 * 负责关闭，这里只关自己建的那个。
 */
export interface NetworkDeps {
  http?: HttpClient
  /** 缓存根目录；缺省 `userData/cache/sources` */
  cacheRoot?: string
  /** 封面目录；缺省 `userData/covers` */
  coversRoot?: string
  /** 缓存保留天数；缺省读设置 */
  ttlDays?: number
  /** 预取下一章；自检可关 */
  prefetch?: boolean
  /** 预取延迟（ms）；自检置 0 免得每次多等 1.2 秒 */
  prefetchDelayMs?: number
  /**
   * 预取用的连接池工厂。
   *
   * 预取在后台跑，调用方的连接池那时已经关了，所以它必须自己建一个。自检需要
   * `ssrf: false` 才能连 127.0.0.1，靠这个钩子注入；生产不传，用默认配置。
   */
  prefetchHttp?: () => HttpClient
}

function acquire(deps?: NetworkDeps): { http: HttpClient; owned: boolean } {
  if (deps?.http) return { http: deps.http, owned: false }
  return { http: createHttpClient(), owned: true }
}

/** 缓存根目录。`cache/sources` 是产品文档 §2.7 的固定位置 */
export function networkCacheDir(deps?: NetworkDeps): string {
  return deps?.cacheRoot ?? join(app.getPath('userData'), 'cache', 'sources')
}

export function coversDir(deps?: NetworkDeps): string {
  return deps?.coversRoot ?? join(app.getPath('userData'), 'covers')
}

function cacheEnv(deps?: NetworkDeps): CacheEnv {
  return { root: networkCacheDir(deps) }
}

function ttlDaysOf(db: Db, deps?: NetworkDeps): number {
  if (deps?.ttlDays !== undefined) return deps.ttlDays
  const value = loadSettings(db).sources.cacheTtlDays
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_DAYS
}

function loadSource(db: Db, sourceId: string): NetworkSource {
  const record = sourcesRepo(db).get(sourceId)
  if (!record) throw new AppError(ERROR_CODES.notFound, '书源不存在，可能已被删除')
  return toNetworkSource(record)
}

// ---------------------------------------------------------------- 缓存清理

/**
 * 目录刷新后清掉对不上的缓存文件。
 *
 * 文件名带 URL 哈希，所以「目录变了」不会让读者读到错章——但旧文件会一直占着空间。
 * 这里按新目录算一次白名单，多出来的删掉；目录没变等于空转。
 */
async function pruneAfterToc(db: Db, bookId: string, env: CacheEnv): Promise<void> {
  const rows = listNetworkChapterUrls(db, bookId)
  const keep = new Set(rows.filter((row) => row.url !== '').map((row) => chapterFileName(row.idx, row.url)))
  const removed = await pruneBook(env, bookId, keep)
  if (removed > 0) log.info('目录刷新后清理失配的章节缓存', { bookId, removed })
}

export interface AddBookInput {
  sourceId: string
  bookUrl: string
  /** 搜索结果的标题：详情规则没写 `name` 时兜底，好过一本「未命名」 */
  fallbackTitle?: string
}

export interface AddBookResult {
  bookId: string
  title: string
  chapterCount: number
  /** true = 这本书已经在书架上，本次只刷新了目录 */
  reused: boolean
}

export async function addNetworkBook(db: Db, input: AddBookInput, deps?: NetworkDeps): Promise<AddBookResult> {
  const source = loadSource(db, input.sourceId)
  const { http, owned } = acquire(deps)
  try {
    const options = { http, source, deadline: Date.now() + ADD_BOOK_BUDGET_MS }
    const detail = await fetchBookInfo(options, input.bookUrl)
    const toc = await fetchToc(options, detail.tocUrl)
    if (toc.chapters.length === 0) {
      throw new AppError(ERROR_CODES.parseFailed, '目录为空，书源规则可能已失效')
    }

    const title = cleanTitle(detail.info.title ?? input.fallbackTitle ?? '') || source.name
    const existing =
      findNetworkBook(db, source.id, detail.finalUrl) ?? findNetworkBook(db, source.id, input.bookUrl)

    if (existing) {
      replaceNetworkChapters(db, existing.id, toc.chapters, Date.now())
      await pruneAfterToc(db, existing.id, cacheEnv(deps))
      // 封面只在「还没有」的时候补：重复加入不该每次都重下一张图
      if (existing.cover_path === null) await saveCover(db, http, existing.id, detail.info.coverUrl, deps)
      log.info('刷新已有网络书目录', {
        bookId: existing.id,
        chapters: toc.chapters.length,
        pages: toc.pages
      })
      return { bookId: existing.id, title: existing.title, chapterCount: toc.chapters.length, reused: true }
    }

    const created = insertNetworkBook(db, {
      sourceId: source.id,
      sourceUrl: detail.finalUrl,
      title,
      author: detail.info.author,
      intro: detail.info.intro,
      chapters: toc.chapters,
      now: Date.now()
    })
    await saveCover(db, http, created.id, detail.info.coverUrl, deps)
    log.info('加入书架', {
      bookId: created.id,
      source: source.name,
      chapters: created.chapters,
      pages: toc.pages
    })
    return { bookId: created.id, title, chapterCount: created.chapters, reused: false }
  } catch (err) {
    throw toAppError(err)
  } finally {
    if (owned) await http.close()
  }
}

/**
 * 下载封面并写回 `books.cover_path`。
 *
 * 全程 best-effort：封面拿不到只是详情页少一张图，绝不能让「加入书架」失败。
 * 所以这里的 catch 只记日志、不往上抛。
 */
async function saveCover(
  db: Db,
  http: HttpClient,
  bookId: string,
  coverUrl: string | null,
  deps?: NetworkDeps
): Promise<void> {
  if (coverUrl === null) return
  const saved = await downloadCover(http, coverUrl, coversDir(deps))
  if (saved === null) {
    log.info('封面下载失败，改用占位封面', { bookId, coverUrl })
    return
  }
  try {
    setBookCover(db, bookId, saved.name)
    log.info('封面已缓存', { bookId, name: saved.name, bytes: saved.bytes, reused: saved.reused })
  } catch (err) {
    log.warn('封面写库失败', { bookId, message: errText(err) })
  }
}

export interface RefreshTocResult {
  total: number
}

export async function refreshNetworkToc(db: Db, bookId: string, deps?: NetworkDeps): Promise<RefreshTocResult> {
  const book = getNetworkBook(db, bookId)
  if (!book) throw new AppError(ERROR_CODES.notFound, '这本书不存在，可能已被移除')
  if (book.source_id === null || book.source_url === null) {
    throw new AppError(ERROR_CODES.notFound, '这本书没有关联书源，无法刷新目录')
  }

  const record = sourcesRepo(db).get(book.source_id)
  if (!record) throw new AppError(ERROR_CODES.notFound, '这本书的书源已被移除，无法刷新目录')

  const source = toNetworkSource(record)
  const { http, owned } = acquire(deps)
  try {
    const options = { http, source, deadline: Date.now() + ADD_BOOK_BUDGET_MS }
    // 先重取详情页：`tocUrl` 可能指向一个带签名的临时地址，直接用旧地址会 404
    const detail = await fetchBookInfo(options, book.source_url)
    const toc = await fetchToc(options, detail.tocUrl)
    if (toc.chapters.length === 0) {
      throw new AppError(ERROR_CODES.parseFailed, '目录为空，书源规则可能已失效')
    }
    const total = replaceNetworkChapters(db, bookId, toc.chapters, Date.now())
    await pruneAfterToc(db, bookId, cacheEnv(deps))
    log.info('刷新目录', { bookId, chapters: total, pages: toc.pages })
    return { total }
  } catch (err) {
    throw toAppError(err)
  } finally {
    if (owned) await http.close()
  }
}

// ---------------------------------------------------------------- 正文

/** 正文内存缓存：与本地书的 5 章 LRU 同量级，键里带 `updated_at` 让目录刷新后旧缓存自然失效 */
const CONTENT_CACHE_LIMIT = 5
const contentCache = new Map<string, ChapterContentDTO>()

/** 正在跑的预取，键同内存缓存。读同一章时先等它，避免为一个已在路上的请求再发一次 */
const prefetching = new Map<string, Promise<void>>()

function cacheKey(bookId: string, chapterIdx: number, updatedAt: number): string {
  return `${bookId}:${chapterIdx}:${updatedAt}`
}

function cacheGet(key: string): ChapterContentDTO | undefined {
  const hit = contentCache.get(key)
  if (!hit) return undefined
  contentCache.delete(key)
  contentCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: ChapterContentDTO): void {
  contentCache.delete(key)
  contentCache.set(key, value)
  while (contentCache.size > CONTENT_CACHE_LIMIT) {
    const oldest = contentCache.keys().next()
    if (oldest.done) break
    contentCache.delete(oldest.value)
  }
}

/** 仅供自检：清空内存缓存（磁盘不动） */
export function clearNetworkCache(): void {
  contentCache.clear()
}

/** 仅供自检：等预取全部落地 */
export async function flushPrefetch(): Promise<void> {
  await Promise.all([...prefetching.values()])
}

function toContent(bookId: string, chapter: NetworkChapterRow, html: string): ChapterContentDTO {
  return {
    bookId,
    chapterIdx: chapter.idx,
    title: chapter.title,
    html,
    hasPrev: chapter.has_prev === 1,
    hasNext: chapter.has_next === 1
  }
}

/**
 * 预取下一章。
 *
 * 三条约束决定了它的形状：
 *   - **不阻塞当前章**：用户看到的正文先返回，预取在后台跑。
 *   - **独立连接池 + 延迟**：调用方的连接池在这次请求结束时就被关掉了；
 *     延迟 1.2s 是为了不把同站 QPS 抬到 2。
 *   - **失败只记 debug**：预取失败与「用户翻到那一章时再抓一次」完全等价，
 *     没有任何理由让用户看到错误。
 */
function schedulePrefetch(
  db: Db,
  deps: NetworkDeps | undefined,
  source: NetworkSource,
  env: CacheEnv,
  bookId: string,
  updatedAt: number,
  chapter: NetworkChapterRow
): void {
  if (deps?.prefetch === false) return
  if (chapter.has_next !== 1) return

  const nextIdx = chapter.idx + 1
  const key = cacheKey(bookId, nextIdx, updatedAt)
  if (contentCache.has(key) || prefetching.has(key)) return

  const next = getNetworkChapter(db, bookId, nextIdx)
  if (next === null || next.url === '') return

  const delay = deps?.prefetchDelayMs ?? PREFETCH_DELAY_MS
  const task = (async () => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const http = deps?.prefetchHttp ? deps.prefetchHttp() : createHttpClient()
    try {
      const result = await fetchChapter({ http, source, deadline: Date.now() + CHAPTER_BUDGET_MS }, next.url)
      await writeChapter(env, bookId, nextIdx, next.url, result.html)
      cacheSet(key, toContent(bookId, next, result.html))
      log.debug('预取下一章完成', { bookId, chapterIdx: nextIdx, bytes: result.html.length })
    } catch (err) {
      log.debug('预取下一章失败（留待用户翻到时再抓）', {
        bookId,
        chapterIdx: nextIdx,
        message: errText(err)
      })
    } finally {
      await http.close()
    }
  })()

  prefetching.set(key, task)
  void task.finally(() => prefetching.delete(key))
}

/**
 * 预取要读下一章的 URL，所以它需要一个 `db`；把 `db` 传进后台任务是安全的——
 * SQLite 连接是同步的单例，任务本身不持有事务，也不会在别的库上误用。
 */
export async function getNetworkChapterContent(
  db: Db,
  bookId: string,
  chapterIdx: number,
  deps?: NetworkDeps
): Promise<ChapterContentDTO> {
  const book = getNetworkBook(db, bookId)
  if (!book) throw new AppError(ERROR_CODES.notFound, '这本书不存在，可能已被移除')

  const key = cacheKey(bookId, chapterIdx, book.updated_at)
  const cached = cacheGet(key)
  if (cached) return cached

  // 预取正在跑：等它落地再决定要不要自己发请求
  const pending = prefetching.get(key)
  if (pending) {
    await pending
    const after = cacheGet(key)
    if (after) return after
  }

  const chapter = getNetworkChapter(db, bookId, chapterIdx)
  if (!chapter) throw new AppError(ERROR_CODES.notFound, '这一章不存在，目录可能已变化')
  if (chapter.url === '') {
    throw new AppError(ERROR_CODES.parseFailed, '这一章没有章节地址，请刷新目录')
  }

  if (book.source_id === null) {
    throw new AppError(ERROR_CODES.notFound, '这本书没有关联书源，无法获取正文')
  }
  const record = sourcesRepo(db).get(book.source_id)
  if (!record) throw new AppError(ERROR_CODES.notFound, '这本书的书源已被移除，暂时无法获取正文')

  const env = cacheEnv(deps)
  const ttlDays = ttlDaysOf(db, deps)
  const disk = await readChapter(env, bookId, chapterIdx, chapter.url, ttlDays)

  // 命中且没过期：直接用，一个请求都不发
  if (disk !== null && !disk.stale) {
    const content = toContent(bookId, chapter, disk.html)
    cacheSet(key, content)
    return content
  }

  const source = toNetworkSource(record)
  const { http, owned } = acquire(deps)
  try {
    const result = await fetchChapter(
      { http, source, deadline: Date.now() + CHAPTER_BUDGET_MS },
      chapter.url
    )
    const content = toContent(bookId, chapter, result.html)
    cacheSet(key, content)
    try {
      await writeChapter(env, bookId, chapterIdx, chapter.url, result.html)
    } catch (err) {
      // 落盘失败不该让用户读不到这一章，只是下次要重新抓
      log.warn('正文落盘失败', { bookId, chapterIdx, message: errText(err) })
    }
    schedulePrefetch(db, deps, source, env, bookId, book.updated_at, chapter)
    return content
  } catch (err) {
    // 过期缓存兜底：断网时这就是「已缓存章节可读」的唯一来源
    if (disk !== null) {
      log.warn('抓取失败，回退到过期缓存', {
        bookId,
        chapterIdx,
        ageDays: Math.round(disk.ageMs / 86_400_000),
        message: errText(err)
      })
      const content = toContent(bookId, chapter, disk.html)
      cacheSet(key, content)
      return content
    }
    throw toAppError(err)
  } finally {
    if (owned) await http.close()
  }
}

// ---------------------------------------------------------------- 缓存治理（M4-10）

/** 缓存用量。书籍数量可能很多，明细只给占用最大的 20 本 */
const STATS_BOOK_LIMIT = 20

export async function readNetworkCacheStats(db: Db, deps?: NetworkDeps): Promise<SourceCacheStatsDTO> {
  const ttlDays = ttlDaysOf(db, deps)
  const stats = await cacheStats(cacheEnv(deps), ttlDays)
  const top = stats.books.slice(0, STATS_BOOK_LIMIT)
  const titles = bookTitles(db, top.map((book) => book.bookId))

  return {
    dir: networkCacheDir(deps),
    files: stats.files,
    bytes: stats.bytes,
    expiredFiles: stats.expiredFiles,
    expiredBytes: stats.expiredBytes,
    ttlDays,
    totalBooks: stats.books.length,
    books: top.map((book) => ({
      bookId: book.bookId,
      title: titles.get(book.bookId) ?? null,
      files: book.files,
      bytes: book.bytes
    }))
  }
}

/**
 * 清理缓存。
 *
 * `bookId` 缺省表示全部。**只删 `cache/sources` 下的文件**：书架、目录、阅读进度
 * 都在 SQLite 里，清理一次缓存不该让任何一本书从书架上消失。
 */
export async function clearNetworkCacheDir(
  db: Db,
  bookId?: string,
  deps?: NetworkDeps
): Promise<{ files: number; bytes: number }> {
  if (bookId === undefined) {
    const result = await clearAll(cacheEnv(deps))
    // 内存里的正文也一起丢掉：留着会出现「界面显示清理成功但这一章还是马上出来了」
    contentCache.clear()
    log.info('清空正文缓存', { files: result.files, bytes: result.bytes })
    return result
  }

  const book = getNetworkBook(db, bookId)
  const result = await clearBook(cacheEnv(deps), bookId)
  for (const key of [...contentCache.keys()]) {
    if (key.startsWith(`${bookId}:`)) contentCache.delete(key)
  }
  log.info('清空单本书的正文缓存', {
    bookId,
    title: book?.title ?? null,
    files: result.files,
    bytes: result.bytes
  })
  return result
}

/** 阅读器用它判断走文件还是走网络（一次主键查询，成本可忽略） */
export function isNetworkBook(db: Db, bookId: string): boolean {
  const row = db
    .prepare(`SELECT source_type FROM books WHERE id = ? AND deleted_at IS NULL`)
    .get(bookId) as { source_type: string } | undefined
  return row?.source_type === 'network'
}
