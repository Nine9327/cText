<script setup lang="ts">
/**
 * 书库列表视图。同一组件承担三个入口：全部书籍 / 收藏的书籍 / 单个书架。
 *
 * 为什么复用而不是三个页面：三者的工具栏、三视图切换、卡片渲染完全一样，
 * 只有「取哪些书」和「标题」不同。M1-08 接真实分页时也只改这里。
 *
 * 数据来自 store（当前根目录过滤后的集合），因此切换书库时三个入口同时生效。
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import BookCard from '@/components/book/BookCard.vue'
import { pushToast } from '@/lib/toast'
import { useImportStore } from '@/stores/import'
import { useLibraryStore } from '@/stores/library'

const route = useRoute()
const library = useLibraryStore()
const imports = useImportStore()

const viewMode = ref<'grid' | 'detail' | 'list'>('grid')

const viewOptions = [
  { value: 'grid', label: '封面', icon: 'grid' as const },
  { value: 'detail', label: '详细', icon: 'detail' as const },
  { value: 'list', label: '列表', icon: 'list' as const }
]

const isFavorites = computed(() => route.name === 'favorites')
const isShelf = computed(() => route.name === 'shelf')
const shelf = computed(() => (isShelf.value ? library.shelfById(route.params.shelfId as string) : null))
/** 书架 id 失效（被删或手输地址）时不能静默显示空列表，要明确说"不存在" */
const shelfMissing = computed(() => isShelf.value && !shelf.value)

const books = computed(() => {
  if (isFavorites.value) return library.favorites
  if (isShelf.value) return library.booksOfShelf(route.params.shelfId as string)
  return library.books
})

const title = computed(() => {
  if (isShelf.value) return shelf.value?.name ?? '书架不存在'
  return (route.meta.title as string) ?? '全部书籍'
})

/** 最近阅读只在书库首页出现；根目录离线时会没有可读的书，此时整段隐藏 */
const showRecent = computed(() => route.name === 'library' && library.recent.length > 0)

const emptyState = computed(() => {
  if (shelfMissing.value) {
    return { icon: 'folder' as const, title: '书架不存在', desc: '这个书架可能已被删除，或链接里的编号不对。' }
  }
  if (isFavorites.value) {
    return {
      icon: 'star' as const,
      title: '还没有收藏的书籍',
      desc: '在书籍卡片上点星标即可收藏；收藏只是标记，不会移动文件。'
    }
  }
  if (isShelf.value) {
    return { icon: 'folder' as const, title: '这个书架还是空的', desc: 'M3-02 起可以把书拖进书架。' }
  }
  return { icon: 'book' as const, title: '当前书库没有书籍', desc: '换一个书库根目录，或先导入本地文件。' }
})

function importBooks(): void {
  imports.open()
}

function relocateRoot(): void {
  pushToast({ level: 'info', message: '重新指定目录将在 M1-01 提供' })
}
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <!-- 搜索 -->
    <div class="relative flex h-14 shrink-0 items-center px-6">
      <div class="relative mx-auto w-full max-w-[520px]">
        <AppIcon name="search" :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          type="text"
          placeholder="搜索书籍..."
          class="w-full rounded-lg border border-line bg-elevated py-[7px] pl-9 pr-3 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
        />
      </div>
      <span class="absolute right-6 text-[11.5px] text-faint" data-book-count>{{ books.length }} 本</span>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <!-- 根目录离线提示（产品文档 §2.3）：书籍仍在，只是暂时读不到文件 -->
      <div
        v-if="!library.activeRoot.online && !shelfMissing"
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
            <div
              class="relative h-[62px] w-[46px] shrink-0 overflow-hidden rounded shadow-[0_2px_8px_rgba(0,0,0,.45)]"
              :style="{ background: `linear-gradient(155deg, ${book.cover.from}, ${book.cover.to})` }"
            >
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
        <span v-if="isShelf && shelf" class="text-[11.5px] text-faint">{{ shelf.count }} 本</span>
      </div>

      <!-- 工具栏 -->
      <div v-if="books.length > 0" class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl v-model="viewMode" :options="viewOptions" />

        <div class="flex items-center gap-2">
          <button class="ct-btn" title="排序（M1 实现）">
            <AppIcon name="sort" :size="14" />
            最近阅读
            <AppIcon name="chevron-down" :size="12" class="text-faint" />
          </button>

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

      <!-- 书籍列表 -->
      <div
        v-if="books.length > 0 && viewMode === 'grid'"
        class="grid grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-5 gap-y-6"
        data-book-grid
      >
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="grid" />
      </div>

      <div
        v-else-if="books.length > 0 && viewMode === 'detail'"
        class="grid grid-cols-[repeat(auto-fill,minmax(268px,1fr))] gap-3"
        data-book-grid
      >
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="detail" />
      </div>

      <div v-else-if="books.length > 0" class="space-y-px" data-book-grid>
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="list" />
      </div>

      <!-- 空状态 -->
      <EmptyState v-else :icon="emptyState.icon" :title="emptyState.title" :desc="emptyState.desc">
        <RouterLink v-if="shelfMissing" to="/shelves" class="ct-btn">返回书架列表</RouterLink>
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
  </div>
</template>
