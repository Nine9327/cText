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
  /** 标题/作者/简介的全文匹配（FTS5 前缀查询，M1-10） */
  keyword?: string
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
const ORDER_BY: Record<Exclude<BookSortField, 'shelfOrder'>, string> = {
  createdAt: 'books.created_at',
  lastReadAt: 'books.last_read_at IS NULL, books.last_read_at',
  title: 'books.title COLLATE NOCASE',
  author: 'books.author IS NULL, books.author COLLATE NOCASE',
  progress: 'books.progress'
}

/**
 * ORDER BY 子句 + 它自己需要的绑定参数。
 *
 * `shelfOrder`（M3-02）用**相关子查询**取 `shelf_books.sort`，不 join：
 * 书架的列表与计数走同一段 where，多一个 join 就要在两条 SQL 里各改一遍。
 * 方向恒 ASC——架内顺序是「位置」，反转没有语义。
 */
function orderByClause(sort: BookSort | undefined, shelfId: string | undefined): { clause: string; params: unknown[] } {
  const field = sort?.field
  if (field === 'shelfOrder') {
    if (!shelfId) return { clause: 'books.created_at DESC, books.id DESC', params: [] }
    const expr = '(SELECT sort FROM shelf_books WHERE shelf_id = ? AND book_id = books.id)'
    return { clause: `${expr} ASC, books.id ASC`, params: [shelfId] }
  }
  const key = field && field in ORDER_BY ? (field as Exclude<BookSortField, 'shelfOrder'>) : 'createdAt'
  const direction = sort?.direction === 'asc' ? 'ASC' : 'DESC'
  return { clause: `${ORDER_BY[key]} ${direction}, books.id ${direction}`, params: [] }
}

/**
 * 用户输入 → FTS5 查询串（M1-10）。
 *
 * 两条硬要求：
 *   1. **不能把输入原样塞进 MATCH**。FTS5 查询语法里 `" * ( ) : ^ -` 都有含义，
 *      用户搜一个孤立引号就能让整条 SQL 报 "unterminated string"——表现为列表空白 +
 *      内部错误，而用户只是打错了一个字符。这里把语法字符当分隔符扔掉。
 *   2. **每个词补 `*` 前缀**。unicode61 把连续汉字当成一个 token，只有前缀匹配才能命中
 *      「三体」「万历」这类书名开头；中间词（「经济」之于「中国政府与经济发展」）本版
 *      不命中——这是分词器口径，换 trigram 才能解，而 trigram 对 2 字词直接失效
 *      （中文书名两字太常见，代价不可接受）。产品文档 §2.10 的口径同样是「前缀匹配」。
 */
export function toFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/["*()^:+-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
  return tokens.map((token) => `"${token}"*`).join(' AND ')
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
  if (query.keyword) {
    const match = toFtsQuery(query.keyword)
    if (match) {
      // 子查询而不是 join：books_fts 是外部内容表，join 时 MATCH 只能写在 ON/FROM 上，
      // 而 IN 子查询对 count 与 list 两条 SQL 一模一样（count 那条没有 join library_roots）
      conditions.push('books.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)')
      params.push(match)
    }
  }
  const where = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''

  const total = asCount(
    db.prepare(`SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL${where}`).get(...params) as { n: number }
  )
  const order = orderByClause(query.sort, query.shelfId)
  const rows = db
    .prepare(`${BOOK_SELECT}${where} ORDER BY ${order.clause} LIMIT ? OFFSET ?`)
    .all(...params, ...order.params, query.limit, query.offset) as BookRow[]

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

/**
 * 书架（`shelves` / `shelf_books`）的读写全部搬到了 `repositories/shelves.ts`（M3-02）：
 * 那边有 CRUD、架内排序与「删书架不删书」的约束，放在这里会和「书」的查询逻辑搅在一起。
 */

/**
 * 收藏开关（M3-01）。
 *
 * **不碰 `updated_at`**：它是阅读器章节缓存的版本号（`bookId:idx:updated_at`），
 * 收藏是纯标记，改它等于「点一下星标就把整章缓存作废」，下次翻回来要重新读盘。
 * 同理也不写 `books_fts`——触发器只跟着 title/author/intro 的更新走，
 * 这里不动这三列。
 *
 * 返回 false 表示书不存在或已软删除，调用方据此报错而不是静默成功。
 */
export function setFavorite(db: Db, id: string, value: boolean): boolean {
  const info = db
    .prepare('UPDATE books SET favorite = ? WHERE id = ? AND deleted_at IS NULL')
    .run(value ? 1 : 0, id)
  return info.changes > 0
}

/**
 * 整本目录（M2-06）。
 *
 * 只取 `idx / title / level`：抽屉要渲染上千行，`anchor/length` 这些正文用的字段
 * 一个都不需要，把它们塞进 DTO 会让千章目录多搬几十 KB 的无用字符串。
 */
export function listChapters(db: Db, bookId: string): import('@shared/dto').ChapterDTO[] {
  return db
    .prepare('SELECT idx, title, level FROM chapters WHERE book_id = ? ORDER BY idx')
    .all(bookId) as { idx: number; title: string; level: number }[]
}

/**
 * 单本书的完整信息（`library:get`，M2-04 起被阅读器使用）。
 *
 * 与列表查询分开写一条 SQL 的理由：详情需要 `intro / word_count / rel_path` 等
 * 列表用不上的列，塞进 BOOK_SELECT 会让「万本列表」每行多搬几百字节的简介。
 *
 * 返回 null 表示书不存在或已软删除——**离线不算 null**：根目录离线时书还在，
 * 阅读器要靠 `offline` 字段给出「插上磁盘」而不是「文件没了」的提示。
 */
export function getBookDetail(db: Db, id: string): import('@shared/dto').BookDetailDTO | null {
  const row = db
    .prepare(
      `SELECT books.id, books.title, books.author, books.series, books.format,
              books.favorite, books.read_state, books.progress, books.chapter_count,
              books.root_id, books.source_type, books.last_read_at,
              books.created_at, books.updated_at,
              books.intro, books.publisher, books.pub_date, books.language,
              books.word_count, books.size_bytes, books.encoding,
              books.rel_path, books.source_id, books.source_url,
              library_roots.state AS root_state
       FROM books LEFT JOIN library_roots ON library_roots.id = books.root_id
       WHERE books.deleted_at IS NULL AND books.id = ?`
    )
    .get(id) as
    | (BookRow & {
        intro: string | null
        publisher: string | null
        pub_date: string | null
        language: string | null
        word_count: number | null
        size_bytes: number
        encoding: string | null
        rel_path: string | null
        source_id: string | null
        source_url: string | null
      })
    | undefined
  if (!row) return null

  const categories = db
    .prepare(
      `SELECT c.id, c.name, c.color, c.sort
       FROM book_categories bc JOIN categories c ON c.id = bc.category_id
       WHERE bc.book_id = ? ORDER BY c.sort, c.name`
    )
    .all(id) as { id: string; name: string; color: string | null; sort: number }[]

  const shelves = db
    .prepare(
      `SELECT s.id, s.name
       FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id
       WHERE sb.book_id = ? ORDER BY s.sort, s.name`
    )
    .all(id) as { id: string; name: string }[]

  return {
    ...toBookDTO(row),
    intro: row.intro,
    publisher: row.publisher,
    pubDate: row.pub_date,
    language: row.language,
    wordCount: row.word_count,
    sizeBytes: row.size_bytes,
    encoding: row.encoding,
    relPath: row.rel_path,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    categories,
    shelves
  }
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
