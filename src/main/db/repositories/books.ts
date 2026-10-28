/**
 * books / chapters 仓储（M1-06 起用）。
 *
 * 与 `roots.ts` 同样的分层：**仓储只管 SQL**，解析、去重、批处理策略都在
 * `main/library/import-*.ts` 里。这样导入的核心逻辑能被 smoke 用临时库直接测。
 *
 * 三条 DDL 事实决定了这里的写法：
 *   1. `idx_books_root_relpath` 是 `(root_id, rel_path)` 的部分唯一索引（排除已删除）。
 *      所以同一路径只能有一条记录——「文件被改过再导入」必须是 UPDATE，不是 INSERT。
 *   2. `idx_books_hash` 是 `file_hash` 的唯一索引（仅 local、未删除）。跨根重复靠它兜底，
 *      撞上就是 E_CONFLICT，需要在导入侧先经过去重。
 *   3. `chapters` 的主键是 `(book_id, idx)`，且 `ON DELETE CASCADE`。
 *      章节整批替换时先删后插，避免残留旧章节。
 */
import type { BookFormat, BookSort, BookSortField } from '@shared/dto'
import { getDb, type Db } from '../connection'
import { ulid } from '../../utils/id'

/** 待写入的章节行（与 DDL 列一一对应） */
export interface ChapterInput {
  idx: number
  title: string
  /** txt 为字节偏移字符串，epub 为 zip 内路径 */
  anchor: string | null
  /** txt 为字节长度，epub 为 null */
  length: number | null
  level: number
}

/** 待写入的书籍行。字段名用 camelCase，仓储负责映射到列名 */
export interface BookInput {
  title: string
  author: string | null
  format: BookFormat
  rootId: string
  relPath: string
  fileHash: string
  sizeBytes: number
  encoding: string | null
  /** 封面缓存文件名（相对 covers 目录），无封面为 null */
  coverPath: string | null
  intro: string | null
  publisher: string | null
  pubDate: string | null
  language: string | null
  chapterCount: number
  chapters: ChapterInput[]
}

export interface InsertResult {
  id: string
  chapters: number
}

const INSERT_BOOK = `
  INSERT INTO books (
    id, title, author, format, root_id, rel_path, file_hash, size_bytes, encoding,
    cover_path, intro, publisher, pub_date, language, chapter_count,
    source_type, favorite, read_state, progress, created_at, updated_at
  ) VALUES (
    @id, @title, @author, @format, @rootId, @relPath, @fileHash, @sizeBytes, @encoding,
    @coverPath, @intro, @publisher, @pubDate, @language, @chapterCount,
    'local', 0, 'unread', 0, @now, @now
  )
`

const INSERT_CHAPTER = `
  INSERT INTO chapters (book_id, idx, title, anchor, length, level)
  VALUES (?, ?, ?, ?, ?, ?)
`

/** 覆盖已有记录时只更新「来自文件」的字段，**不碰 favorite / 进度 / 书架归属** */
const UPDATE_BOOK = `
  UPDATE books SET
    title = @title, author = @author, format = @format, file_hash = @fileHash,
    size_bytes = @sizeBytes, encoding = @encoding, cover_path = @coverPath,
    intro = @intro, publisher = @publisher, pub_date = @pubDate, language = @language,
    chapter_count = @chapterCount, updated_at = @now
  WHERE id = @id AND deleted_at IS NULL
`

function toParams(book: BookInput, id: string, now: number): Record<string, unknown> {
  return {
    id,
    now,
    title: book.title,
    author: book.author,
    format: book.format,
    rootId: book.rootId,
    relPath: book.relPath,
    fileHash: book.fileHash,
    sizeBytes: book.sizeBytes,
    encoding: book.encoding,
    coverPath: book.coverPath,
    intro: book.intro,
    publisher: book.publisher,
    pubDate: book.pubDate,
    language: book.language,
    chapterCount: book.chapterCount
  }
}

/**
 * 批量写入（书 + 章节同一事务）。
 *
 * **事务边界是「一批 50 本」**（产品文档 §3.10 的吞吐取舍）：逐本提交在 WAL 下
 * 每本一次 fsync，500 本要多花十几秒；整批提交则内存与回滚代价过高。
 *
 * 调用方（`import-task.ts`）负责在整批失败时退化成逐本写入来定位坏记录——
 * 这里不做逐本兜底，因为那属于调度策略。
 */
