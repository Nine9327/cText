/**
 * 书籍文件定位（M2-01）。
 *
 * 库里的书只存 `root_id + rel_path`（绝不写绝对路径），所以每次读正文都要
 * 用「根目录当前路径 + 相对路径」现拼。这既是「换盘符仍能恢复」的实现基础，
 * 也意味着**每次读章节都必须重新检查根目录状态**——用户完全可能在上次阅读之后
 * 把移动硬盘拔了。
 *
 * 一次 JOIN 查询拿齐所有需要的东西（书 + 根目录状态 + 根目录路径），
 * 不做「先查书再查根目录」的两段式：两段式在多一次往返的同时，
 * 还容易在中间被根目录状态变化插进来。
 */
import { stat } from 'node:fs/promises'
import type { BookFormat } from '@shared/dto'
import { AppError, ERROR_CODES, messageOf } from '@shared/errors'
import type { Db } from '../db/connection'
import { resolveRelPath } from '../library/scanner'

export interface LocatedBook {
  id: string
  title: string
  format: BookFormat
  /** TXT 的探测编码（Python codec 名，如 utf-8 / gb18030）；EPUB 为 null */
  encoding: string | null
  version: number
  /** 已经确认存在的绝对路径 */
  absPath: string
}

interface Row {
  id: string
  title: string
  format: string
  source_type: string
  root_id: string | null
  rel_path: string | null
  encoding: string | null
  updated_at: number
  root_state: string | null
  root_path: string | null
}

const SELECT_BOOK = `
  SELECT b.id, b.title, b.format, b.source_type, b.root_id, b.rel_path, b.encoding,
         b.updated_at, r.state AS root_state, r.path AS root_path
  FROM books b LEFT JOIN library_roots r ON r.id = b.root_id
  WHERE b.id = ? AND b.deleted_at IS NULL
`

/**
 * 定位一本书的实际文件。
 *
 * 五种失败各有专属语义，因为阅读器的处置完全不同：
 *   - 书不存在 / 未归属根目录 → E_NOT_FOUND（重定位也没用）
 *   - 根目录离线 → E_ROOT_OFFLINE（提示插盘或重新指定目录，进度保留）
 *   - 文件不存在 → E_NOT_FOUND（根目录在，但文件被移走/删了）
 *   - 网络书 → E_NOT_IMPLEMENTED（正文要靠 M4 的缓存，不是本地文件）
 */
export async function locateBook(db: Db, bookId: string): Promise<LocatedBook> {
  const row = db.prepare(SELECT_BOOK).get(bookId) as Row | undefined
  if (!row) throw new AppError(ERROR_CODES.notFound, '这本书不存在，可能已被移除')

  if (row.source_type === 'network') {
    throw new AppError(ERROR_CODES.notImplemented, '网络书籍的正文读取尚未实现')
  }
  if (!row.root_id || !row.rel_path || !row.root_path) {
    throw new AppError(ERROR_CODES.notFound, '这本书已不在任何书库目录中，请重新导入')
  }
  if (row.root_state === 'offline') {
    // 用统一文案（shared/errors.ts 是唯一来源），不在这里另写一句
    throw new AppError(ERROR_CODES.rootOffline, messageOf(ERROR_CODES.rootOffline))
  }

  const absPath = resolveRelPath(row.root_path, row.rel_path)
  try {
    const info = await stat(absPath)
    if (!info.isFile()) throw new AppError(ERROR_CODES.notFound, '书籍文件不存在，可能已被移动或删除')
  } catch (err) {
    if (err instanceof AppError) throw err
    // ENOENT / EPERM 都归到这里：对用户来说都是「打不开这个文件」
    throw new AppError(ERROR_CODES.notFound, '书籍文件不存在，可能已被移动或删除')
  }

  return {
    id: row.id,
    title: row.title,
    format: row.format as BookFormat,
    encoding: row.encoding,
    version: row.updated_at,
    absPath
  }
}
