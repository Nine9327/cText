<script setup lang="ts">
/**
 * 我的书架总览（/shelves）。
 *
 * M0-08 阶段只有骨架：列出书架、进书架、新建入口给提示。
 * 建/改名/排序/删除都在 M3-02，届时这个页面接 CRUD 弹窗即可。
 */
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { pushToast } from '@/lib/toast'
import { useLibraryStore } from '@/stores/library'

const library = useLibraryStore()

function createShelf(): void {
  pushToast({ level: 'info', message: '新建书架将在 M3-02 提供' })
}
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <div class="flex h-14 shrink-0 items-center gap-3 px-6">
      <h1 class="text-[15px] font-medium text-ink">我的书架</h1>
      <span class="text-[11.5px] text-faint">{{ library.shelves.length }} 个书架</span>
      <button type="button" class="ct-btn ml-auto" data-shelf-create @click="createShelf">
        <AppIcon name="plus" :size="14" />
        新建书架
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <div v-if="library.shelves.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        <RouterLink
          v-for="shelf in library.shelves"
          :key="shelf.id"
          :to="`/shelves/${shelf.id}`"
          class="group rounded-lg border border-line bg-card p-3.5 transition-colors duration-120 hover:border-line-strong hover:bg-hover"
          data-shelf-card
        >
          <div class="flex items-center gap-2.5">
            <span
              class="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent"
            >
              <AppIcon name="folder" :size="15" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] text-ink">{{ shelf.name }}</p>
              <p class="mt-0.5 text-[11px] text-faint">{{ shelf.count }} 本</p>
            </div>
            <AppIcon
              name="chevron-right"
              :size="14"
              class="text-faint transition-transform duration-120 group-hover:translate-x-0.5"
            />
          </div>

          <p class="mt-3 line-clamp-1 text-[11.5px] text-faint">
            {{ shelf.books.slice(0, 3).map((book) => book.title).join(' · ') || '空书架' }}
          </p>
        </RouterLink>
      </div>

      <EmptyState
        v-else
        icon="folder"
        title="还没有书架"
        desc="书架是「我正在看的一批书」的手动分组，同一本书可以放进多个书架。"
      >
        <button type="button" class="ct-btn" @click="createShelf">
          <AppIcon name="plus" :size="14" />
          新建书架
        </button>
      </EmptyState>
    </div>
  </div>
</template>
