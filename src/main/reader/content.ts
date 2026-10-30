/**
 * 章节内容服务（M2-01）。
 *
 * 一条 `reader:content` 的完整链路：定位文件（root + rel → 绝对路径、校验根目录状态）
 * → 查章节行（anchor/length + 上下章是否存在）→ 按格式读正文 → 转 HTML → 缓存 → 预取下一章。
 *
 * **为什么缓存只有 5 章**：读到第 N 章时，用户真正会立刻用的是 N+1（往下翻）和 N-1（往回翻），
 * 再往前的章节点目录就直接跳了。5 条足够覆盖「来回翻几页」的操作，又不会把整本书
 * 的内容（几百 MB 的 TXT 解出来是上 GB 的字符串）留在内存里。
 *
 * **缓存键里带 `updated_at`**：重新导入会覆盖同一本书的章节（`replaceBook` 会删掉
 * 旧章节行再插新的），如果键只到 `bookId:idx`，用户会继续读到覆盖前的旧正文。
 * 带上版本号就不需要 import 模块反过来调 reader 的清缓存接口，两个模块保持单向依赖。
 */
import type { ChapterContentDTO } from '@shared/dto'
import { AppError, ERROR_CODES } from '@shared/errors'
import type { Db } from '../db/connection'
import { createLogger } from '../log'
import { readEpubChapter } from './epub'
import { locateBook } from './paths'
import { readTxtWindow, textToHtml } from './txt'
import { getNetworkChapterContent, isNetworkBook } from '../network/service'

const log = createLogger('reader')

export const CACHE_LIMIT = 5

/** 最旧在前（Map 的插入顺序），LRU 命中时先删再插做到「最近使用在最后」 */
const cache = new Map<string, ChapterContentDTO>()

function cacheGet(key: string): ChapterContentDTO | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: ChapterContentDTO): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** 仅供自检：当前缓存键（最旧在前）。生产代码不要依赖它 */
export function readerCacheKeys(): string[] {
  return [...cache.keys()]
}

/** 仅供自检：清空缓存 */
export function clearReaderCache(): void {
  cache.clear()
}

interface ChapterRow {
  idx: number
  title: string
  anchor: string | null
  length: number | null
  has_prev: number
  has_next: number
}

const SELECT_CHAPTER = `
  SELECT c.idx, c.title, c.anchor, c.length,
         EXISTS(SELECT 1 FROM chapters p WHERE p.book_id = c.book_id AND p.idx < c.idx) AS has_prev,
         EXISTS(SELECT 1 FROM chapters n WHERE n.book_id = c.book_id AND n.idx > c.idx) AS has_next
  FROM chapters c
  WHERE c.book_id = ? AND c.idx = ?
`

/**
 * 读一章。
 *
 * @param allowPrefetch 读完是否顺手预取下一章。**预取的那次调用必须传 false**，
 *   否则会形成 N → N+1 → N+2 的递归，把整本书读进内存。
 */
async function loadChapter(
  db: Db,
  bookId: string,
  chapterIdx: number,
  allowPrefetch: boolean
): Promise<ChapterContentDTO> {
  const book = await locateBook(db, bookId)
  const key = `${book.id}:${chapterIdx}:${book.version}`
  const cached = cacheGet(key)
  if (cached) return cached

  const row = db.prepare(SELECT_CHAPTER).get(bookId, chapterIdx) as ChapterRow | undefined
  if (!row) throw new AppError(ERROR_CODES.notFound, '这一章不存在，目录可能已变化')

  // EPUB 的 anchor 是 zip 内路径，TXT 的是字节偏移——同一条通道两种语义，
  // 由 format 决定走哪条实现（M1-05 的约定，别试图统一成一种）
  let truncated = false
  let html: string
  if (book.format === 'epub') {
    html = (await readEpubChapter(book.absPath, String(row.anchor ?? ''), row.title)).html
  } else {
    const window = await readTxtWindow(book.absPath, Number(row.anchor ?? 0), row.length, book.encoding)
    html = textToHtml(window.text, row.title)
    truncated = window.hasMore
  }

  const content: ChapterContentDTO = {
    bookId: book.id,
    chapterIdx: row.idx,
    title: row.title,
    html,
    hasPrev: row.has_prev === 1,
    hasNext: row.has_next === 1,
    // 只有超出窗口的病态章节才带这个标记，正常章节不写（保持 DTO 干净）
    ...(truncated ? { truncated: true } : {})
  }
  cacheSet(key, content)

  if (allowPrefetch && content.hasNext) {
    // 预取失败一律吞掉（盘拔出、文件被删）：它只是锦上添花，
    // 让预取的异常冒出来会变成「翻页时莫名其妙弹错误」
    void loadChapter(db, bookId, chapterIdx + 1, false).catch((err: unknown) => {
      log.debug('预取下一章失败', { bookId, chapterIdx: chapterIdx + 1, detail: String(err) })
    })
  }

  return content
}

/**
 * 读一章。
 *
 * 网络书走 `network/service.ts`（M4-09）：它有自己的章节缓存与抓取超时，
 * 缓存键同样带 `updated_at`。两条链路只在"给渲染层一份 ChapterContentDTO"这一点上汇合。
 */
export function getChapterContent(db: Db, bookId: string, chapterIdx: number): Promise<ChapterContentDTO> {
  if (isNetworkBook(db, bookId)) return getNetworkChapterContent(db, bookId, chapterIdx)
  return loadChapter(db, bookId, chapterIdx, true)
}
