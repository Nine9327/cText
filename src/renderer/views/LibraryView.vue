<script setup lang="ts">
/**
 * 书库列表视图（M1-08 起真实数据 + 虚拟滚动）。
 *
 * 同一组件承担三个入口：全部书籍 / 收藏的书籍 / 单个书架——区别只是查询域，
 * 由路由 watch 成 store 的 domain，一条 books:list 通路服务到底。
 *
 * **虚拟滚动为什么手写而不用 @tanstack/vue-virtual**：本页的滚动容器里有
 * 「最近阅读」等普通流式内容在虚拟层之上，库的 scrollMargin 语义要把头部
 * 高度喂进去并且 transform 还要补偿，绕；而这里是**固定行高**的行虚拟化，
 * 手写只有几十行且完全可控（见 visibleRows 的计算）。DOM 恒定只有可视窗口
 * ±4 行，1 万本也只渲染几十行。
 *
 * 数据分页：books:list 每页 120 本（SQL 下推），滚动接近底部时 loadMore
 * 追加。1 万本 = 84 页，预加载提前一屏半，滚动永不触顶等待。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SortMenu from '@/components/library/SortMenu.vue'
import CategoryFilter from '@/components/library/CategoryFilter.vue'
import CategoryManager from '@/components/library/CategoryManager.vue'
import BookContextMenu from '@/components/book/BookContextMenu.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import BookCard from '@/components/book/BookCard.vue'
import { pushToast } from '@/lib/toast'
import { call } from '@/api/client'
import { BOOK_MIME, getDragSource } from '@/lib/drag'
import { useImportStore } from '@/stores/import'
import { useLibraryStore } from '@/stores/library'
import type { BookDTO } from '@shared/dto'

const route = useRoute()
const router = useRouter()

/**
 * 点开一本书。
 *
 * 离线书也照常进阅读器：阅读器里有完整的离线面板（M2-11 会在那里接
 * 「重新指定目录」），比在列表里拦一个 toast 更有出路。
 * 网络书还没有正文通路（书源模块属 M4），先给提示而不是跳进一个空白阅读页。
 */
function openBook(book: BookDTO): void {
  if (book.sourceType === 'network') {
    pushToast({ level: 'info', message: '网络书阅读暂未开放' })
    return
  }
  void router.push(`/reader/${book.id}`)
}
const library = useLibraryStore()
const imports = useImportStore()

/**
 * 星标（M3-01）。
 *
 * 成功时不弹提示——星星本身变成了实心金色，这已经是反馈；再弹一条 toast
 * 等于在用户眼前重复同一件事。**唯一的例外是「收藏页里取消收藏」**：
 * 卡片会当场消失，不解释一句就成了「我的鼠标点坏了什么」。
 */
async function toggleFavorite(book: BookDTO): Promise<void> {
  try {
    const next = await library.toggleFavorite(book)
    if (!next && isFavorites.value) {
      pushToast({ level: 'info', message: `已取消收藏《${book.title}》，它已从收藏中移除` })
    }
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '收藏失败，请重试' })
  }
}

// ---------------------------------------------------------------- 书架（M3-02）

/** 书架页卡片上的「移出」：只解除分组，**不删书**（提示里要说清这一点） */
async function removeFromShelf(book: BookDTO): Promise<void> {
  if (!shelfId.value) return
  try {
    await library.removeFromShelf(shelfId.value, [book.id])
    pushToast({ level: 'info', message: `已把《${book.title}》移出书架，文件仍在书库中` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '移出书架失败' })
  }
}

/**
 * 架内拖拽排序：把书拖到另一张卡上 = 移到它的位置。
 *
 * 只在书架域生效——书库/收藏页的排序由排序菜单决定，拖动没有落点语义，
 * 而那里的拖动是为了「拖到侧栏书架上」。
 */
