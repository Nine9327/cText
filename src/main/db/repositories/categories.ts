/**
 * 分类仓储（M3-03）。分类是**题材标签**，与「收藏」（单布尔）和「我的书架」
 * （阅读安排的分组）是三套独立语义，三者不可互相替代（产品文档 §2.5）。
 *
 * 两条约定：
 *   1. 多对多：一本书可以同时是「科幻」和「已完结」。所以设置分类是**整体替换**
 *      （`library:setCategories` 传入完整 id 列表），不是增删单条——否则界面上
 *      勾一个发一个请求，中间态一旦失败就会留下半套标签。
 *   2. 名字唯一（DDL 里有 UNIQUE）。重名分类在筛选器里是两个一模一样的选项，
 *      用户没法选对；所以重名要当场拒绝并说明。
 */
import type { Db } from '../connection'
import type { CategoryDTO } from '@shared/dto'

interface CategoryRow {
  id: string
  name: string
  color: string | null
  sort: number
  book_count: number
}

const CATEGORY_SELECT = `
  SELECT categories.id, categories.name, categories.color, categories.sort,
         (SELECT COUNT(*) FROM book_categories bc JOIN books b ON b.id = bc.book_id
           WHERE bc.category_id = categories.id AND b.deleted_at IS NULL) AS book_count
  FROM categories`

const toDTO = (row: CategoryRow): CategoryDTO => ({
  id: row.id,
  name: row.name,
  color: row.color,
  sort: row.sort,
  bookCount: row.book_count
})

export function listCategories(db: Db): CategoryDTO[] {
  return (db.prepare(`${CATEGORY_SELECT} ORDER BY categories.sort, categories.name`).all() as CategoryRow[]).map(
    toDTO
  )
}

export function getCategory(db: Db, id: string): CategoryDTO | null {
  const row = db.prepare(`${CATEGORY_SELECT} WHERE categories.id = ?`).get(id) as CategoryRow | undefined
  return row ? toDTO(row) : null
}

/** 同名校验：新建与改名共用。返回撞名的那个 id（排除自己） */
export function findCategoryByName(db: Db, name: string, excludeId?: string): string | null {
  const row = db
    .prepare('SELECT id FROM categories WHERE name = ? AND (? IS NULL OR id <> ?)')
    .get(name, excludeId ?? null, excludeId ?? null) as { id: string } | undefined
  return row?.id ?? null
}

export function createCategory(db: Db, id: string, name: string, color: string | null): CategoryDTO {
  const max = db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM categories').get() as { m: number }
  db.prepare('INSERT INTO categories (id, name, color, sort) VALUES (?, ?, ?, ?)').run(id, name, color, max.m + 1)
  return { id, name, color, sort: max.m + 1, bookCount: 0 }
}

export function updateCategory(
  db: Db,
  id: string,
  patch: { name?: string; color?: string | null; sort?: number }
): CategoryDTO | null {
  const current = getCategory(db, id)
  if (!current) return null
  db.prepare('UPDATE categories SET name = ?, color = ?, sort = ? WHERE id = ?').run(
    patch.name ?? current.name,
    patch.color === undefined ? current.color : patch.color,
    patch.sort ?? current.sort,
    id
  )
  return getCategory(db, id)
}

/**
 * 删除分类。`book_categories` 由外键 CASCADE 清掉，**书籍一行不动**——
 * 标签消失不该让书跟着消失。
 */
export function removeCategory(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0
}

/**
 * 整体替换一本书的分类。
 *
 * 传空数组 = 清空标签。`INSERT OR IGNORE` 挡重复 id（前端勾重了也不会炸）；
 * 不存在的 categoryId 会被外键拒绝，所以在事务里逐条插并统计失败数。
 */
export function setBookCategories(db: Db, bookId: string, categoryIds: string[]): number {
  const unique = Array.from(new Set(categoryIds))
  let written = 0
  db.transaction(() => {
    db.prepare('DELETE FROM book_categories WHERE book_id = ?').run(bookId)
    const insert = db.prepare('INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)')
    for (const categoryId of unique) written += insert.run(bookId, categoryId).changes
  })()
  return written
}

export function categoriesOfBook(db: Db, bookId: string): CategoryDTO[] {
  const rows = db
    .prepare(`${CATEGORY_SELECT} WHERE categories.id IN (SELECT category_id FROM book_categories WHERE book_id = ?)
              ORDER BY categories.sort, categories.name`)
    .all(bookId) as CategoryRow[]
  return rows.map(toDTO)
}