export function insertBatch(db: Db, books: readonly BookInput[], now: number = Date.now()): InsertResult[] {
  const insertBook = db.prepare(INSERT_BOOK)
  const insertChapter = db.prepare(INSERT_CHAPTER)

  const run = db.transaction((items: readonly BookInput[]) => {
    const results: InsertResult[] = []
    for (const book of items) {
      const id = ulid()
      insertBook.run(toParams(book, id, now))
      for (const chapter of book.chapters) {
        insertChapter.run(id, chapter.idx, chapter.title, chapter.anchor, chapter.length, chapter.level)
      }
      results.push({ id, chapters: book.chapters.length })
    }
    return results
  })

  return run(books)
}

/**
 * 覆盖已有记录（`onDuplicate: 'overwrite'`）。
 *
 * 语义刻意收窄：只更新来自文件的字段，**保留** id / 收藏 / 阅读进度 / 书架归属。
 * 「重新导入」不该让用户丢掉读到第几章。
 */
export function replaceBook(
  db: Db,
  bookId: string,
  book: BookInput,
  now: number = Date.now()
): InsertResult | null {
  const updateBook = db.prepare(UPDATE_BOOK)
  const deleteChapters = db.prepare('DELETE FROM chapters WHERE book_id = ?')
  const insertChapter = db.prepare(INSERT_CHAPTER)

  const run = db.transaction(() => {
    const info = updateBook.run({ ...toParams(book, bookId, now) })
    if (info.changes === 0) return null // 记录已被删除（软删除），不复活
    deleteChapters.run(bookId)
    for (const chapter of book.chapters) {
      insertChapter.run(bookId, chapter.idx, chapter.title, chapter.anchor, chapter.length, chapter.level)
    }
    return { id: bookId, chapters: book.chapters.length }
  })

  return run()
}

export interface BookCount {
  total: number
  byRoot: Record<string, number>
}

function asCount(row: { n: number } | undefined): number {
  return row?.n ?? 0
}

// ---------------------------------------------------------------- 列表查询（M1-08）

/** BookDTO 的行来源。root_state 供 offline 判定（书籍记录保留，只是读不到文件） */
interface BookRow {
  id: string
  title: string
  author: string | null
  series: string | null
  format: string
  favorite: number
  read_state: string
  progress: number
  chapter_count: number
  root_id: string | null
  source_type: string
  last_read_at: number | null
  created_at: number
  updated_at: number
  root_state: string | null
}

const BOOK_SELECT = `
  SELECT books.id, books.title, books.author, books.series, books.format,
         books.favorite, books.read_state, books.progress, books.chapter_count,
         books.root_id, books.source_type, books.last_read_at,
         books.created_at, books.updated_at,
         library_roots.state AS root_state
  FROM books LEFT JOIN library_roots ON library_roots.id = books.root_id
  WHERE books.deleted_at IS NULL
`

