/**
 * 书库视图状态（M1-08 起为真实数据）。
 *
 * 三条数据通路：
 *   - 根目录：roots:list + roots:changed 订阅（M1-01 的监测会广播状态变化）
 *   - 书籍：books:list 增量分页（SQL 下推），切换根目录 / 书架 / 收藏域时重置
 *   - 书架：shelves:list（管理操作属 M3-02，这里只读）
 *
 * 为什么手写分页而不用 TanStack Query：列表是**增量追加**（虚拟滚动触底
 * loadMore），query 缓存对这种形态不顺手；且 roots:changed 的失效时机由
 * 主进程广播决定，直接订阅更直白。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { BookDTO, BookSort, RootDTO, ShelfDTO } from '@shared/dto'
import { call, on } from '@/api/client'

/** 「全部书库」是渲染层虚拟出来的入口，不对应任何 roots 行 */
export const ALL_ROOTS_ID = 'all'

/** 每页拉多少本。120 张卡在 1080p 下约两屏半，触底加载无感 */
const PAGE_SIZE = 120

/** 当前查询域。三个入口共用一条数据通路（详见 store 内注释） */
export interface LibraryDomain {
  rootId?: string
  favoritesOnly?: boolean
  shelfId?: string
}

export interface RootView {
  id: string
  label: string
  path: string
  online: boolean
  bookCount: number
}

