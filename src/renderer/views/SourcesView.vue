<script setup lang="ts">
/**
 * 网络小说 / 书源（/sources、/sources/:sourceId）。
 *
 * M0-08 只做骨架：书源列表 + 单个书源概要 + 空状态。搜索、目录、正文抓取在 M4。
 * 合规红线写进页面文案：不内置、不分发任何书源（产品文档 §2.7）。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { pushToast } from '@/lib/toast'
import { fixtureSources, type SourceFixture } from '@/fixture/sources'

const route = useRoute()

const sourceId = computed(() => route.params.sourceId as string | undefined)
const current = computed(() => fixtureSources.find((source) => source.id === sourceId.value) ?? null)
const list = computed<SourceFixture[]>(() => (current.value ? [current.value] : fixtureSources))

function importSource(): void {
  pushToast({ level: 'info', message: '导入书源将在 M4-07 提供' })
}
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <div class="flex h-14 shrink-0 items-center gap-3 px-6">
      <h1 class="truncate text-[15px] font-medium text-ink">
        {{ current ? current.name : '网络小说' }}
      </h1>
      <span class="text-[11.5px] text-faint">{{ fixtureSources.length }} 个书源</span>
      <button type="button" class="ct-btn ml-auto" data-source-import @click="importSource">
        <AppIcon name="import" :size="14" />
        导入书源
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <div v-if="list.length > 0" class="space-y-2">
        <RouterLink
          v-for="source in list"
          :key="source.id"
          :to="`/sources/${source.id}`"
          class="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 transition-colors duration-120 hover:border-line-strong hover:bg-hover"
          :class="current && 'cursor-default'"
          data-source-row
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="source.enabled ? 'bg-emerald-500/80' : 'bg-faint/50'"
          />
          <span class="min-w-0 flex-1 truncate text-[13px] text-ink/90">{{ source.name }}</span>
          <span class="rounded border border-line px-1.5 py-px text-[10.5px] text-faint">
            {{ source.group }}
          </span>
          <span class="text-[11px] text-faint">{{ source.enabled ? '已启用' : '已停用' }}</span>
        </RouterLink>
      </div>

      <EmptyState
        v-else
        icon="globe"
        title="还没有导入书源"
        desc="cText 不内置、不分发任何书源；书源规则由你自行提供，格式对齐「阅读 3.0」的 JSON。"
      >
        <button type="button" class="ct-btn" @click="importSource">
          <AppIcon name="import" :size="14" />
          导入书源
        </button>
      </EmptyState>

      <p class="mt-6 max-w-[520px] text-[11.5px] leading-relaxed text-faint">
        搜索、目录与正文缓存将在 M4 接入。届时搜索框会从「搜索书籍」切换为「搜索网络书籍」，
        按书源分组展示结果，单源串行、全局最多 8 并发。
      </p>
    </div>
  </div>
</template>