function onCardDragOver(event: DragEvent): void {
  if (!isShelf.value) return
  if ((event.dataTransfer?.types ?? []).includes(BOOK_MIME)) event.preventDefault()
}

async function onCardDrop(event: DragEvent, toIndex: number, target: BookDTO): Promise<void> {
  if (!isShelf.value || !shelfId.value) return
  const bookId = event.dataTransfer ? getDragSource('book') : null
  if (!bookId || bookId === target.id) return
  event.preventDefault()
  try {
    await library.moveBookInShelf(shelfId.value, bookId, toIndex)
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '移动失败' })
  }
}

const viewMode = ref<'grid' | 'detail' | 'list'>('grid')
/** 分类管理弹窗（M3-03）。筛选与 CRUD 分两个控件：一个管「看哪些」，一个管「有哪些」 */
const managingCategories = ref(false)

// ---------------------------------------------------------------- 批量与右键菜单（M3-05）

/**
 * 选择模式：卡片点击从「打开这本书」变成「选中」。**不做常驻多选**——
 * 常态下卡片点击是阅读（M1 起的手势，也是用户对阅读器最自然的预期），
 * 让 Ctrl+点击才能选中会把多选藏成一个没人发现的技巧。
 */
const selectionMode = ref(false)
const selected = ref<string[]>([])

const menu = ref<{ open: boolean; x: number; y: number; book: BookDTO | null }>({
  open: false,
  x: 0,
  y: 0,
  book: null
})

/** 批量操作的二级下拉（加入哪个书架 / 打哪个标签） */
const picker = ref<'shelf' | 'category' | null>(null)
/** 待确认「移出书库」的书 */
const removing = ref<BookDTO[]>([])

/**
 * 撤销栈（只留最近一次）。
 *
 * 只留一条是刻意的：批量操作是「一步大动作」，用户想撤的几乎总是刚做的那一下。
 * 留十条会让人在「撤销」上做考古，还会让界面出现一个没人维护的历史面板。
 */
const undo = ref<{ label: string; run: () => Promise<void> } | null>(null)

const selectedBooks = computed(() => library.books.filter((item) => selected.value.includes(item.id)))

function toggleSelectionMode(): void {
  selectionMode.value = !selectionMode.value
  selected.value = []
  picker.value = null
}

function toggleSelect(book: BookDTO): void {
  const index = selected.value.indexOf(book.id)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(book.id)
}

function selectAll(): void {
  selected.value = library.books.map((item) => item.id)
}

function onCardOpen(book: BookDTO): void {
  if (selectionMode.value) toggleSelect(book)
  else openBook(book)
}

function openMenu(event: MouseEvent, book: BookDTO): void {
  if (selectionMode.value) return
  menu.value = { open: true, x: event.clientX, y: event.clientY, book }
}

function closeMenu(): void {
  menu.value = { ...menu.value, open: false }
}

const menuBook = computed(() => menu.value.book)

/** 收藏 / 取消收藏（批量走一条 IPC，单选走既有通道） */
async function favoriteMany(value: boolean, books: BookDTO[]): Promise<void> {
  const changed = books.filter((item) => item.favorite !== value).map((item) => item.id)
  if (changed.length === 0) {
    pushToast({ level: 'info', message: value ? '这些书都已经收藏了' : '这些书都还没收藏' })
    return
  }
  try {
    const updated = await library.setFavoriteMany(changed, value)
    // 撤销要按「这次真正改动的那些」来，否则会把原本就是这个状态的书也翻回去
    undo.value = {
      label: `${value ? '收藏' : '取消收藏'} ${updated} 本`,
      run: async () => {
        await library.setFavoriteMany(changed, !value)
      }
    }
    pushToast({ level: 'info', message: `已${value ? '收藏' : '取消收藏'} ${updated} 本` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '批量收藏失败' })
  }
}

