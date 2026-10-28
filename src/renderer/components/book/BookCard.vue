<script setup lang="ts">
/**
 * 书籍卡片（三种视图共用一套数据）。
 *
 * 封面一律用「id 哈希取色」的占位渐变：真实封面要等 M2-03 的自定义协议
 * （cover_path 只是缓存文件名，没有可用的 URL scheme）。产品文档 §2.4 明确
 * 无图时就该是取色占位，所以这不是降级而是既定设计。
 *
 * 右上角那组按钮（星标 / 移出书架）是卡片的**兄弟节点**而不是子节点：卡片本身
 * 是 `<button>`，里面再放 `<button>` 在 HTML 里是非法的（浏览器会把内层按钮
 * 提到外层，点击区域随之错位）。所以外层统一包一个 `group relative`，
 * 卡片按钮退居其中，动作按钮绝对定位在角落。
 *
 * 「可拖拽」也是外层的属性（`draggable`）：拖动整张卡去侧栏的书架 = 加入书架，
 * 在书架页里拖到另一张卡上 = 架内排序（M3-02）。
 */
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { BookDTO } from '@shared/dto'
import { coverGradient } from '@/lib/cover'
import { BOOK_MIME, setDragSource } from '@/lib/drag'

const props = withDefaults(
  defineProps<{
    book: BookDTO
    variant?: 'grid' | 'detail' | 'list'
    /** 允许拖拽（加入书架 / 架内排序） */
    draggable?: boolean
    /** 显示「移出书架」（只在书架页） */
    removable?: boolean
    /** 批量选择模式下被选中（M3-05）：只加一圈描边，不做缩放/位移，避免布局抖动 */
    selected?: boolean
  }>(),
  { variant: 'grid', draggable: false, removable: false, selected: false }
)

/**
 * 点开一本书。卡片自己不决定去哪（书库/收藏/书架三处都用它），
 * 只把「这本书被点开了」抛给调用方——离线和网络书的处置各不相同。
 *
 * `favorite` / `remove` 只报告「用户点了」，真正的写入在调用方（store），
 * 卡片不持状态，免得乐观更新与真实结果打架。
 */
const emit = defineEmits<{
  (e: 'open'): void
  (e: 'favorite'): void
  (e: 'remove'): void
  /** 打开详情页（M3-04）。卡片点击仍是「直接读」，详情走这个独立按钮 */
  (e: 'detail'): void
}>()

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

/** 动作按钮的角标位置：三种视图各自的留白不同 */
const actionsClass = computed(() => {
  if (props.variant === 'grid') return 'right-1.5 top-1.5'
  if (props.variant === 'detail') return 'right-2.5 top-2.5'
  return 'right-2 top-1/2 -translate-y-1/2'
})

function onDragStart(event: DragEvent): void {
  if (!props.draggable) return
  // id 记在模块变量里（见 lib/drag.ts），MIME 只负责让落点认得出「这是本书」
  setDragSource({ kind: 'book', id: props.book.id })
  if (!event.dataTransfer) return
  event.dataTransfer.setData(BOOK_MIME, props.book.id)
  event.dataTransfer.effectAllowed = 'move'
}
</script>

<template>
  <div
    class="group relative rounded-md"
    :class="selected && 'ring-2 ring-accent/70 ring-offset-1 ring-offset-app'"
    :data-fav-on="book.favorite ? '1' : '0'"
    :data-selected="selected ? '1' : '0'"
    :draggable="draggable"
    @dragstart="onDragStart"
  >
    <!-- 封面视图 -->
    <button
      v-if="variant === 'grid'"
      class="block w-full text-left"
      :data-book-id="book.id"
      :title="book.title"
      @click="emit('open')"
    >
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
          class="absolute left-2 top-1 rounded bg-black/70 px-1 py-px text-[9px] text-white/80"
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
      :data-book-id="book.id"
      :title="book.title"
      @click="emit('open')"
      class="flex w-full items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors duration-120 hover:border-line-strong hover:bg-hover"
    >
      <div
        class="relative h-[74px] w-[56px] shrink-0 overflow-hidden rounded shadow-[0_2px_8px_rgba(0,0,0,.4)]"
        :class="isOffline && 'opacity-45 saturate-0'"
        :style="coverStyle"
      >
        <span class="pointer-events-none absolute inset-y-0 left-0 w-[4px] bg-black/25" />
        <span
          v-if="isOffline"
          class="absolute inset-x-0 bottom-0 bg-black/70 py-px text-center text-[8.5px] text-white/80"
        >
          离线
        </span>
      </div>
      <div class="min-w-0 flex-1 pr-14">
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
      :data-book-id="book.id"
      :title="book.title"
      @click="emit('open')"
      class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 pr-16 text-left transition-colors duration-120 hover:bg-hover"
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

    <!-- 动作按钮：详情 + 星标 + 移出书架 -->
    <div class="absolute flex gap-1" :class="actionsClass">
      <button
        type="button"
        class="ct-fav-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        title="书籍详情"
        aria-label="书籍详情"
        data-book-detail
        @click.stop="emit('detail')"
      >
        <AppIcon name="info" :size="13" />
      </button>

      <button
        type="button"
        class="ct-fav-btn"
        :class="book.favorite ? 'ct-fav-on' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'"
        :aria-pressed="book.favorite"
        :title="book.favorite ? '取消收藏' : '收藏'"
        :aria-label="book.favorite ? '取消收藏' : '收藏'"
        data-fav-toggle
        @click.stop="emit('favorite')"
      >
        <AppIcon name="star" :size="13" :filled="book.favorite" />
      </button>

      <button
        v-if="removable"
        type="button"
        class="ct-fav-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-rose-300"
        title="移出书架（不会删除书籍）"
        aria-label="移出书架"
        data-shelf-remove
        @click.stop="emit('remove')"
      >
        <AppIcon name="close" :size="12" />
      </button>
    </div>
  </div>
</template>
