<script setup lang="ts">
/**
 * 滚动视图（M2-05）。
 *
 * 与分页视图共用同一份 HTML 与同一套正文样式，区别只在于「内容是一整列往下流」
 * 而不是「一屏一列」。所以它不需要测量分页，只需要两件事：
 *   - 滚动时**记住顶部是哪个字符**（`ScrollPositioner.capture`）
 *   - 排版/尺寸变化后**把那个字符滚回顶部**（`restore`）
 *
 * 两件事都落在「字符偏移」上，于是与分页模式、与 `reading_progress.offset`
 * 用的是同一个坐标系——切模式就是「读一个偏移、按另一种排版还原」。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ScrollPositioner, type ScrollResult, type ScrollSnapshot } from '@/reader/scroll'
import { applyHighlights, clearHighlights, readHighlights, type HighlightRange } from '@/reader/highlight'
import type { TextSelection } from '@/components/reader/PagedView.vue'
import type { ReaderTypography } from '@/stores/reader'

const props = withDefaults(
  defineProps<{
    html: string
    typography: ReaderTypography
    /** 进入时的章内字符偏移；-1 表示从章末开始 */
    startOffset?: number
    /** 本章划线（M2-09） */
    highlights?: HighlightRange[]
  }>(),
  { startOffset: 0, highlights: () => [] }
)

const emit = defineEmits<{
  (e: 'progress', snap: ScrollSnapshot): void
  (e: 'select', selection: TextSelection | null): void
}>()

const viewport = ref<HTMLDivElement>()
const content = ref<HTMLDivElement>()

let positioner: ScrollPositioner | null = null
let raf = 0
let observer: ResizeObserver | null = null

function publish(): void {
  if (!positioner) return
  emit('progress', positioner.snapshot())
}

/** 滚动事件按帧合并：一次滚轮会连发几十个事件，每个都量字符位置没有必要 */
function onScroll(): void {
  if (raf !== 0) return
  raf = requestAnimationFrame(() => {
    raf = 0
    positioner?.capture()
    publish()
  })
}

/** 图片解码完成后高度会变：顶部字符必须留在原地，否则读到一半会自己往上跳 */
function onAssetLoad(): void {
  if (!positioner) return
  positioner.restore()
  publish()
}

function anchorOf(start: number): number {
  return start < 0 ? Number.MAX_SAFE_INTEGER : start
}

watch(
  () => props.html,
  async () => {
    await nextTick()
    if (!positioner) return
    positioner.syncDom()
    positioner.scrollToOffset(anchorOf(props.startOffset))
    applyMarks()
    publish()
  }
)

/** 见 PagedView 的同名函数：先拆旧 mark → 套新 mark → 重建索引（mark 不影响排版） */
function applyMarks(): void {
  const element = content.value
  if (!element || !positioner) return
  clearHighlights(element)
  if (props.highlights && props.highlights.length > 0) {
    applyHighlights(element, positioner.textIndex, props.highlights)
  }
  positioner.syncDom()
}

watch(
  () => props.highlights,
  () => applyMarks(),
  { deep: true }
)

watch(
  () => props.typography,
  () => {
    // 等一帧让新字号落到布局上，再按「同一个字符」把位置找回来
    requestAnimationFrame(() => {
      if (!positioner) return
      positioner.restore()
      publish()
    })
  },
  { deep: true }
)

onMounted(() => {
  if (!viewport.value || !content.value) return
  positioner = new ScrollPositioner(viewport.value, content.value)
  positioner.syncDom()
  positioner.scrollToOffset(anchorOf(props.startOffset))
  applyMarks()
  publish()

  content.value.addEventListener('mouseup', onMouseUp)
  observer = new ResizeObserver(() => {
    positioner?.restore()
    publish()
  })
  observer.observe(viewport.value)

  content.value.addEventListener('load', onAssetLoad, true)
  void document.fonts?.ready.then(() => {
    positioner?.restore()
    publish()
  })

  installProbe()
})

