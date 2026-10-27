<script setup lang="ts">
/**
 * 书籍卡片（三种视图共用一套数据）。
 *
 * 封面一律用「id 哈希取色」的占位渐变：真实封面要等 M2-03 的自定义协议
 * （cover_path 只是缓存文件名，没有可用的 URL scheme）。产品文档 §2.4 明确
 * 无图时就该是取色占位，所以这不是降级而是既定设计。
 */
import { computed } from 'vue'
import type { BookDTO } from '@shared/dto'
import { coverGradient } from '@/lib/cover'

const props = withDefaults(defineProps<{ book: BookDTO; variant?: 'grid' | 'detail' | 'list' }>(), {
  variant: 'grid'
})

const isOffline = computed(() => props.book.offline)

const coverStyle = computed(() => {
  const { from, to } = coverGradient(props.book.id)
  return { background: `linear-gradient(155deg, ${from} 0%, ${to} 100%)` }
})

const statusText = computed(() => {
  if (props.book.offline) return '目录离线'
  switch (props.book.readState) {
    case 'reading':
      return `已读 ${Math.round(props.book.progress * 100)}%`
    case 'finished':
      return '已读完'
    default:
      return '未读'
  }
})
</script>

<template>
  <!-- 封面视图 -->
  <button v-if="variant === 'grid'" class="group block w-full text-left">
    <div
      class="relative aspect-[3/4] overflow-hidden rounded-md shadow-[0_2px_10px_rgba(0,0,0,.45)] ring-1 ring-black/30 transition-transform duration-120 group-hover:-translate-y-0.5"
      :class="isOffline && 'opacity-45 saturate-0'"
      :style="coverStyle"
    >
      <!-- 书脊与高光 -->
      <span class="pointer-events-none absolute inset-y-0 left-0 w-[6px] bg-black/25" />
      <span class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-white/10" />

      <span class="absolute inset-x-0 top-0 line-clamp-2 px-2.5 pt-2.5 text-[10.5px] font-medium leading-[1.35] text-white/90">
        {{ book.title }}
      </span>
      <span class="absolute inset-x-0 bottom-0 px-2.5 pb-2 text-[9px] text-white/55">{{ book.author ?? '佚名' }}</span>

      <span
        v-if="isOffline"
        class="absolute right-1 top-1 rounded bg-black/70 px-1 py-px text-[9px] text-white/80"
      >
        离线
      </span>

      <span
        v-if="book.readState === 'reading' && !book.offline"
        class="absolute inset-x-0 bottom-0 h-[3px] bg-black/40"
      >
        <span class="block h-full bg-accent" :style="{ width: `${book.progress * 100}%` }" />
      </span>
    </div>

    <p class="mt-2 line-clamp-2 text-[12.5px] leading-[1.45] text-ink/90 group-hover:text-ink">{{ book.title }}</p>
    <p class="mt-0.5 text-[11px] text-faint">
      {{ statusText }}
    </p>
  </button>

  <!-- 详细视图 -->
  <button
    v-else-if="variant === 'detail'"
    class="group flex w-full items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors duration-120 hover:border-line-strong hover:bg-hover"
  >
    <div
      class="relative h-[74px] w-[56px] shrink-0 overflow-hidden rounded shadow-[0_2px_8px_rgba(0,0,0,.4)]"
      :class="isOffline && 'opacity-45 saturate-0'"
      :style="coverStyle"
    >
      <span class="pointer-events-none absolute inset-y-0 left-0 w-[4px] bg-black/25" />
    </div>
    <div class="min-w-0 flex-1">
      <p class="line-clamp-2 text-[13px] leading-[1.4] text-ink/90">{{ book.title }}</p>
      <p class="mt-1 truncate text-[11.5px] text-faint">{{ book.author ?? '佚名' }}</p>
      <div class="mt-2 flex items-center gap-2">
        <span class="text-[11px] text-dim">{{ statusText }}</span>
        <span class="text-[10px] uppercase tracking-wide text-faint">{{ book.format }}</span>
      </div>
      <div v-if="book.readState === 'reading' && !book.offline" class="mt-1.5 h-[2px] w-full rounded-full bg-white/10">
        <div class="h-full rounded-full bg-accent" :style="{ width: `${book.progress * 100}%` }" />
      </div>
    </div>
  </button>

  <!-- 列表视图 -->
  <button
    v-else
    class="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-hover"
  >
    <div
      class="relative h-[38px] w-[28px] shrink-0 overflow-hidden rounded-sm"
      :class="isOffline && 'opacity-45 saturate-0'"
      :style="coverStyle"
    >
      <span class="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-black/25" />
    </div>
    <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink/90">{{ book.title }}</span>
    <span class="hidden w-32 shrink-0 truncate text-[11.5px] text-faint sm:block">{{ book.author ?? '佚名' }}</span>
    <span class="w-20 shrink-0 text-right text-[11px] text-faint">{{ statusText }}</span>
  </button>
</template>
