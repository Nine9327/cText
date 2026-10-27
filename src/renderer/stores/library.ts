/**
 * 书库视图状态（当前根目录、各入口的书籍集合）。
 *
 * M0-08 阶段数据来自 `mock/library.ts`，但**接口形状按 M1 的真实查询设计**：
 * 都是「按当前根目录过滤后的列表」+ 计数，M1 只需把 computed 换成 useQuery 即可，
 * 侧栏组件不用改。
 *
 * 为什么选中根目录放在 store 而不是路由 query：书库切换是**全局过滤条件**，
 * 切换后侧栏、列表、收藏、书架四个入口同时生效，放路由会四处透传。
 * 也刻意**不持久化**——下次启动回到「全部书库」，避免用户以为书丢了（见计划 §3.8）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ALL_ROOTS_ID,
  favoriteIds,
  mockBooks,
  mockRoots,
  mockShelves,
  mockSources,
  type MockBook,
  type MockRoot,
  type MockShelf,
  type MockSource
} from '@/mock/library'

export interface ShelfWithBooks extends MockShelf {
  count: number
  books: MockBook[]
}

export const useLibraryStore = defineStore('library', () => {
  const roots = ref<MockRoot[]>(mockRoots)
  const activeRootId = ref<string>(ALL_ROOTS_ID)

  const activeRoot = computed<MockRoot>(
    () => roots.value.find((root) => root.id === activeRootId.value) ?? roots.value[0]!
  )

  /** 当前根目录范围内的书；「全部书库」不过滤 */
  const books = computed<MockBook[]>(() =>
    activeRootId.value === ALL_ROOTS_ID
      ? mockBooks
      : mockBooks.filter((book) => book.rootId === activeRootId.value)
  )

  const favorites = computed<MockBook[]>(() =>
    books.value.filter((book) => favoriteIds.includes(book.id))
  )

  const shelves = computed<ShelfWithBooks[]>(() =>
    mockShelves.map((shelf) => {
      const shelfBooks = mockBooks.filter((book) => shelf.bookIds.includes(book.id))
      return { ...shelf, count: shelfBooks.length, books: shelfBooks }
    })
  )

  const sources = computed<MockSource[]>(() => mockSources)

  /** 最近阅读：有进度且不在离线态，取前三。必须跟着根目录过滤走，否则切到移动硬盘还显示别处的书 */
  const recent = computed<MockBook[]>(() =>
    books.value.filter((book) => book.progress > 0 && book.state !== 'offline').slice(0, 3)
  )

  /** 根目录计数：全部书库取总数，其余取该目录下的数量 */
  const rootCount = (rootId: string): number =>
    rootId === ALL_ROOTS_ID
      ? mockBooks.length
      : mockBooks.filter((book) => book.rootId === rootId).length

  const total = computed(() => mockBooks.length)
  const offlineCount = computed(() => books.value.filter((book) => book.state === 'offline').length)

  function selectRoot(rootId: string): boolean {
    if (!roots.value.some((root) => root.id === rootId)) return false
    activeRootId.value = rootId
    return true
  }

  function shelfById(shelfId: string | undefined): ShelfWithBooks | null {
    if (!shelfId) return null
    return shelves.value.find((shelf) => shelf.id === shelfId) ?? null
  }

  function booksOfShelf(shelfId: string | undefined): MockBook[] {
    return shelfById(shelfId)?.books ?? []
  }

  function sourceById(sourceId: string | undefined): MockSource | null {
    if (!sourceId) return null
    return sources.value.find((source) => source.id === sourceId) ?? null
  }

  return {
    roots,
    activeRootId,
    activeRoot,
    books,
    favorites,
    shelves,
    sources,
    recent,
    total,
    offlineCount,
    rootCount,
    selectRoot,
    shelfById,
    booksOfShelf,
    sourceById
  }
})