onBeforeUnmount(() => {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  observer?.disconnect()
  observer = null
  content.value?.removeEventListener('load', onAssetLoad, true)
  content.value?.removeEventListener('mouseup', onMouseUp)
  positioner = null
  delete (window as { __ctextScroll?: unknown }).__ctextScroll
})

/** 选区 → 章内字符偏移（与 PagedView 同一套换算） */
function onMouseUp(): void {
  const selection = window.getSelection()
  const element = content.value
  if (!positioner || !element) return
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    emit('select', null)
    return
  }
  const range = selection.getRangeAt(0)
  if (!element.contains(range.commonAncestorContainer)) {
    emit('select', null)
    return
  }
  const offset = positioner.textIndex.offsetAt(range.startContainer, range.startOffset)
  const endOffset = positioner.textIndex.offsetAt(range.endContainer, range.endOffset)
  if (offset < 0 || endOffset < 0 || endOffset <= offset) {
    emit('select', null)
    return
  }
  emit('select', { offset, endOffset, text: range.toString() })
}

// ---------------------------------------------------------------- 对外接口

function scrollPage(direction: 1 | -1): ScrollResult {
  const result = positioner?.scrollPage(direction) ?? 'edge'
  publish()
  return result
}

function scrollLine(direction: 1 | -1): ScrollResult {
  const result = positioner?.scrollLine(direction) ?? 'edge'
  publish()
  return result
}

defineExpose({
  scrollPage,
  scrollLine,
  snapshot: (): ScrollSnapshot | null => positioner?.snapshot() ?? null,
  offsetAtTop: () => positioner?.offsetAtTop() ?? 0
})

/**
 * 验收探针。与分页视图分开挂（`__ctextScroll`）：两种模式可能先后出现，
 * 共用一个键会互相覆盖，验收脚本就没法区分「现在量的是哪种模式」。
 */
function installProbe(): void {
  if (!(window as { __CTEXT_SMOKE__?: boolean }).__CTEXT_SMOKE__) return
  ;(window as { __ctextScroll?: unknown }).__ctextScroll = {
    snapshot: () => (positioner ? positioner.snapshot() : null),
    offsetAtTop: () => positioner?.offsetAtTop() ?? 0,
    total: () => positioner?.total ?? 0,
    scrollTop: () => positioner?.scrollTop ?? 0,
    marks: () => (content.value ? readHighlights(content.value) : []),
    upToOffset: (offset: number) => positioner?.scrollToOffset(offset)
  }
}
</script>

<template>
  <div ref="viewport" class="ct-scroll-viewport" data-scroll-viewport @scroll.passive="onScroll">
    <div
      ref="content"
      class="ct-scroll-content ct-reader-content"
      data-scroll-content
      :style="{
        fontSize: `${typography.fontSize}px`,
        lineHeight: `${typography.lineHeight}`,
        letterSpacing: `${typography.letterSpacing}em`,
        '--ct-para-gap': `${typography.paragraphSpacing}em`,
        '--ct-page-height': '100vh'
      }"
      v-html="html"
    />
  </div>
</template>

<style scoped>
.ct-scroll-viewport {
  /* 同 PagedView：用 100% 宽高而不是 absolute inset-0，否则父元素的页边距 padding 会被忽略 */
  position: relative;
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  /* 滚到底不要带着整个页面继续滚：阅读器之外没有可滚的东西，弹性回弹只会让人以为卡了 */
  overscroll-behavior: contain;
}

.ct-scroll-content {
  min-height: 100%;
  /* 末段留白：否则最后一行会正好贴在窗口底边 */
  padding-bottom: 3em;
}

/* 阅读区的滚动条要存在感低一点——浅色纸面上一条深色滚动条很扎眼 */
.ct-scroll-viewport::-webkit-scrollbar {
  width: 10px;
}

.ct-scroll-viewport::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 6px;
  background-clip: content-box;
  background-color: rgb(0 0 0 / 0.18);
}

.ct-scroll-viewport::-webkit-scrollbar-thumb:hover {
  background-color: rgb(0 0 0 / 0.3);
}

.ct-scroll-viewport::-webkit-scrollbar-track {
  background: transparent;
}
</style>
