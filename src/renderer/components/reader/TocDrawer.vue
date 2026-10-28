<script setup lang="ts">
/**
 * 目录抽屉（M2-06）。
 *
 * 两个决定让它能扛住「千章」：
 *   1. **扁平化 + 虚拟滚动**：目录在数据上是树（卷 → 章），但渲染成一张按层级缩进的
 *      平表。折叠只是「算可见行时跳过某个层级之后的行」，不需要真的挂/卸子树。
 *      于是千章目录的 DOM 行数恒等于一屏能放下的行数（实测 30 行左右）。
 *   2. **行高固定**：虚拟滚动靠 `index × 行高` 直接定位，行高一旦随内容变化就得
 *      先量后算。目录行本来就该等宽等高（标题单行省略），这是设计而非妥协。
 *
 * 折叠状态只存 `idx` 的集合：目录数据是只读的，不需要建树对象。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { ChapterDTO } from '@shared/dto'

const props = defineProps<{
  chapters: ChapterDTO[]
  /** 当前章 idx，用于高亮与自动滚动 */
  current: number
  open: boolean
}>()

const emit = defineEmits<{ (e: 'jump', idx: number): void; (e: 'close'): void }>()

/** 行高固定 30px：虚拟滚动按 `index × ROW_H` 定位，改高度要同步这里 */
const ROW_H = 30
const OVERSCAN = 8

interface Row {
  idx: number
  title: string
  level: number
  /** 后面还有更深层级 = 这是个卷，可以折叠 */
  expandable: boolean
}

const scroller = ref<HTMLDivElement | null>(null)
const scrollTop = ref(0)
const viewportH = ref(600)
const collapsed = ref<Set<number>>(new Set())

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const list = props.chapters
  // -1 = 不在跳过状态；否则表示「跳过所有 level 大于它的行」
  let skipDeeperThan = -1
  for (let i = 0; i < list.length; i += 1) {
    const chapter = list[i]!
    if (skipDeeperThan >= 0 && chapter.level > skipDeeperThan) continue
    skipDeeperThan = -1
    const next = list[i + 1]
    const expandable = next !== undefined && next.level > chapter.level
    out.push({ idx: chapter.idx, title: chapter.title, level: chapter.level, expandable })
    if (expandable && collapsed.value.has(chapter.idx)) skipDeeperThan = chapter.level
  }
  return out
})

const firstRow = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const lastRow = computed(() =>
  Math.min(rows.value.length, Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + OVERSCAN)
)
const visibleRows = computed(() =>
  rows.value.slice(firstRow.value, lastRow.value).map((row, i) => ({
    row,
    top: (firstRow.value + i) * ROW_H
  }))
)
const totalHeight = computed(() => rows.value.length * ROW_H)

function onScroll(): void {
  scrollTop.value = scroller.value?.scrollTop ?? 0
}

function measure(): void {
  const el = scroller.value
  if (!el) return
  viewportH.value = el.clientHeight || 600
  scrollTop.value = el.scrollTop
}

/** 把当前章滚到视口中间附近：直接对齐顶部会让读者看不到上下文 */
function revealCurrent(): void {
  const el = scroller.value
  if (!el) return
  measure()
  const index = rows.value.findIndex((row) => row.idx === props.current)
  if (index < 0) return
  el.scrollTop = Math.max(0, index * ROW_H - viewportH.value / 2 + ROW_H / 2)
  scrollTop.value = el.scrollTop
}

function toggle(idx: number): void {
  const next = new Set(collapsed.value)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  collapsed.value = next
}

function jump(idx: number): void {
  emit('jump', idx)
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    revealCurrent()
  }
)

// 换章后（抽屉开着时）跟着滚，别让高亮跑出视口
watch(
  () => props.current,
  () => {
    if (props.open) void nextTick(() => revealCurrent())
  }
)

defineExpose({
  /** 验收用：当前渲染的行数与可见总行数 */
  stats: () => ({ rendered: lastRow.value - firstRow.value, rows: rows.value.length }),
  toggle
})
</script>

<template>
  <div v-if="open" class="absolute inset-0 z-20" data-toc>
    <!-- 背板：点空白处关闭。用半透明而不是纯色，读者还能看到正文的位置 -->
    <div class="absolute inset-0 bg-black/25" @click="emit('close')" />

    <aside
      class="absolute inset-y-0 left-0 flex w-[320px] flex-col border-r border-line bg-sidebar shadow-[8px_0_24px_rgba(0,0,0,.28)]"
      role="dialog"
      aria-label="目录"
    >
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <AppIcon name="list" :size="14" class="text-faint" />
        <span class="text-[12.5px] text-ink">目录</span>
        <span class="text-[11.5px] tabular-nums text-faint" data-toc-count>{{ chapters.length }} 章</span>
        <span class="flex-1" />
        <button class="ct-icon-btn" title="关闭（Esc）" data-toc-close @click="emit('close')">
          <AppIcon name="close" :size="13" />
        </button>
      </header>

      <div
        ref="scroller"
        class="min-h-0 flex-1 overflow-y-auto py-1"
        :data-toc-total="rows.length"
        :data-toc-chapters="chapters.length"
        @scroll.passive="onScroll"
      >
        <div class="relative" :style="{ height: `${totalHeight}px` }">
          <!-- 行用 div 而不是 button：折叠箭头是行内的另一个按钮，
               button 不能嵌套 button（浏览器会把它踢出 DOM，点击行为也不可预期） -->
          <div
            v-for="item in visibleRows"
            :key="item.row.idx"
            class="absolute inset-x-0 flex h-[30px] cursor-pointer items-center gap-1 pr-2 text-[12.5px] transition-colors duration-120 hover:bg-hover"
            :style="{ top: `${item.top}px`, paddingLeft: `${10 + item.row.level * 14}px` }"
            :class="item.row.idx === current ? 'bg-active text-ink' : 'text-dim'"
            role="button"
            tabindex="0"
            :data-toc-row="item.row.idx"
            :data-toc-active="item.row.idx === current ? '1' : undefined"
            :title="item.row.title"
            @click="jump(item.row.idx)"
            @keydown.enter.prevent="jump(item.row.idx)"
          >
            <button
              v-if="item.row.expandable"
              class="ct-icon-btn !h-5 !w-4 shrink-0"
              :data-toc-toggle="item.row.idx"
              :title="collapsed.has(item.row.idx) ? '展开' : '收起'"
              @click.stop="toggle(item.row.idx)"
            >
              <AppIcon :name="collapsed.has(item.row.idx) ? 'chevron-right' : 'chevron-down'" :size="12" />
            </button>
            <span v-else class="w-4 shrink-0" />
            <span class="truncate" :class="item.row.level === 0 && 'font-medium'">{{ item.row.title }}</span>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>
