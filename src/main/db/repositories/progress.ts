/**
 * 阅读进度仓储（M2-08）。
 *
 * 两处落库，同一事务：
 *   - `reading_progress`：章 + 章内字符偏移 + 百分比（**恢复位置靠它**）；
 *   - `books.progress / read_state / last_read_at`：列表页要用的汇总
 *     （排序「最近阅读」、卡片显示「已读 42%」都读这三个字段）。
 *
 * 为什么不合并成一处：`books` 是列表查询的主表，万本书的列表 P95 靠它撑着；
 * 把「章内偏移」塞进 books 会让每次列表多搬一列用不上的整数。反过来，
 * 只在 reading_progress 存百分比则列表要 join 一张稀疏表。
 *
 * **进度只存「章 + 偏移」不存页号**：页号在换字号/换窗口/切双栏后全部失效，
 * 而字符偏移在重排后仍然是同一个字符（M2-04 的锚点就是按这个设计的）。
 */
import type { ProgressDTO } from '@shared/dto'
import { getDb, type Db } from '../connection'

/** 判定「已读完」的阈值：末章的最后一个字符附近就够，不必真的滚到底 */
export const FINISHED_THRESHOLD = 0.995

export function loadProgress(db: Db, bookId: string): ProgressDTO | null {
  const row = db
    .prepare('SELECT book_id, chapter_idx, offset, percent FROM reading_progress WHERE book_id = ?')
    .get(bookId) as
    | { book_id: string; chapter_idx: number; offset: number; percent: number }
    | undefined
  if (!row) return null
  return {
    bookId: row.book_id,
    chapterIdx: row.chapter_idx,
    offset: row.offset,
    percent: row.percent
  }
}

/**
 * 写进度。**必须在事务里同时更新两张表**：
 * 只写 reading_progress 会让列表页的「最近阅读」停在旧位置，
 * 只写 books 则下次打开回到章首——两种半更新都比不写更让人困惑。
 */
export function saveProgress(db: Db, progress: ProgressDTO, now: number = Date.now()): ProgressDTO {
  const percent = Math.min(1, Math.max(0, progress.percent))
  const readState = percent >= FINISHED_THRESHOLD ? 'finished' : 'reading'

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO reading_progress (book_id, chapter_idx, offset, percent, updated_at)
       VALUES (@bookId, @chapterIdx, @offset, @percent, @now)
       ON CONFLICT(book_id) DO UPDATE SET
         chapter_idx = excluded.chapter_idx,
         offset = excluded.offset,
         percent = excluded.percent,
         updated_at = excluded.updated_at`
    ).run({
      bookId: progress.bookId,
      chapterIdx: progress.chapterIdx,
      offset: progress.offset,
      percent,
      now
    })

    // read_state 只升不降：读完之后再往前翻两页，不该又变回「在读」
    db.prepare(
      `UPDATE books SET progress = ?, last_read_at = ?,
         read_state = CASE WHEN read_state = 'finished' THEN 'finished' ELSE ? END
       WHERE id = ? AND deleted_at IS NULL`
    ).run(percent, now, readState, progress.bookId)
  })
  write()

  return { bookId: progress.bookId, chapterIdx: progress.chapterIdx, offset: progress.offset, percent }
}

/** 清掉一本书的进度（「标记为未读」用；界面在 M3 的书籍右键菜单） */
export function clearProgress(db: Db, bookId: string): void {
  const write = db.transaction(() => {
    db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(bookId)
    db.prepare(
      `UPDATE books SET progress = 0, read_state = 'unread', last_read_at = NULL
       WHERE id = ? AND deleted_at IS NULL`
    ).run(bookId)
  })
  write()
}

export function progressRepo(db: Db = getDb()) {
  return {
    load: (bookId: string) => loadProgress(db, bookId),
    save: (progress: ProgressDTO, now?: number) => saveProgress(db, progress, now),
    clear: (bookId: string) => clearProgress(db, bookId)
  }
}