export const useLibraryStore = defineStore('library', () => {
  const roots = ref<RootView[]>([])
  const shelves = ref<ShelfDTO[]>([])
  const activeRootId = ref<string>(ALL_ROOTS_ID)

  const books = ref<BookDTO[]>([])
  const booksTotal = ref(0)
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref<string | null>(null)

  const favCount = ref(0)
  const recent = ref<BookDTO[]>([])

  const domain = ref<LibraryDomain>({})

  /**
   * 搜索关键字（M1-10）。与域正交：在「收藏」页也能搜，换根目录时关键字保留
   * （用户搜到一半切书库，不该把输入清掉）。防抖在视图层做，这里只负责
   * 「接受终值并重拉第一页」。
   */
  const keyword = ref('')

  /**
   * 排序偏好（M1-09）。5 种排序跨三个入口共享一份——在书架页选了「书名」，
   * 回到书库页仍是「书名」，这是用户预期的「列表排序」而不是「某页的排序」。
   * 目前只存在内存里（与三视图偏好同批，落 settings 表属 M5）。
   */
  const sort = ref<BookSort>({ field: 'createdAt', direction: 'desc' })

  /** 当前生效的根目录；「全部书库」时 rootId 传 undefined */
  const activeRoot = computed<RootView>(
    () =>
      roots.value.find((root) => root.id === activeRootId.value) ?? {
        id: ALL_ROOTS_ID,
        label: '全部书库',
        path: '',
        online: true,
        bookCount: 0
      }
  )
  const isAllRoots = computed(() => activeRootId.value === ALL_ROOTS_ID)
  /** 根目录离线 → 该域内书籍全部只可看不可读（横幅 + 角标的依据） */
  const activeRootOnline = computed(() => isAllRoots.value || activeRoot.value.online)

  const totalBookCount = computed(() => roots.value.reduce((sum, root) => sum + root.bookCount, 0))
  const rootCount = (rootId: string): number => {
    if (rootId === ALL_ROOTS_ID) return totalBookCount.value
    return roots.value.find((root) => root.id === rootId)?.bookCount ?? 0
  }

  function scope(): LibraryDomain {
    return { ...domain.value }
  }

  async function loadRoots(): Promise<void> {
    const rows = await call('roots:list')
    roots.value = rows.map((row: RootDTO) => ({
      id: row.id,
      label: row.label,
      path: row.path,
      online: row.state === 'online',
      bookCount: row.bookCount
    }))
    // 当前选中的根目录被移除时回到「全部书库」，不能停留在幽灵 id 上
    if (activeRootId.value !== ALL_ROOTS_ID && !roots.value.some((root) => root.id === activeRootId.value)) {
      activeRootId.value = ALL_ROOTS_ID
    }
  }

  async function loadShelves(): Promise<void> {
    shelves.value = await call('shelves:list')
  }

  async function loadFavCount(): Promise<void> {
    const { total } = await call('books:count', { ...scope(), favoritesOnly: true })
    favCount.value = total
  }

  async function loadRecent(): Promise<void> {
    recent.value = await call('books:recent', { ...scope(), limit: 3 })
  }

  /**
   * 收藏开关（M3-01）。
   *
   * 三处状态要一起动：列表里那张卡、侧栏计数、（收藏页上取消收藏后）这张卡本身
   * 该消失。**不能靠 reload() 解决**——整表重拉会把「已经加载的 84 页」与滚动
   * 位置一起丢掉，翻到第 500 本点一下星标就跳回第一页。
   *
   * 传目标值而不是「切换」：双击时两次 IPC 若不巧乱序，切换语义会把状态翻回去
   * （第一次 +1、第二次 -1），目标值语义下两次结果一致。
   */
  async function toggleFavorite(book: BookDTO): Promise<boolean> {
    const next = !book.favorite
    await call('library:toggleFavorite', { id: book.id, value: next })

    // 就地改：`books` 里的对象是 IPC 反序列化出来的普通对象，改它不会影响别的域
    const patch = (item: BookDTO): void => {
      if (item.id === book.id) item.favorite = next
    }
    books.value.forEach(patch)
    recent.value.forEach(patch)

    if (domain.value.favoritesOnly && !next) {
      books.value = books.value.filter((item) => item.id !== book.id)
      booksTotal.value = Math.max(0, booksTotal.value - 1)
    }
    await loadFavCount()
    return next
  }

  async function loadPage(offset: number): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      // sort 必须脱掉响应式代理：Vue 的 Proxy 不能结构化克隆，跨 IPC 会抛
      // "An object could not be cloned."，而错误只落到列表的 loadError 上
      const page = await call('books:list', {
        ...scope(),
        sort: { field: sort.value.field, direction: sort.value.direction },
        keyword: keyword.value || undefined,
        offset,
        limit: PAGE_SIZE
      })
      // 竞态保护：响应回来时域可能已经切走（快速连点根目录）。
      // 简单可靠的判据是「loaded 已经被本轮置位」之外的版本号——
      // 这里用 offset===0 整表替换 + 追加只发生在本轮域内，切域走 reload(0)
      books.value = offset === 0 ? page.items : [...books.value, ...page.items]
      booksTotal.value = page.total
      loaded.value = true
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : '加载书籍失败'
      if (offset === 0) {
        books.value = []
        booksTotal.value = 0
      }
    } finally {
      loading.value = false
    }
  }

  /** 域切换 / 数据变更后的整表重置 */
  async function reload(): Promise<void> {
    await Promise.all([loadRoots(), loadShelves(), loadFavCount(), loadRecent()])
    await loadPage(0)
  }

  async function loadMore(): Promise<void> {
    if (loading.value || books.value.length >= booksTotal.value) return
    await loadPage(books.value.length)
  }

  function selectRoot(rootId: string): boolean {
    if (rootId !== ALL_ROOTS_ID && !roots.value.some((root) => root.id === rootId)) return false
    activeRootId.value = rootId
    // 切换书库时若当前在收藏页，域要跟着换根目录（保持「收藏随根目录过滤」）
    if (domain.value.favoritesOnly) {
      domain.value = { ...scope0(), favoritesOnly: true }
    }
    void reload()
    return true
  }

  /** 与书库切换器解耦的根目录域（不含收藏标记） */
  function scope0(): { rootId?: string } {
    return isAllRoots.value ? {} : { rootId: activeRootId.value }
  }

  /** 由路由驱动的域切换（LibraryView watch route 调用） */
  function setDomain(next: LibraryDomain): void {
    domain.value = next
    void reload()
  }

  /** 关键字变化（视图层已做 200ms 防抖）：只重拉列表，与域/计数无关 */
  function setKeyword(next: string): void {
    const value = next.trim()
    if (value === keyword.value) return
    keyword.value = value
    void loadPage(0)
  }

  /** 排序切换：只重拉列表，不重建根目录/书架（它们与排序无关） */
  function setSort(next: BookSort): void {
    if (next.field === sort.value.field && next.direction === sort.value.direction) return
    // 存普通对象：reactive 代理过不了结构化克隆（IPC 会报 "could not be cloned"）
    sort.value = { field: next.field, direction: next.direction }
    void loadPage(0)
  }

  /** books 表有任何变化（导入完成 / 根目录上下线）后的统一刷新入口 */
  function refresh(): void {
    void reload()
  }

  /** 应用启动时调用一次；roots:changed 的订阅与应用同生命周期 */
  function bindEvents(): void {
    try {
      on('roots:changed', () => refresh())
    } catch {
      // 浏览器直连模式没有 preload
    }
  }

  return {
    roots,
    shelves,
    totalBookCount,
    activeRootId,
    activeRoot,
    isAllRoots,
    activeRootOnline,
    books,
    booksTotal,
    sort,
    keyword,
    loading,
    loaded,
    loadError,
    favCount,
    recent,
    pageSize: PAGE_SIZE,
    loadMore,
    reload,
    refresh,
    selectRoot,
    setDomain,
    setSort,
    setKeyword,
    toggleFavorite,
    rootCount,
    bindEvents
  }
})
