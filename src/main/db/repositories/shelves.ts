/**
 * 书架仓储（M3-02）。
 *
 * 语义边界（产品文档 §2.5，三者不可混）：
 *   - **收藏**：`books.favorite` 单个布尔，一本书只有「收藏/没收藏」；
 *   - **我的书架**：多对多分组，同一本书可以同时属于「科幻」「待读」两个书架；
 *   - **分类**：题材标签，也是多对多，但用于描述书本身而不是阅读安排。
 *
 * 三条硬约定：
 *   1. **删除书架只删关联**：`shelf_books` 靠外键 CASCADE 一起走，`books` 一行不动。
 *      「删了书架书就没了」是这类软件最不可原谅的事故。
 *   2. **架内顺序是一等公民**：`shelf_books.sort` 为 0..n-1 连续整数，任何增删之后都
 *      重排一遍。留空洞不会出错，但「插到第 3 位」要算半天，重排只有几十行。
 *   3. 所有多行改动在一个事务里：排序写一半崩了，书架顺序会变成两段重复的序号。
 */
import type { Db } from '../connection'
import type { ShelfDTO } from '@shared/dto'

interface ShelfRow {
  id: string
  name: string
  icon: string | null
  sort: number
  created_at: number
  book_count: number
}

const SHELF_SELECT = `
  SELECT shelves.id, shelves.name, shelves.icon, shelves.sort, shelves.created_at,
         (SELECT COUNT(*) FROM shelf_books sb JOIN books b ON b.id = sb.book_id
           WHERE sb.shelf_id = shelves.id AND b.deleted_at IS NULL) AS book_count
  FROM shelves`

const toShelfDTO = (row: ShelfRow): ShelfDTO => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  sort: row.sort,
  bookCount: row.book_count,
  createdAt: row.created_at
})

export function listShelves(db: Db): ShelfDTO[] {
  return (db.prepare(`${SHELF_SELECT} ORDER BY shelves.sort, shelves.created_at`).all() as ShelfRow[]).map(
    toShelfDTO
  )
}

export function getShelf(db: Db, shelfId: string): ShelfDTO | null {
  const row = db.prepare(`${SHELF_SELECT} WHERE shelves.id = ?`).get(shelfId) as ShelfRow | undefined
  return row ? toShelfDTO(row) : null
}

/** 新书架排到末尾（`sort` 取当前最大值 +1） */
export function createShelf(db: Db, id: string, name: string, now: number): ShelfDTO {
  const max = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM shelves').get() as { m: number }
  db.prepare('INSERT INTO shelves (id, name, icon, sort, created_at) VALUES (?, ?, NULL, ?, ?)').run(
    id,
    name,
    max.m + 1,
    now
  )
  // 不用 getShelf 拼：刚插入的行 book_count 恒为 0，省一次查询
  return { id, name, icon: null, sort: max.m + 1, bookCount: 0, createdAt: now }
}

export function renameShelf(db: Db, shelfId: string, name: string): ShelfDTO | null {
  const info = db.prepare('UPDATE shelves SET name = ? WHERE id = ?').run(name, shelfId)
  return info.changes > 0 ? getShelf(db, shelfId) : null
}

/**
 * 删除书架。**只删关联，不删书**——`shelf_books` 由外键 CASCADE 清理，
 * `books` 一行不动。返回 false 表示书架本来就不存在。
 */
export function removeShelf(db: Db, shelfId: string): boolean {
  return db.prepare('DELETE FROM shelves WHERE id = ?').run(shelfId).changes > 0
}

/**
 * 加入书架。已在架上的书不重复插（`INSERT OR IGNORE` 靠主键冲突），
 * 新书一律追加到末尾，顺序沿用用户在书架页看到的排列。
 */
export function addBooksToShelf(db: Db, shelfId: string, bookIds: string[], now: number): number {
  return addBooksToShelfDetailed(db, shelfId, bookIds, now).added
}

/**
 * 与 `addBooksToShelf` 同实现，但**回传真正新增的 bookIds**。
 *
 * 撤销「批量加入书架」必须知道哪些是这次加进去的：原本就在架上的书不能跟着被移出。
 * 计数（`added`）只能回答「加了几本」，回答不了「加的是哪几本」。
 */
export function addBooksToShelfDetailed(
  db: Db,
  shelfId: string,
  bookIds: string[],
  now: number
): { added: number; bookIds: string[] } {
  let added = 0
  const touched: string[] = []
  const max = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM shelf_books WHERE shelf_id = ?').get(shelfId) as {
    m: number
  }
  let next = max.m + 1
  const insert = db.prepare('INSERT OR IGNORE INTO shelf_books (shelf_id, book_id, sort, added_at) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (const bookId of bookIds) {
      const changes = insert.run(shelfId, bookId, next, now).changes
      if (changes > 0) {
        added += changes
        touched.push(bookId)
      }
      next += 1
    }
  })()
  return { added, bookIds: touched }
}

export function removeBooksFromShelf(db: Db, shelfId: string, bookIds: string[]): number {
  let removed = 0
  db.transaction(() => {
    const del = db.prepare('DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?')
    for (const bookId of bookIds) removed += del.run(shelfId, bookId).changes
    // 删完立刻压实序号：留着空洞时「第几本」与 sort 值对不上，拖拽会跳格
    renumber(db, shelfId)
  })()
  return removed
}

/** 把 `shelf_books.sort` 压成 0..n-1（按现有 sort、added_at 定序，保证稳定） */
function renumber(db: Db, shelfId: string): void {
  const rows = db
    .prepare('SELECT book_id FROM shelf_books WHERE shelf_id = ? ORDER BY sort, added_at')
    .all(shelfId) as { book_id: string }[]
  const update = db.prepare('UPDATE shelf_books SET sort = ? WHERE shelf_id = ? AND book_id = ?')
  rows.forEach((row, index) => update.run(index, shelfId, row.book_id))
}

/**
 * 把一本书移到架内第 `toIndex` 位（0 基）。
 *
 * 做法是「先摘出来再插回去，然后整体重排」——只改这一条的 sort 值会让它与
 * 目标位置的邻居撞号，撞号之后顺序由 SQLite 的物理顺序决定，表现为
 * 「拖了但没动」。重排几十行远比调试这种幽灵顺序便宜。
 */
export function moveBookInShelf(db: Db, shelfId: string, bookId: string, toIndex: number): boolean {
  let moved = false
  db.transaction(() => {
    const rows = db
      .prepare('SELECT book_id FROM shelf_books WHERE shelf_id = ? ORDER BY sort, added_at')
      .all(shelfId) as { book_id: string }[]
    const ids = rows.map((row) => row.book_id)
    const from = ids.indexOf(bookId)
    if (from < 0) return
    const to = Math.max(0, Math.min(ids.length - 1, toIndex))
    ids.splice(from, 1)
    ids.splice(to, 0, bookId)
    const update = db.prepare('UPDATE shelf_books SET sort = ? WHERE shelf_id = ? AND book_id = ?')
    ids.forEach((id, index) => update.run(index, shelfId, id))
    moved = from !== to
  })()
  return moved
}

/** 侧栏书架排序（拖拽后传完整 id 序列） */
export function reorderShelves(db: Db, shelfIds: string[]): void {
  db.transaction(() => {
    const update = db.prepare('UPDATE shelves SET sort = ? WHERE id = ?')
    shelfIds.forEach((id, index) => update.run(index, id))
  })()
}