async function addToShelfMany(shelfId: string, books: BookDTO[]): Promise<void> {
  const shelf = library.shelves.find((item) => item.id === shelfId)
  picker.value = null
  try {
    const result = await library.addToShelf(
      shelfId,
      books.map((item) => item.id)
    )
    if (result.added === 0) {
      pushToast({ level: 'info', message: `这些书已经在「${shelf?.name ?? ''}」里了` })
      return
    }
    undo.value = {
      label: `加入书架 ${result.added} 本`,
      // 只撤销真正加进去的那些：原本在架上的书不能跟着被移出
      run: async () => {
        await library.removeFromShelf(shelfId, result.bookIds)
      }
    }
    pushToast({ level: 'info', message: `已加入「${shelf?.name ?? ''}」${result.added} 本` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '加入书架失败' })
  }
}

async function addCategoryMany(categoryId: string, books: BookDTO[]): Promise<void> {
  const category = library.categories.find((item) => item.id === categoryId)
  picker.value = null
  try {
    const result = await library.addCategories(
      books.map((item) => item.id),
      [categoryId]
    )
    if (result.updated === 0) {
      pushToast({ level: 'info', message: `这些书都已经有「${category?.name ?? ''}」标签了` })
      return
    }
    undo.value = {
      label: `打上分类 ${result.bookIds.length} 本`,
      run: async () => {
        await library.removeCategories(result.bookIds, [categoryId])
      }
    }
    pushToast({ level: 'info', message: `已给 ${result.bookIds.length} 本打上「${category?.name ?? ''}」` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '批量打标签失败' })
  }
}

async function confirmRemove(): Promise<void> {
  const books = removing.value
  removing.value = []
  if (books.length === 0) return
  const ids = books.map((item) => item.id)
  try {
    const removed = await library.removeMany(ids)
    undo.value = {
      label: `移出书库 ${removed} 本`,
      // 软删除是可逆的：恢复只是把 deleted_at 置空，文件从头到尾没被动过
      run: async () => {
        await library.restoreMany(ids)
      }
    }
    selected.value = selected.value.filter((id) => !ids.includes(id))
    pushToast({ level: 'info', message: `已从书库移除 ${removed} 本，文件仍保留在原目录` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '移除失败' })
  }
}

async function undoLast(): Promise<void> {
  const action = undo.value
  undo.value = null
  if (!action) return
  try {
    await action.run()
    pushToast({ level: 'info', message: `已撤销：${action.label}` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '撤销失败' })
  }
}

/** 右键菜单的单本动作复用同一批实现，只是把「一批」缩成「一本」 */
async function menuFavorite(): Promise<void> {
  const book = menuBook.value
  closeMenu()
  if (book) await toggleFavorite(book)
}

async function menuAddShelf(shelfId: string): Promise<void> {
  const book = menuBook.value
  closeMenu()
  if (book) await addToShelfMany(shelfId, [book])
}

async function menuAddCategory(categoryId: string): Promise<void> {
  const book = menuBook.value
  closeMenu()
  if (book) await addCategoryMany(categoryId, [book])
}

function menuRemove(): void {
  const book = menuBook.value
  closeMenu()
  if (book) removing.value = [book]
}

/** 右键菜单的单本动作复用同一批实现，只是把「一批」缩成「一本」 */
async function menuAction(kind: 'read' | 'detail' | 'rematch'): Promise<void> {
  const book = menuBook.value
  closeMenu()
  if (!book) return
  if (kind === 'read') return openBook(book)
  if (kind === 'detail') return void router.push(`/book/${book.id}`)

  // 重新识别（M3-06）：失败时主进程一个字段都不写，这里只需把错误说清楚
  try {
    const result = await call('library:rematch', { id: book.id })
    library.refresh()
    pushToast({
      level: 'info',
      message: result.changed.length > 0 ? `重新识别完成：${result.changed.join('、')}有更新` : '重新识别完成：没有发现变化'
    })
  } catch (err) {
    pushToast({
      level: 'error',
      message: err instanceof Error ? `重新识别失败（原信息未改动）：${err.message}` : '重新识别失败，原信息未改动'
    })
  }
}

