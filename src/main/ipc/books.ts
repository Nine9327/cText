/**
 * 书籍列表 IPC（M1-08 / M1-09 / M1-10）。
 *
 * 三个通道的分工：
 *   - books:list   列表主体（SQL 分页下推 + 排序 + FTS 搜索）
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

/**
 * 搜索请求观测（仅 `CTEXT_SEARCH_SMOKE=1` 的验收进程会填）。
 *
 * 防抖是渲染层行为，主进程只能看到「实际发了几次请求」——而这恰好就是防抖的
 * 唯一证据：逐字符输入 5 次必须只产生 1 条记录，且时间戳落在最后一次输入之后
 * ≥200ms（防抖窗口）。记录带上 `at` 才能断言窗口，只数次数会把「立即发送但
 * 请求被合并」误判成通过。
 */
export interface KeywordCall {
  keyword: string
  at: number
}

export const keywordCalls: KeywordCall[] = []

export function registerBooksIpc(): void {
  registerHandler('books:list', ({ rootId, favoritesOnly, shelfId, keyword, sort, offset, limit }) => {
    if (process.env['CTEXT_SEARCH_SMOKE'] === '1' && keyword) {
      keywordCalls.push({ keyword, at: Date.now() })
    }
    const { items, total } = listBooks(getDb(), { rootId, favoritesOnly, shelfId, keyword, sort, offset, limit })
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
