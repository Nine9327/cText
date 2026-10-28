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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import SortMenu from '@/components/library/SortMenu.vue'
import CategoryFilter from '@/components/library/CategoryFilter.vue'
import CategoryManager from '@/components/library/CategoryManager.vue'
import BookCard from '@/components/book/BookCard.vue'
import { pushToast } from '@/lib/toast'
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
 * 网络书还没有正文通路（M3），先给提示而不是跳进一个空白阅读页。
 */
function openBook(book: BookDTO): void {
  if (book.sourceType === 'network') {
    pushToast({ level: 'info', message: '网络书阅读将在 M3-04 提供' })
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

function relocateRoot(): void {
  // roots:relocate 的通道已就绪（M1-01）；交互入口与「管理书库」页一起规划
  pushToast({ level: 'info', message: '重新指定目录将在「管理书库」页提供' })
}

// ---------------------------------------------------------------- 虚拟滚动

const scrollEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(800)
const viewportW = ref(1200)
const listTop = ref(0)

/** 三种视图的行几何：每行列数下限（列宽+列距）、行内容高、行距 */
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
const rowHeight = computed(() => geometry.value.rowContent + geometry.value.rowGap)
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
        <button type="button" class="ct-btn shrink-0" @click="relocateRoot">重新指定目录</button>
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
        <SegmentedControl v-model="viewMode" :options="viewOptions" />

        <div class="flex items-center gap-2">
          <CategoryFilter @manage="managingCategories = true" />
          <SortMenu :shelf="isShelf" />

          <div class="flex">
            <button class="ct-btn rounded-r-none" title="导入书籍" data-import-trigger @click="importBooks">
              <AppIcon name="import" :size="14" />
              导入书籍文件
            </button>
            <button class="ct-btn rounded-l-none border-l-0 px-1.5" title="更多导入方式">
              <AppIcon name="chevron-down" :size="12" class="text-faint" />
            </button>
          </div>
        </div>
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
            >
              <BookCard
                :book="book"
                :variant="viewMode"
                :draggable="true"
                :removable="isShelf"
                @open="openBook(book)"
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

    <CategoryManager :open="managingCategories" @close="managingCategories = false" />
  </div>
</template>
