/**
 * 书签与划线仓储（M2-09）。
 *
 * 位置用**两个字符偏移**（`offset` 起点、`end_offset` 终点，右开区间），
 * 不用「页码 + 第几行」也不用「文本 + 搜索」：
 *   - 页号在换字号/换窗口后失效；
 *   - 文本搜索在重复句上会命中错的位置（同一章里「他说」可能出现几十次）。
 * 字符偏移是唯一与排版无关、且能唯一定位一段文字的东西。
 */
import type { BookmarkDTO, BookmarkKind } from '@shared/dto'
import { getDb, type Db } from '../connection'
import { ulid } from '../../utils/id'

export interface BookmarkInput {
  bookId: string
  chapterIdx: number
  offset: number
  endOffset: number | null
  kind: BookmarkKind
  text: string | null
  note?: string | null
  color?: string | null
}

interface BookmarkRow {
  id: string
  book_id: string
  chapter_idx: number
  offset: number
  end_offset: number | null
  kind: string
  text: string | null
  note: string | null
  color: string | null
  created_at: number
}

const SELECT = `
  SELECT id, book_id, chapter_idx, offset, end_offset, kind, text, note, color, created_at
  FROM bookmarks WHERE book_id = ?
  ORDER BY chapter_idx, offset, created_at
`

function toDTO(row: BookmarkRow): BookmarkDTO {
  return {
    id: row.id,
    bookId: row.book_id,
    chapterIdx: row.chapter_idx,
    offset: row.offset,
    endOffset: row.end_offset,
    kind: row.kind as BookmarkKind,
    text: row.text,
    note: row.note,
    color: row.color,
    createdAt: row.created_at
  }
}

export function listBookmarks(db: Db, bookId: string): BookmarkDTO[] {
  return (db.prepare(SELECT).all(bookId) as BookmarkRow[]).map(toDTO)
}

/**
 * 新增。**同一位置的重复划线直接返回已有的那条**（不报错也不重复插入）：
 * 用户在同一个句子上反复划是很常见的动作（手抖、忘了划过），
 * 报「已存在」或插入两条视觉上叠在一起都是坏体验。
 */
export function addBookmark(db: Db, input: BookmarkInput, now: number = Date.now()): BookmarkDTO {
  const existing = db
    .prepare(
      `SELECT id, book_id, chapter_idx, offset, end_offset, kind, text, note, color, created_at
       FROM bookmarks
       WHERE book_id = ? AND chapter_idx = ? AND offset = ? AND kind = ?
         AND ifnull(end_offset, -1) = ifnull(?, -1)`
    )
    .get(input.bookId, input.chapterIdx, input.offset, input.kind, input.endOffset) as BookmarkRow | undefined
  if (existing) return toDTO(existing)

  const id = ulid()
  db.prepare(
    `INSERT INTO bookmarks (id, book_id, chapter_idx, offset, end_offset, kind, text, note, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.bookId,
    input.chapterIdx,
    input.offset,
    input.endOffset,
    input.kind,
    input.text,
    input.note ?? null,
    input.color ?? null,
    now
  )
  return {
    id,
    bookId: input.bookId,
    chapterIdx: input.chapterIdx,
    offset: input.offset,
    endOffset: input.endOffset,
    kind: input.kind,
    text: input.text,
    note: input.note ?? null,
    color: input.color ?? null,
    createdAt: now
  }
}

export function updateBookmarkNote(db: Db, id: string, note: string | null): void {
  db.prepare('UPDATE bookmarks SET note = ? WHERE id = ?').run(note, id)
}

export function removeBookmark(db: Db, id: string): void {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
}

/**
 * 导出为 Markdown。
 *
 * 为什么是 Markdown 而不是 txt：笔记的价值在于「能贴进别的地方」，
 * 引用块 + 加粗标题的 Markdown 在 Obsidian / Notion / 微信里都能直接看。
 */
export function exportBookmarks(db: Db, bookId: string, bookTitle: string): string {
  const items = listBookmarks(db, bookId)
  const lines: string[] = [`# 《${bookTitle}》读书笔记`, '']
  if (items.length === 0) {
    lines.push('_还没有书签或划线。_', '')
    return lines.join('\n')
  }

  let currentChapter: number | null = null
  for (const item of items) {
    if (item.chapterIdx !== currentChapter) {
      currentChapter = item.chapterIdx
      lines.push(`## 第 ${item.chapterIdx + 1} 章`, '')
    }
    if (item.kind === 'highlight' && item.text) {
      // 引用块：多行文本逐行加 `>`，否则第二行会跑出引用
      for (const line of item.text.split(/\r?\n/)) lines.push(`> ${line}`)
      lines.push('')
    } else {
      lines.push(`- 书签（位置 ${item.offset}）`, '')
    }
    if (item.note) {
      lines.push(`**笔记**：${item.note}`, '')
    }
  }
  return lines.join('\n')
}

export function bookmarksRepo(db: Db = getDb()) {
  return {
    list: (bookId: string) => listBookmarks(db, bookId),
    add: (input: BookmarkInput) => addBookmark(db, input),
    updateNote: (id: string, note: string | null) => updateBookmarkNote(db, id, note),
    remove: (id: string) => removeBookmark(db, id),
    exportMarkdown: (bookId: string, title: string) => exportBookmarks(db, bookId, title)
  }
}