function toBookDTO(row: BookRow): import('@shared/dto').BookDTO {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    series: row.series,
    format: row.format as import('@shared/dto').BookFormat,
    coverUrl: null, // 封面自定义协议属 M2-03；此前 UI 用「书名 + 哈希取色」占位
    favorite: row.favorite === 1,
    readState: row.read_state as import('@shared/dto').ReadState,
    progress: row.progress,
    chapterCount: row.chapter_count,
    rootId: row.root_id,
    sourceType: row.source_type as import('@shared/dto').BookSourceType,
    // 离线只属于本地书：网络书没有「根目录离线」的概念
    offline: row.source_type === 'local' && row.root_id !== null && row.root_state === 'offline',
    lastReadAt: row.last_read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface BookListQuery {
  /** 缺省 = 全部书库 */
  rootId?: string
  favoritesOnly?: boolean
  shelfId?: string
  /** 缺省 = 导入时间倒序 */
  sort?: BookSort
  offset: number
  limit: number
}

/**
 * 排序字段 → ORDER BY 表达式。**用映射表而不是拼输入**：列名只能来自这里，
 * zod 的 enum 在 IPC 边界上已经挡了一层，这里是第二层（仓储也可能被内部直接调用）。
 *
 * 两处细节：
 *   - `IS NULL` 前置让「没有值」（没读过 / 作者未知）恒排在后，否则 ASC 时
 *     一屏全是空作者，用户找不到东西。它本身不带方向，默认 ASC（0 在前）。
 *   - 末尾恒接 `books.id` 同向兜底：同毫秒插入 / 同名同作者时顺序稳定，
 *     否则翻页会出现重复或漏项。
 */
const ORDER_BY: Record<BookSortField, string> = {
  createdAt: 'books.created_at',
  lastReadAt: 'books.last_read_at IS NULL, books.last_read_at',
  title: 'books.title COLLATE NOCASE',
  author: 'books.author IS NULL, books.author COLLATE NOCASE',
  progress: 'books.progress'
}

function orderByClause(sort: BookSort | undefined): string {
  const field = sort && sort.field in ORDER_BY ? sort.field : 'createdAt'
  const direction = sort?.direction === 'asc' ? 'ASC' : 'DESC'
  return `${ORDER_BY[field]} ${direction}, books.id ${direction}`
}

export function listBooks(db: Db, query: BookListQuery): { items: import('@shared/dto').BookDTO[]; total: number } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.rootId) {
    conditions.push('books.root_id = ?')
    params.push(query.rootId)
  }
  if (query.favoritesOnly) {
    conditions.push('books.favorite = 1')
  }
  if (query.shelfId) {
    conditions.push('books.id IN (SELECT book_id FROM shelf_books WHERE shelf_id = ?)')
    params.push(query.shelfId)
  }
  const where = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  const total = asCount(
    db.prepare(`SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL${where}`).get(...params) as { n: number }
  )
  const rows = db
    .prepare(`${BOOK_SELECT}${where} ORDER BY ${orderByClause(query.sort)} LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as BookRow[]

  return { items: rows.map(toBookDTO), total }
}

/** 最近阅读：有进度的在线书，按最近阅读时间取前 N。供书库首页的「最近阅读」区 */
export function recentBooks(db: Db, rootId: string | undefined, limit: number): import('@shared/dto').BookDTO[] {
  const cond = rootId ? ' AND books.root_id = ?' : ''
  const params = rootId ? [rootId] : []
  const rows = db
    .prepare(
      `${BOOK_SELECT}${cond}
       AND books.progress > 0 AND books.last_read_at IS NOT NULL
       AND (books.root_id IS NULL OR library_roots.state = 'online')
       ORDER BY books.last_read_at DESC LIMIT ?`
    )
    .all(...params, limit) as BookRow[]
  return rows.map(toBookDTO)
}

export function countBooks(
  db: Db,
  query: { rootId?: string; favoritesOnly?: boolean }
): number {
  const conditions: string[] = []
  const params: unknown[] = []
  if (query.rootId) {
    conditions.push('root_id = ?')
    params.push(query.rootId)
  }
  if (query.favoritesOnly) conditions.push('favorite = 1')
  const where = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''
  return asCount(db.prepare(`SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL${where}`).get(...params) as {
    n: number
  })
}

export function listShelves(db: Db): import('@shared/dto').ShelfDTO[] {
  const rows = db
    .prepare(
      `SELECT shelves.id, shelves.name, shelves.icon, shelves.sort, shelves.created_at,
              (SELECT COUNT(*) FROM shelf_books sb JOIN books b ON b.id = sb.book_id
                WHERE sb.shelf_id = shelves.id AND b.deleted_at IS NULL) AS book_count
       FROM shelves ORDER BY shelves.sort, shelves.created_at`
    )
    .all() as { id: string; name: string; icon: string | null; sort: number; created_at: number; book_count: number }[]
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    sort: row.sort,
    bookCount: row.book_count,
    createdAt: row.created_at
  }))
}

export function getShelf(db: Db, shelfId: string): import('@shared/dto').ShelfDTO | null {
  return listShelves(db).find((shelf) => shelf.id === shelfId) ?? null
}

export function booksRepo(db: Db = getDb()) {
  return {
    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL').get() as
        | { n: number }
        | undefined
      return asCount(row)
    },
    /** 章节表的实际行数；用于断言「没有孤儿子章节」 */
    chapterCount(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number } | undefined
      return asCount(row)
    },
    /** 没有对应书籍的章节（正常情况下应恒为 0，外键 CASCADE 保证） */
    orphanChapters(): number {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM chapters c LEFT JOIN books b ON b.id = c.book_id WHERE b.id IS NULL')
        .get() as { n: number } | undefined
      return asCount(row)
    },
    findByRootAndRelPath(rootId: string, relPath: string) {
      return db
        .prepare('SELECT id, title, chapter_count FROM books WHERE root_id = ? AND rel_path = ? AND deleted_at IS NULL')
        .get(rootId, relPath) as { id: string; title: string; chapter_count: number } | undefined
    }
  }
}
