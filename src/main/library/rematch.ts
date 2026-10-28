/**
 * 重新识别（M3-06）：按磁盘上的文件重新解析元信息与目录，覆盖库里的记录。
 *
 * 三件事定死：
 *   1. **只增不减**：解析失败时**一个字段都不写**。用户的元信息可能是手改过的
 *      （M3-04），「识别失败」不该把它清成空白——那比不识别糟得多。
 *   2. **保留用户数据**：进度、收藏、书架归属、分类都不动（`replaceBook` 的语义
 *      只覆盖来自文件的字段），读到第几章不会因为重新识别而丢。
 *   3. **必须 bump `updated_at`**：这是唯一「章节内容真的变了」的场景，
 *      阅读器缓存键是 `bookId:idx:updated_at`，不 bump 就会继续返回旧正文。
 */
import { AppError, ERROR_CODES } from '@shared/errors'
import type { Db } from '../db/connection'
import { getBookDetail, replaceBook } from '../db/repositories/books'
import { coversDir } from '../ipc/import'
import { prepareBook } from './importer'
import type { BookDetailDTO } from '@shared/dto'

export interface RematchResult {
  /** 与识别前相比真正变化的字段（给界面说「变了什么」） */
  changed: string[]
  before: { title: string; author: string | null; chapterCount: number }
  after: { title: string; author: string | null; chapterCount: number }
  book: BookDetailDTO | null
}

/** 一次「重新识别」的完整流程。失败抛错，且保证库里的记录没被改过 */
export async function rematchBook(db: Db, bookId: string): Promise<RematchResult> {
  const detail = getBookDetail(db, bookId)
  if (!detail) throw new AppError(ERROR_CODES.notFound, '这本书已不在书库中')
  if (detail.sourceType === 'network') {
    throw new AppError(ERROR_CODES.notImplemented, '网络书的重新识别要重新抓取目录（M4）')
  }
  if (detail.offline) {
    throw new AppError(ERROR_CODES.rootOffline, '书籍所在的目录当前离线，连接磁盘后再试')
  }
  if (!detail.rootId || !detail.relPath) {
    throw new AppError(ERROR_CODES.notFound, '这本书没有可读取的文件路径（根目录可能已被移除）')
  }
  const root = db.prepare('SELECT path FROM library_roots WHERE id = ?').get(detail.rootId) as
    | { path: string }
    | undefined
  if (!root) throw new AppError(ERROR_CODES.notFound, '书籍所在的根目录已不在书库中')

  // fileHash 用库里的值：这里是「同一个文件重新解析」，不是「换了一本书」
  const hashRow = db.prepare('SELECT file_hash FROM books WHERE id = ?').get(bookId) as {
    file_hash: string
  }
  const entry = {
    file: {
      relPath: detail.relPath,
      absPath: `${root.path.replace(/[\\/]+$/, '')}/${detail.relPath.replace(/\\/g, '/')}`,
      size: detail.sizeBytes,
      mtimeMs: 0
    },
    hash: hashRow.file_hash,
    kind: 'new' as const,
    existing: null,
    duplicateOf: null,
    error: null
  }

  // 解析全部在 prepareBook 里完成（编码探测 → 元信息 → 目录 → 封面）。
  // 任何一步失败都会在这里抛出，此时**还没有写过数据库**。
  const prepared = await prepareBook(entry, { rootId: detail.rootId, coversDir: coversDir() })

  const written = replaceBook(db, bookId, prepared)
  if (!written) throw new AppError(ERROR_CODES.notFound, '这本书已不在书库中')

  const after = getBookDetail(db, bookId)
  const changed: string[] = []
  if (after && after.title !== detail.title) changed.push('书名')
  if (after && after.author !== detail.author) changed.push('作者')
  if (after && after.chapterCount !== detail.chapterCount) changed.push('章节')
  if (after && after.intro !== detail.intro) changed.push('简介')

  return {
    changed,
    before: { title: detail.title, author: detail.author, chapterCount: detail.chapterCount },
    after: {
      title: after?.title ?? detail.title,
      author: after?.author ?? detail.author,
      chapterCount: after?.chapterCount ?? detail.chapterCount
    },
    book: after
  }
}