/**
 * 搜索输入（M1-10）。**200ms 防抖在视图层**：store 只接受终值并重拉第一页，
 * 这样「切关键字」和「切根目录」走同一条 loadPage(0) 路径，不会有两套刷新逻辑。
 * 清空是即时生效的（不等防抖）——用户点 × 就是要立刻回到全量列表。
 */
const searchText = ref(library.keyword)
let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    library.setKeyword(searchText.value)
  }, 200)
}

function clearSearch(): void {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  searchText.value = ''
  library.setKeyword('')
}

const viewOptions = [
  { value: 'grid', label: '封面', icon: 'grid' as const },
  { value: 'detail', label: '详细', icon: 'detail' as const },
  { value: 'list', label: '列表', icon: 'list' as const }
]

const isFavorites = computed(() => route.name === 'favorites')
const isShelf = computed(() => route.name === 'shelf')
const shelfId = computed(() => (isShelf.value ? (route.params.shelfId as string) : undefined))
const shelf = computed(
  () => (isShelf.value ? library.shelves.find((s) => s.id === shelfId.value) ?? null : null)
)
/** 书架 id 失效（被删或手输地址）时不能静默显示空列表，要明确说"不存在" */
const shelfMissing = computed(() => isShelf.value && library.loaded && !shelf.value)

/** 由路由 + 当前根目录推导查询域；任何一环变化都会触发整表重载 */
const domainKey = computed(() => {
  const rootScope = library.isAllRoots ? {} : { rootId: library.activeRootId }
  if (isFavorites.value) return JSON.stringify({ ...rootScope, favoritesOnly: true })
  if (isShelf.value) return JSON.stringify({ shelfId: shelfId.value })
  return JSON.stringify(rootScope)
})

watch(
  domainKey,
  (next) => {
    library.setDomain(JSON.parse(next))
  },
  { immediate: true }
)

const title = computed(() => {
  if (isShelf.value) return shelf.value?.name ?? '书架不存在'
  return (route.meta.title as string) ?? '全部书籍'
})

/** 最近阅读只在书库首页出现；搜索时整段隐藏（在搜索上下文里没有意义） */
const showRecent = computed(() => route.name === 'library' && !library.keyword && library.recent.length > 0)

const emptyState = computed(() => {
  if (shelfMissing.value) {
    return { icon: 'folder' as const, title: '书架不存在', desc: '这个书架可能已被删除，或链接里的编号不对。' }
  }
  if (library.keyword) {
    return {
      icon: 'search' as const,
      title: '没有找到匹配的书籍',
      desc: `书名、作者或简介里都没有「${library.keyword}」。搜索按前缀匹配，可以少打几个字试试。`
    }
  }
  if (library.categoryFilter.length > 0) {
    const names = library.categories
      .filter((item) => library.categoryFilter.includes(item.id))
      .map((item) => item.name)
      .join('、')
    return {
      icon: 'layers' as const,
      title: '这个分类下没有书籍',
      desc: `当前筛选中：${names || '（已失效的分类）'}。清除筛选即可回到全部书籍。`
    }
  }
  if (isFavorites.value) {
    return {
      icon: 'star' as const,
      title: '还没有收藏的书籍',
      desc: '在书籍卡片上点星标即可收藏；收藏只是标记，不会移动文件。'
    }
  }
  if (isShelf.value) {
    return { icon: 'folder' as const, title: '这个书架还是空的', desc: '在书库里把书拖到侧栏的这个书架上，就能加进来。' }
  }
  return { icon: 'book' as const, title: '当前书库没有书籍', desc: '换一个书库根目录，或先导入本地文件。' }
})

function importBooks(): void {
  imports.open()
}

// ---------------------------------------------------------------- 虚拟滚动

const scrollEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(800)
const viewportW = ref(1200)
const listTop = ref(0)

