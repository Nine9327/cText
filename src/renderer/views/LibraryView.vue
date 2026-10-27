<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import BookCard from '@/components/book/BookCard.vue'
import { mockBooks, recentBooks } from '@/mock/library'

const route = useRoute()

const viewMode = ref<'grid' | 'detail' | 'list'>('grid')

const viewOptions = [
  { value: 'grid', label: '封面', icon: 'grid' as const },
  { value: 'detail', label: '详细', icon: 'detail' as const },
  { value: 'list', label: '列表', icon: 'list' as const }
]

const isRoot = computed(() => !route.meta.view)
const title = computed(() => (route.meta.title as string) ?? '全部书籍')

/** 骨架阶段：按路由切一段假数据，让点击有反馈；M1 起换成 library:list */
const books = computed(() => {
  if (route.meta.view === 'favorites') return mockBooks.slice(0, 5)
  if (route.meta.view === 'shelf') return mockBooks.slice(2, 8)
  return mockBooks
})
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
      <span class="absolute right-6 text-[11.5px] text-faint">{{ books.length }} 本</span>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <!-- 最近阅读（仅书库首页） -->
      <section v-if="isRoot" class="mb-7">
        <h2 class="mb-3 text-[12px] text-dim">最近阅读</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <button
            v-for="book in recentBooks"
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
      <h1 v-else class="mb-5 text-[15px] font-medium text-ink">{{ title }}</h1>

      <!-- 工具栏 -->
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl v-model="viewMode" :options="viewOptions" />

        <div class="flex items-center gap-2">
          <button class="ct-btn" title="排序（M1 实现）">
            <AppIcon name="sort" :size="14" />
            最近阅读
            <AppIcon name="chevron-down" :size="12" class="text-faint" />
          </button>

          <div class="flex">
            <button class="ct-btn rounded-r-none" title="导入（M1 实现）">
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
        v-if="viewMode === 'grid'"
        class="grid grid-cols-[repeat(auto-fill,minmax(152px,1fr))] gap-x-5 gap-y-6"
      >
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="grid" />
      </div>

      <div
        v-else-if="viewMode === 'detail'"
        class="grid grid-cols-[repeat(auto-fill,minmax(268px,1fr))] gap-3"
      >
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="detail" />
      </div>

      <div v-else class="space-y-px">
        <BookCard v-for="book in books" :key="book.id" :book="book" variant="list" />
      </div>
    </div>
  </div>
</template>
