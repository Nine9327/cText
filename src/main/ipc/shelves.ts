/**
 * 书架 IPC（M3-02）。
 *
 * 与 `ipc/books.ts` 分开的理由：书架有自己的一整套约束（删书架不删书、
 * 架内顺序、侧栏顺序），塞在书籍列表旁边会让那个文件同时管两件事。
 *
 * 三个「写」通道的共同点：**返回值是受影响的条数**，不是 void。
 * `addBooks` 返回 0 表示「这些书已经都在架上了」，渲染层据此说「已在书架中」
 * 而不是谎报成功——用户点了确认却什么都没变，是最难自查的一类 bug。
 */
import { randomUUID } from 'node:crypto'
import type { ShelfDTO } from '@shared/dto'
import { AppError, ERROR_CODES } from '@shared/errors'
import { getDb } from '../db/connection'
import {
  addBooksToShelfDetailed,
  createShelf,
  getShelf,
  listShelves,
  moveBookInShelf,
  removeBooksFromShelf,
  removeShelf,
  renameShelf,
  reorderShelves
} from '../db/repositories/shelves'
import { registerHandler } from './registry'

export function registerShelvesIpc(): void {
  registerHandler('shelves:list', (): ShelfDTO[] => listShelves(getDb()))
  registerHandler('shelves:get', ({ shelfId }): ShelfDTO | null => getShelf(getDb(), shelfId))

  registerHandler('shelves:create', ({ name }): ShelfDTO =>
    // ID 用 UUID 而不是 ULID：书架是用户资料，没有「按创建时间排序」的需求
    createShelf(getDb(), `sh_${randomUUID().slice(0, 8)}`, name, Date.now())
  )

  registerHandler('shelves:rename', ({ shelfId, name }): ShelfDTO | null => {
    const shelf = renameShelf(getDb(), shelfId, name)
    if (!shelf) throw new AppError(ERROR_CODES.notFound, '书架不存在，可能已被删除')
    return shelf
  })

  /**
   * 删除书架。`shelf_books` 由外键 CASCADE 清理，`books` 一行不动——
   * 这是产品文档 §2.5 写死的：「删除书架不删书」。
   */
  registerHandler('shelves:remove', ({ shelfId }) => {
    if (!removeShelf(getDb(), shelfId)) {
      throw new AppError(ERROR_CODES.notFound, '书架不存在，可能已被删除')
    }
  })

  registerHandler('shelves:addBooks', ({ shelfId, bookIds }) => {
    if (!getShelf(getDb(), shelfId)) throw new AppError(ERROR_CODES.notFound, '书架不存在，可能已被删除')
    // 回传真正新增的 bookIds：撤销时要按它来，按入参会把原本在架上的书也移出去
    return addBooksToShelfDetailed(getDb(), shelfId, bookIds, Date.now())
  })

  registerHandler('shelves:removeBooks', ({ shelfId, bookIds }) => ({
    removed: removeBooksFromShelf(getDb(), shelfId, bookIds)
  }))

  registerHandler('shelves:moveBook', ({ shelfId, bookId, toIndex }) => {
    if (!moveBookInShelf(getDb(), shelfId, bookId, toIndex)) {
      // 顺序没变不算错误（拖回原位很常见），但书不在架上要报
      const onShelf = getDb()
        .prepare('SELECT 1 AS x FROM shelf_books WHERE shelf_id = ? AND book_id = ?')
        .get(shelfId, bookId) as { x: number } | undefined
      if (!onShelf) throw new AppError(ERROR_CODES.notFound, '这本书不在该书架中')
    }
  })

  registerHandler('shelves:reorder', ({ shelfIds }) => {
    reorderShelves(getDb(), shelfIds)
  })
}