/** 三种视图的行几何：每行列数下限（列宽+列距）、行内容高（仅作首帧估算）、行距。
 *  grid 的行内容高是「封面（aspect-3/4 随列宽变）+ 书名 36px + 状态 16px + 间距 10px」，
 *  列宽随窗口变，所以 rowHeight 不能写死——首帧用估算，挂载后由 ResizeObserver 实测修正。 */
const GEOMETRY = {
  grid: { min: 152, gap: 20, rowContent: 238, rowGap: 24 },
  detail: { min: 268, gap: 12, rowContent: 118, rowGap: 12 },
  list: { min: 10000, gap: 0, rowContent: 40, rowGap: 1 }
} as const

const geometry = computed(() => GEOMETRY[viewMode.value])
const columnCount = computed(() => {
  const { min, gap } = geometry.value
  const width = (viewportW.value || 1000) - 48 // px-6 × 2
  return Math.max(1, Math.floor((width + gap) / (min + gap)))
})

/** grid 视图的首帧行高估算：列宽 × 4/3（封面）+ 卡片下方文字区 62px */
const estimatedRowHeight = computed(() => {
  if (viewMode.value !== 'grid') return geometry.value.rowContent
  const width = (viewportW.value || 1000) - 48
  const colW = (width - geometry.value.gap * (columnCount.value - 1)) / columnCount.value
  return colW * (4 / 3) + 62
})

/** 实测行高：任何一行的真实渲染高度（卡片已强制等高）。null = 尚未实测，用估算值 */
const measuredRowHeight = ref<number | null>(null)
const rowHeight = computed(() => measuredRowHeight.value ?? estimatedRowHeight.value + geometry.value.rowGap)

async function remeasureRow(): Promise<void> {
  await nextTick()
  const row = listEl.value?.querySelector<HTMLElement>('[data-virtual-row]')
  const h = row?.firstElementChild instanceof HTMLElement ? row.firstElementChild.offsetHeight : 0
  // 保留旧值直到测出新值：窗口拖动过程中行高不回退到估算，避免列表跳动
  if (h > 0) measuredRowHeight.value = h
}

// 列数 / 视图 / 列宽 / 数据量变化都会改变行内容 → 重测。行高只影响定位，不影响行自身高度，无回环。
watch([viewMode, columnCount, viewportW, () => library.books.length > 0], () => void remeasureRow(), { immediate: true })
const rowCount = computed(() => Math.ceil(library.books.length / columnCount.value))

const OVERSCAN = 4
const firstRow = computed(() =>
  Math.max(0, Math.floor((scrollTop.value - listTop.value) / rowHeight.value) - OVERSCAN)
)
const lastRow = computed(() =>
  Math.min(
    rowCount.value,
    Math.ceil((scrollTop.value - listTop.value + viewportH.value) / rowHeight.value) + OVERSCAN
  )
)
const visibleRows = computed(() => {
  const rows: { index: number; books: BookDTO[] }[] = []
  for (let i = firstRow.value; i < lastRow.value; i += 1) {
    rows.push({
      index: i,
      books: library.books.slice(i * columnCount.value, (i + 1) * columnCount.value)
    })
  }
  return rows
})
const listHeight = computed(() => rowCount.value * rowHeight.value)

let resizeObserver: ResizeObserver | null = null

function measure(): void {
  const el = scrollEl.value
  if (!el) return
  viewportH.value = el.clientHeight
  viewportW.value = el.clientWidth
  if (listEl.value) listTop.value = listEl.value.offsetTop
}

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  scrollTop.value = el.scrollTop
  // 预加载：距底部不足一屏半就开始拉下一页，滚动永不触顶等待
  if (el.scrollHeight - el.scrollTop - el.clientHeight < viewportH.value * 1.5) {
    void library.loadMore()
  }
}

