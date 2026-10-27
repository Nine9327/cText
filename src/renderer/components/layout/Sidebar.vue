<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import { librarySummary, mockShelves, mockSources } from '@/mock/library'
</script>

<template>
  <aside class="flex w-[240px] shrink-0 flex-col border-r border-line bg-sidebar">
    <!-- 书库切换器 -->
    <div class="p-2.5">
      <button
        class="flex w-full items-center gap-2.5 rounded-lg border border-line bg-elevated px-2.5 py-2 text-left transition-colors duration-120 hover:border-line-strong"
      >
        <span class="flex h-7 w-7 items-center justify-center rounded-md bg-accent/15 text-accent">
          <AppIcon name="book" :size="14" />
        </span>
        <span class="flex-1 leading-tight">
          <span class="block text-[13px] text-ink">书库</span>
          <span class="block text-[11px] text-faint">{{ librarySummary.total }} 本</span>
        </span>
        <AppIcon name="chevron-down" :size="14" class="text-faint" />
      </button>
    </div>

    <!-- 主视图 -->
    <nav class="space-y-0.5 px-2.5">
      <RouterLink to="/library" class="ct-nav-item" active-class="ct-nav-item-active">
        <AppIcon name="book" :size="15" />
        <span class="flex-1">全部书籍</span>
        <span class="text-[11px] text-faint">{{ librarySummary.total }}</span>
      </RouterLink>
      <RouterLink to="/favorites" class="ct-nav-item" active-class="ct-nav-item-active">
        <AppIcon name="star" :size="15" />
        <span class="flex-1">收藏的书籍</span>
        <span class="text-[11px] text-faint">{{ librarySummary.favorite }}</span>
      </RouterLink>
    </nav>

    <!-- 我的书架 -->
    <div class="mt-4 flex items-center px-2.5">
      <span class="ct-section-title flex-1">我的书架</span>
      <button class="ct-icon-btn h-6 w-6" title="新建书架">
        <AppIcon name="plus" :size="14" />
      </button>
    </div>
    <div class="mt-1 space-y-0.5 px-2.5">
      <RouterLink
        v-for="shelf in mockShelves"
        :key="shelf.id"
        :to="`/shelves/${shelf.id}`"
        class="ct-nav-item"
        active-class="ct-nav-item-active"
      >
        <AppIcon name="folder" :size="15" />
        <span class="flex-1 truncate">{{ shelf.name }}</span>
        <span class="text-[11px] text-faint">{{ shelf.count }}</span>
      </RouterLink>
    </div>

    <!-- 网络小说 -->
    <div class="mt-4 flex items-center px-2.5">
      <span class="ct-section-title flex flex-1 items-center gap-1">
        网络小说
        <AppIcon name="chevron-down" :size="12" />
      </span>
    </div>
    <div class="mt-1 space-y-0.5 px-2.5">
      <RouterLink
        v-for="source in mockSources"
        :key="source.id"
        to="/sources"
        class="ct-nav-item"
        active-class="ct-nav-item-active"
      >
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="source.enabled ? 'bg-emerald-500/80' : 'bg-faint/50'"
        />
        <span class="flex-1 truncate">{{ source.name }}</span>
      </RouterLink>
    </div>

    <!-- 底部 -->
    <div class="mt-auto border-t border-line p-2.5">
      <RouterLink to="/settings" class="ct-nav-item" active-class="ct-nav-item-active">
        <AppIcon name="settings" :size="15" />
        <span class="flex-1">设置</span>
      </RouterLink>
    </div>
  </aside>
</template>
