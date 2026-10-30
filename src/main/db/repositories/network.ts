/**
 * 网络书仓储（M4-09）。
 *
 * 与 `books.ts` 分开写的原因：本地书的写入链路围绕「文件」——root_id + rel_path +
 * file_hash 三个字段互相约束，还有「重新导入要保留进度」的覆盖语义。网络书这些字段
 * 全是 NULL 或派生值，硬塞进同一批 SQL 只会让两边都读不清。
 *
 * 四条 DDL 事实决定了这里的写法：
 *   1. `source_type='network'` 时 `idx_books_root_relpath`（部分索引）不生效，
 *      所以多本网络书的 root_id/rel_path 同时为 NULL 是合法的。
 *   2. `file_hash` 是 NOT NULL，且唯一索引只覆盖 local。网络书用 `net:` + 详情页地址的
 *      sha1：同一本书换源会得到不同 hash（本来就该是两条记录），重复加入同一源则一致。
 *   3. `chapters.anchor` 对网络书存**章节 URL**（本地书存的是字节偏移 / zip 路径）。
 *      同一列两种语义，由 `books.source_type` 区分，别试图统一。
 *   4. `chapters` 主键是 `(book_id, idx)`，整批替换必须「先删后插」——只更新的话
 *      目录变短时会留下尾部旧章节，读者会点进不存在的第 200 章。
 */
import { createHash } from 'node:crypto'
import type { Db } from '../connection'
import { ulid } from '../../utils/id'

export interface NetworkChapterInput {
  title: string
  url: string
}

export interface NetworkBookInput {
  sourceId: string
  /** 详情页地址（跟完重定向后的最终地址） */
  sourceUrl: string
  title: string
  author: string | null
  intro: string | null
  chapters: NetworkChapterInput[]
  now: number
}

export interface NetworkBookRow {
  id: string
  title: string
  source_id: string | null
  source_url: string | null
  updated_at: number
}

export interface NetworkChapterRow {
  idx: number
  title: string
  /** 章节 URL（网络书的 anchor） */
  url: string
  has_prev: number
  has_next: number
}

/** `file_hash` 的派生值：换源得到不同 hash，重复加入同一源得到同一个 */
export function networkHash(sourceId: string, sourceUrl: string): string {
  return `net:${sourceId}:${createHash('sha1').update(sourceUrl).digest('hex')}`
}

const INSERT_CHAPTER = `
  INSERT INTO chapters (book_id, idx, title, anchor, length, level)
  VALUES (?, ?, ?, ?, NULL, 0)
`

export function findNetworkBook(
  db: Db,
  sourceId: string,
  sourceUrl: string
): { id: string; title: string; cover_path: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, title, cover_path FROM books
       WHERE source_type = 'network' AND source_id = ? AND source_url = ? AND deleted_at IS NULL`
    )
    .get(sourceId, sourceUrl) as { id: string; title: string; cover_path: string | null } | undefined
  return row ?? null
}

export function insertNetworkBook(db: Db, input: NetworkBookInput): { id: string; chapters: number } {
  const id = ulid(input.now)
  const insertBook = db.prepare(
    `INSERT INTO books (
       id, title, author, format, root_id, rel_path, file_hash, size_bytes, encoding,
       cover_path, intro, publisher, pub_date, language, chapter_count,
       source_type, source_id, source_url, favorite, read_state, progress, created_at, updated_at
     ) VALUES (
       @id, @title, @author, 'txt', NULL, NULL, @hash, 0, NULL,
       NULL, @intro, NULL, NULL, NULL, @count,
       'network', @sourceId, @sourceUrl, 0, 'unread', 0, @now, @now
     )`
  )
  const insertChapter = db.prepare(INSERT_CHAPTER)

  const run = db.transaction(() => {
    insertBook.run({
      id,
      title: input.title,
      author: input.author,
      hash: networkHash(input.sourceId, input.sourceUrl),
      intro: input.intro,
      count: input.chapters.length,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      now: input.now
    })
    input.chapters.forEach((chapter, idx) => {
      insertChapter.run(id, idx, chapter.title, chapter.url)
    })
    return { id, chapters: input.chapters.length }
  })

  return run()
}

/**
 * 整批替换目录。
 *
 * 同时把 `updated_at` 改成 now：它是阅读器章节缓存的版本号，目录换过之后
 * 章节序号的意义就变了，旧缓存必须作废（与 `books.ts` 里「改书名不动 updated_at」相反）。
 */
export function replaceNetworkChapters(
  db: Db,
  bookId: string,
  chapters: NetworkChapterInput[],
  now: number
): number {
  const deleteChapters = db.prepare('DELETE FROM chapters WHERE book_id = ?')
  const insertChapter = db.prepare(INSERT_CHAPTER)
  const updateBook = db.prepare(
    'UPDATE books SET chapter_count = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  )

  const run = db.transaction(() => {
    deleteChapters.run(bookId)
    chapters.forEach((chapter, idx) => {
      insertChapter.run(bookId, idx, chapter.title, chapter.url)
    })
    updateBook.run(chapters.length, now, bookId)
    return chapters.length
  })

  return run()
}

export function getNetworkBook(db: Db, bookId: string): NetworkBookRow | null {
  const row = db
    .prepare(
      `SELECT id, title, source_id, source_url, updated_at FROM books
       WHERE id = ? AND source_type = 'network' AND deleted_at IS NULL`
    )
    .get(bookId) as NetworkBookRow | undefined
  return row ?? null
}

export function getNetworkChapter(db: Db, bookId: string, idx: number): NetworkChapterRow | null {
  const row = db
    .prepare(
      `SELECT c.idx, c.title, c.anchor,
              EXISTS(SELECT 1 FROM chapters p WHERE p.book_id = c.book_id AND p.idx < c.idx) AS has_prev,
              EXISTS(SELECT 1 FROM chapters n WHERE n.book_id = c.book_id AND n.idx > c.idx) AS has_next
       FROM chapters c WHERE c.book_id = ? AND c.idx = ?`
    )
    .get(bookId, idx) as
    | { idx: number; title: string; anchor: string | null; has_prev: number; has_next: number }
    | undefined
  if (!row) return null
  return { idx: row.idx, title: row.title, url: row.anchor ?? '', has_prev: row.has_prev, has_next: row.has_next }
}

/**
 * 目录的 (idx, url) 全表。
 *
 * M4-10 的缓存清理要用它算「哪些缓存文件还对应着现役章节」：文件名是
 * `idx-urlHash`，目录刷新后旧组合就成了孤儿。
 */
export function listNetworkChapterUrls(db: Db, bookId: string): Array<{ idx: number; url: string }> {
  const rows = db
    .prepare('SELECT idx, anchor FROM chapters WHERE book_id = ? ORDER BY idx')
    .all(bookId) as Array<{ idx: number; anchor: string | null }>
  return rows.map((row) => ({ idx: row.idx, url: row.anchor ?? '' }))
}

/**
 * 写封面文件名。
 *
 * **刻意不碰 `updated_at`**：它是阅读器章节缓存的版本号，换一张封面不该让
 * 已缓存的正文章节全部作废（与「改书名不动 updated_at」同一条原则）。
 */
export function setBookCover(db: Db, bookId: string, coverPath: string): void {
  db.prepare('UPDATE books SET cover_path = ? WHERE id = ? AND deleted_at IS NULL').run(coverPath, bookId)
}

/** 缓存用量页要显示书名：一次 IN 查询拿齐，不做 N+1 */
export function bookTitles(db: Db, ids: string[]): Map<string, string> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, title FROM books WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; title: string }>
  for (const row of rows) map.set(row.id, row.title)
  return map
}