onMounted(() => {
  measure()
  const el = scrollEl.value
  if (el && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (searchTimer) clearTimeout(searchTimer)
})

// 视图切换后行几何全部变化，等一帧 DOM 更新完再测量
watch(viewMode, () => {
  requestAnimationFrame(measure)
})

// 换排序等于「按新顺序从第一本开始看」：滚动位置留在原处会落到新序列的中间
watch(
  () => `${library.sort.field}:${library.sort.direction}`,
  () => {
    if (scrollEl.value) scrollEl.value.scrollTop = 0
    scrollTop.value = 0
  }
)
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <!-- 搜索 -->
    <div class="relative flex h-14 shrink-0 items-center px-6">
      <div class="relative mx-auto w-full max-w-[520px]">
        <AppIcon name="search" :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索书籍..."
          class="w-full rounded-lg border border-line bg-elevated py-[7px] pl-9 pr-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          data-search-input
          @input="onSearchInput"
        />
        <button
          v-if="searchText"
          type="button"
          class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-faint transition-colors duration-120 hover:bg-hover hover:text-ink"
          title="清除搜索"
          aria-label="清除搜索"
          data-search-clear
          @click="clearSearch"
        >
          <AppIcon name="close" :size="12" />
        </button>
      </div>
      <span class="absolute right-6 text-[11.5px] text-faint" data-book-count>{{ library.booksTotal }} 本</span>
    </div>

    <div ref="scrollEl" class="relative flex-1 overflow-y-auto px-6 pb-10" @scroll.passive="onScroll">
      <!-- 根目录离线提示（产品文档 §2.3）：书籍仍在，只是暂时读不到文件 -->
      <div
        v-if="!library.activeRootOnline && !shelfMissing"
        class="mb-5 flex items-center gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2"
        data-offline-hint
      >
        <AppIcon name="warning" :size="14" class="shrink-0 text-amber-400/90" />
        <p class="min-w-0 flex-1 text-[12px] leading-relaxed text-amber-200/90">
          所在目录
          <span class="font-mono text-[11.5px]">{{ library.activeRoot.path }}</span>
          当前不可用。书籍与阅读进度都已保留，连接磁盘或重新指定目录后自动恢复。
        </p>
      </div>

      <!-- 最近阅读（仅书库首页） -->
      <section v-if="showRecent" class="mb-7" data-recent>
        <h2 class="mb-3 text-[12px] text-dim">最近阅读</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <button
            v-for="book in library.recent"
            :key="book.id"
            class="flex items-center gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors duration-120 hover:border-line-strong hover:bg-hover"
          >
            <div class="relative h-[62px] w-[46px] shrink-0 overflow-hidden rounded shadow-[0_2px_8px_rgba(0,0,0,.45)]">
              <span class="pointer-events-none absolute inset-y-0 left-0 w-[4px] bg-black/25" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="line-clamp-2 text-[12.5px] leading-[1.45] text-ink/90">{{ book.title }}</p>
              <p class="mt-1.5 text-[11px] text-dim">现在阅读</p>
              <p class="mt-0.5 text-[11px] text-faint">已读 {{ Math.round(book.progress * 100) }}%</p>
            </div>
          </button>
        </div>
      </section>

      <!-- 非首页标题 -->
      <div v-else class="mb-5 flex items-baseline gap-2">
        <h1 class="text-[15px] font-medium text-ink" data-page-title>{{ title }}</h1>
        <span v-if="isShelf && shelf" class="text-[11.5px] text-faint">{{ shelf.bookCount }} 本</span>
      </div>

      <!-- 工具栏 -->
      <div
        v-if="library.booksTotal > 0 || library.categoryFilter.length > 0"
        class="mb-4 flex flex-wrap items-center justify-between gap-3"
      >
        <div class="flex items-center gap-2">
          <SegmentedControl v-model="viewMode" :options="viewOptions" />
          <button
            type="button"
            class="ct-btn"
            :class="selectionMode && 'border-accent/50 text-accent'"
            :aria-pressed="selectionMode"
            data-batch-toggle
            @click="toggleSelectionMode"
          >
            <AppIcon name="check" :size="14" />
            {{ selectionMode ? '退出批量' : '批量' }}
          </button>
        </div>

        <div class="flex items-center gap-2">
          <CategoryFilter @manage="managingCategories = true" />
          <SortMenu :shelf="isShelf" />

          <button class="ct-btn" title="导入书籍" data-import-trigger @click="importBooks">
            <AppIcon name="import" :size="14" />
            导入书籍文件
          </button>
        </div>
      </div>

      <!-- 批量操作条（M3-05） -->
      <div
        v-if="selectionMode"
        class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2"
        data-batch-bar
      >
        <span class="text-[12px] text-ink/90" data-batch-count>已选 {{ selected.length }} 本</span>
        <button type="button" class="ct-btn" data-batch-all @click="selectAll">全选本页</button>
        <button type="button" class="ct-btn" data-batch-clear @click="selected = []">清空</button>

        <span class="mx-1 h-4 w-px bg-line" />

        <button type="button" class="ct-btn" data-batch-favorite @click="favoriteMany(true, selectedBooks)">
          <AppIcon name="star" :size="13" />收藏
        </button>
        <button type="button" class="ct-btn" data-batch-unfavorite @click="favoriteMany(false, selectedBooks)">
          取消收藏
        </button>
        <button type="button" class="ct-btn" data-batch-shelf @click="picker = picker === 'shelf' ? null : 'shelf'">
          <AppIcon name="folder" :size="13" />加入书架
        </button>
        <button type="button" class="ct-btn" data-batch-category @click="picker = picker === 'category' ? null : 'category'">
          <AppIcon name="layers" :size="13" />打上分类
        </button>
        <button
          type="button"
          class="ct-btn border-rose-500/40 text-rose-300 hover:border-rose-400"
          :disabled="selected.length === 0"
          data-batch-remove
          @click="removing = selectedBooks"
        >
          移出书库
        </button>
      </div>

      <!-- 批量二级选择（书架 / 分类） -->
      <div
        v-if="selectionMode && picker"
        class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2"
        data-batch-picker
      >
        <span class="text-[11.5px] text-dim">{{ picker === 'shelf' ? '加入书架：' : '打上分类：' }}</span>
        <template v-if="picker === 'shelf'">
          <button
            v-for="shelf in library.shelves"
            :key="shelf.id"
            type="button"
            class="ct-btn"
            :data-batch-shelf-option="shelf.id"
            @click="addToShelfMany(shelf.id, selectedBooks)"
          >
            {{ shelf.name }}
          </button>
          <span v-if="library.shelves.length === 0" class="text-[11.5px] text-faint">还没有书架</span>
        </template>
        <template v-else>
          <button
            v-for="category in library.categories"
            :key="category.id"
            type="button"
            class="ct-btn"
            :data-batch-category-option="category.id"
            @click="addCategoryMany(category.id, selectedBooks)"
          >
            {{ category.name }}
          </button>
          <span v-if="library.categories.length === 0" class="text-[11.5px] text-faint">还没有分类</span>
        </template>
      </div>

      <!-- 加载失败 -->
      <div
        v-if="library.loadError && library.books.length === 0"
        class="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-[12.5px] text-rose-200/90"
        data-list-error
      >
        {{ library.loadError }}
        <button type="button" class="ct-btn ml-3" @click="library.refresh()">重试</button>
      </div>

      <!-- 虚拟滚动列表 -->
      <div
        v-if="library.books.length > 0"
        ref="listEl"
        class="relative"
        :style="{ height: `${listHeight}px` }"
        data-book-grid
        data-virtual-list
      >
        <div
          v-for="row in visibleRows"
          :key="row.index"
          class="absolute left-0 w-full"
          data-virtual-row
          :style="{ transform: `translateY(${row.index * rowHeight}px)` }"
        >
          <div
            class="grid"
            :style="{
              gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              columnGap: `${geometry.gap}px`,
              rowGap: `${geometry.rowGap}px`
            }"
          >
            <div
              v-for="(book, column) in row.books"
              :key="book.id"
              class="min-w-0"
              @dragover="onCardDragOver"
              @drop="onCardDrop($event, row.index * columnCount + column, book)"
              @contextmenu.prevent="openMenu($event, book)"
            >
              <BookCard
                :book="book"
                :variant="viewMode"
                :draggable="!selectionMode"
                :removable="isShelf && !selectionMode"
                :selected="selectionMode && selected.includes(book.id)"
                @open="onCardOpen(book)"
                @favorite="toggleFavorite(book)"
                @remove="removeFromShelf(book)"
                @detail="router.push(`/book/${book.id}`)"
              />
            </div>
          </div>
        </div>

        <!-- 触底加载指示 -->
        <div
          v-if="library.loading"
          class="absolute inset-x-0 text-center text-[11.5px] text-faint"
          :style="{ top: `${listHeight + 8}px` }"
          data-list-more
        >
          加载中…
        </div>
      </div>

      <!-- 加载中（首屏） -->
      <div v-else-if="library.loading" class="py-16 text-center text-[12.5px] text-faint" data-list-loading>
        正在加载书籍…
      </div>

      <!-- 空状态 -->
      <EmptyState
        v-else-if="!library.loadError"
        :icon="emptyState.icon"
        :title="emptyState.title"
        :desc="emptyState.desc"
      >
        <button
          v-if="library.keyword && !shelfMissing"
          type="button"
          class="ct-btn"
          data-search-reset
          @click="clearSearch"
        >
          清除搜索
        </button>
        <button
          v-else-if="library.categoryFilter.length > 0 && !shelfMissing"
          type="button"
          class="ct-btn"
          data-category-reset
          @click="library.setCategoryFilter([])"
        >
          清除分类筛选
        </button>
        <RouterLink v-else-if="shelfMissing" to="/shelves" class="ct-btn">返回书架列表</RouterLink>
        <button
          v-else-if="!isFavorites && !isShelf"
          type="button"
          class="ct-btn"
          data-import-trigger
          @click="importBooks"
        >
          <AppIcon name="import" :size="14" />
          导入书籍文件
        </button>
      </EmptyState>
    </div>

    <!-- 撤销条：批量操作后出现，只留最近一次 -->
    <div
      v-if="undo"
      class="pointer-events-auto fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-elevated px-3 py-2 shadow-[0_10px_28px_rgba(0,0,0,.5)]"
      data-undo-bar
    >
      <span class="text-[12px] text-ink/90">已{{ undo.label }}</span>
      <button type="button" class="text-[12px] text-accent hover:underline" data-undo-action @click="undoLast">撤销</button>
      <button type="button" class="text-[11.5px] text-faint hover:text-ink" data-undo-dismiss @click="undo = null">关闭</button>
    </div>

    <BookContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :book="menu.book"
      :shelves="library.shelves"
      :categories="library.categories"
      @close="closeMenu"
      @read="menuAction('read')"
      @detail="menuAction('detail')"
      @favorite="menuFavorite"
      @add-shelf="menuAddShelf"
      @add-category="menuAddCategory"
      @rematch="menuAction('rematch')"
      @remove="menuRemove"
    />

    <ConfirmDialog
      :open="removing.length > 0"
      title="从书库移除？"
      :desc="`这 ${removing.length} 本书会从书库列表里消失，但磁盘上的文件不会被删除，仍保留在原目录。阅读进度与书签会一并保留，重新导入后可恢复。`"
      confirm-text="移出书库"
      danger
      @confirm="confirmRemove"
      @cancel="removing = []"
    />

    <CategoryManager :open="managingCategories" @close="managingCategories = false" />
  </div>
</template>
