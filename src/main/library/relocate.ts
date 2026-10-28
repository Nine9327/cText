/**
 * 单本书的文件重定位（M2-11）。
 *
 * 场景：书库根目录还在，但某个文件被挪到了子目录里（用户整理文件夹是常事），
 * 于是 `root + rel_path` 指不到文件，阅读器报 E_NOT_FOUND。
 *
 * 做法：让用户选一个目录，在它下面**按文件名找唯一匹配**，然后把 `rel_path`
 * 改成相对根目录的新路径。
 *
 * 三条安全边界：
 *   1. 只认**唯一匹配**。同名文件有两个时宁可失败——改错指向会让用户读到另一本书。
 *   2. 新路径必须落在根目录之内。否则 `relative()` 会给出 `..\..`，那等于把
 *      书库的边界破了，后续所有「相对路径」的假设都不成立。
 *   3. 不碰 `file_hash`。重定位是「同一个文件换了位置」而不是「换了一本书」，
 *      重新算哈希会把「同一文件的两个副本」变成两条记录。
 */
import { basename, relative } from 'node:path'
import { AppError, ERROR_CODES } from '@shared/errors'
import type { Db } from '../db/connection'
import { scanDirectory } from './scanner'

export interface RelocateResult {
  /** 成功时是新的 rel_path（相对根目录，`/` 分隔） */
  relPath: string | null
  /** 目录下同名文件的数量：0 = 没找到，>1 = 不唯一（都算失败） */
  candidates: number
}

export async function relocateBookFile(
  db: Db,
  bookId: string,
  searchDir: string
): Promise<RelocateResult> {
  const book = db
    .prepare('SELECT root_id, rel_path FROM books WHERE id = ? AND deleted_at IS NULL')
    .get(bookId) as { root_id: string | null; rel_path: string | null } | undefined
  if (!book) throw new AppError(ERROR_CODES.notFound, '这本书不在书库里')
  if (!book.root_id || !book.rel_path) {
    throw new AppError(ERROR_CODES.invalidArgument, '网络书没有本地文件，无法重定位')
  }

  const root = db.prepare('SELECT path FROM library_roots WHERE id = ?').get(book.root_id) as
    | { path: string }
    | undefined
  if (!root) throw new AppError(ERROR_CODES.notFound, '书籍所属的根目录已被移除')

  const wanted = basename(book.rel_path).toLowerCase()
  const scan = await scanDirectory(searchDir, { maxDepth: 8 })
  const hits = scan.files.filter((file) => basename(file.relPath).toLowerCase() === wanted)
  if (hits.length !== 1) return { relPath: null, candidates: hits.length }

  // `relative` 给出的是平台分隔符（Windows 反斜杠），库里的 rel_path 统一用 `/`
  const newRel = relative(root.path, `${searchDir}/${hits[0]!.relPath}`).split('\\').join('/')
  if (newRel.startsWith('..')) {
    return { relPath: null, candidates: 1 }
  }

  // 唯一索引 `(root_id, rel_path)`：如果这个位置已经被另一本书占着，不能抢
  const clash = db
    .prepare('SELECT id FROM books WHERE root_id = ? AND rel_path = ? AND deleted_at IS NULL AND id <> ?')
    .get(book.root_id, newRel, bookId) as { id: string } | undefined
  if (clash) return { relPath: null, candidates: 1 }

  db.prepare('UPDATE books SET rel_path = ?, updated_at = ? WHERE id = ?').run(newRel, Date.now(), bookId)
  return { relPath: newRel, candidates: 1 }
}
