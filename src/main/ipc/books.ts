/**
 * 书籍列表 IPC（M1-08）。
 *
 * 三个通道的分工：
 *   - books:list   列表主体（SQL 分页下推，M1-09 的排序筛选也在这里扩展）
 *   - books:count  只取计数（侧栏「收藏」角标用，避免为拿一个数字拉整页列表）
 *   - books:recent 最近阅读（书库首页横排，只给有进度的在线书）
 *
 * 书架页（/shelves/:id）直接用 books:list 的 shelfId 过滤，不单开通道——
 * 三视图、分页、虚拟滚动在书架页与书库页完全一致，分开写只会分叉。
 * shelves:list 的真实现也在这里补上（M0-08 的占位是 E_NOT_IMPLEMENTED，
 * 同名 handler 注册即覆盖）。
 */
import type { BookDTO, Paged, ShelfDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { countBooks, getShelf, listBooks, listShelves, recentBooks } from '../db/repositories/books'
import { registerHandler } from './registry'

export function registerBooksIpc(): void {
  registerHandler('books:list', ({ rootId, favoritesOnly, shelfId, offset, limit }) => {
    const { items, total } = listBooks(getDb(), { rootId, favoritesOnly, shelfId, offset, limit })
    const paged: Paged<BookDTO> = { items, total, offset, limit }
    return paged
  })

  registerHandler('books:count', ({ rootId, favoritesOnly }) => ({
    total: countBooks(getDb(), { rootId, favoritesOnly })
  }))

  registerHandler('books:recent', ({ rootId, limit }) => recentBooks(getDb(), rootId, limit ?? 3))

  registerHandler('shelves:list', (): ShelfDTO[] => listShelves(getDb()))
  registerHandler('shelves:get', ({ shelfId }): ShelfDTO | null => getShelf(getDb(), shelfId))
}
