<script setup lang="ts">
/**
 * 分页视图（M2-04）：把一章 HTML 排成「一屏一页」，并对外暴露翻页与页码。
 *
 * 组件只做三件事——挂 DOM、转调分页引擎、把重排时机管住。分页数学全部在
 * `reader/paginate.ts` 里，那边不依赖 Vue，可以单独测。
 *
 * 三个重排触发点，统一走 rAF 节流（连续拖窗口只会算一次）：
 *   1. 排版参数变化（字号/行距/页边距）
 *   2. 容器尺寸变化（窗口缩放、侧栏折叠）
 *   3. 图片加载完成（EPUB 图文混排，图片撑开段落会改变分页）
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Paginator, type PageSnapshot } from '@/reader/paginate'
import type { ReaderTypography } from '@/stores/reader'

const props = withDefaults(
  defineProps<{
    html: string
    typography: ReaderTypography
    /**
     * 换章后从哪个字符开始。**传 -1 表示从章末开始**（往回翻跨章时停在上一章末页）；
     * 其余值按字符偏移处理，越界会被夹到 [0, 总字数-1]。
     */
    startOffset?: number
  }>(),
  { startOffset: 0 }
)

const emit = defineEmits<{ (e: 'page-change', snap: PageSnapshot): void }>()

const viewport = ref<HTMLDivElement>()
const content = ref<HTMLDivElement>()

let paginator: Paginator | null = null
let raf = 0
let observer: ResizeObserver | null = null

const snapshot = ref<PageSnapshot>({ page: 0, pages: 1, offset: 0, total: 0 })

function publish(): void {
  if (!paginator) return
  snapshot.value = paginator.snapshot()
  emit('page-change', snapshot.value)
}

/** 连续 resize / 连续改字号只重排一次：一帧内多次触发是常态（拖动窗口） */
function scheduleReflow(): void {
  if (raf !== 0) return
  raf = requestAnimationFrame(() => {
    raf = 0
    if (!paginator) return
    paginator.paginate()
    publish()
  })
}

// 换章：DOM 替换后重建字符索引，并从指定偏移开始
watch(
  () => props.html,
  async () => {
    // 等 v-html 真正落到 DOM 上再量：同一 tick 里量到的还是旧内容
    await nextTick()
    if (!paginator) return
    paginator.syncDom()
    paginator.paginate(anchorOf(props.startOffset))
    publish()
  }
)

/** -1（章末）→ 一个必定被夹到末字符的偏移 */
function anchorOf(start: number): number {
  return start < 0 ? Number.MAX_SAFE_INTEGER : start
}

// 改字号/行距/页边距：DOM 没变，字符索引照旧可用，沿用当前页首字符偏移复原
watch(() => props.typography, scheduleReflow, { deep: true })

onMounted(() => {
  if (!viewport.value || !content.value) return
  paginator = new Paginator(viewport.value, content.value)
  paginator.syncDom()
  paginator.paginate(anchorOf(props.startOffset))
  publish()

  observer = new ResizeObserver(() => scheduleReflow())
  observer.observe(viewport.value)

  // 图片是异步解码的，加载完才知道真实高度——不重排的话后半章会整片错位
  content.value.addEventListener('load', onAssetLoad, true)

  // 字体度量也影响断行；系统字体通常已就绪，导入字体则要等
  void document.fonts?.ready.then(() => scheduleReflow())

  installProbe()
})

function onAssetLoad(): void {
  scheduleReflow()
}

onBeforeUnmount(() => {
  if (raf !== 0) cancelAnimationFrame(raf)
  raf = 0
  observer?.disconnect()
  observer = null
  content.value?.removeEventListener('load', onAssetLoad, true)
  paginator?.destroy()
  paginator = null
  delete (window as { __ctextReader?: unknown }).__ctextReader
})

// ---------------------------------------------------------------- 对外接口

/** ok=false 且 atEdge=true 表示已经在本章边界，该换章了 */
interface TurnResult {
  ok: boolean
  atEdge: boolean
}

function next(): TurnResult {
  if (!paginator) return { ok: false, atEdge: false }
  if (paginator.page >= paginator.pages - 1) return { ok: false, atEdge: true }
  paginator.goToPage(paginator.page + 1)
  publish()
  return { ok: true, atEdge: false }
}

function prev(): TurnResult {
  if (!paginator) return { ok: false, atEdge: false }
  if (paginator.page <= 0) return { ok: false, atEdge: true }
  paginator.goToPage(paginator.page - 1)
  publish()
  return { ok: true, atEdge: false }
}

function goto(page: number): void {
  paginator?.goToPage(page)
  publish()
}

defineExpose({
  next,
  prev,
  goto,
  snapshot: () => snapshot.value,
  pages: () => paginator?.pages ?? 0,
  offsetAtPage: (page: number) => paginator?.offsetAtPage(page) ?? -1
})

/**
 * 验收探针（M2-04）。
 *
 * 只在 `window.__CTEXT_SMOKE__` 为真时挂出——验收脚本要读「页号 / 页首偏移 /
 * 总页数」，这些值只有引擎自己知道；让脚本去复刻一套测量逻辑，等于把被测代码
 * 抄一遍再自证。探针只读，改字号/缩放一律走真实 UI，不走这个口子。
 */
function installProbe(): void {
  if (!(window as { __CTEXT_SMOKE__?: boolean }).__CTEXT_SMOKE__) return
  ;(window as { __ctextReader?: unknown }).__ctextReader = {
    snapshot: () => (paginator ? paginator.snapshot() : null),
    pages: () => paginator?.pages ?? 0,
    total: () => paginator?.totalChars ?? 0,
    geometry: () => (paginator ? { ...paginator.geometry } : null),
    offsetAtPage: (page: number) => (paginator ? paginator.offsetAtPage(page) : -1),
    pageOfOffset: (offset: number) => (paginator ? paginator.pageOfOffset(offset) : -1),
    /**
     * 改一次字号并返回这次**真实重排**的耗时（ms）——验收里的「3000 字重排 <16ms」量这个。
     *
     * 为什么必须真的改字号：只调 `paginate()` 时样式与上一次完全相同，布局还是热的，
     * 量到的是「缓存命中的重排」（实测 0.1ms），改字号那一下的代价完全没被测到。
     * 这里把字号 +1px（行数、断行、总页数都会变），量完再改回去并把布局恢复，
     * 探针不留副作用。
     */
    reflowCost: () => {
      const element = content.value
      if (!paginator || !element) return -1
      const original = element.style.fontSize
      const size = Number.parseFloat(original) || 18
      element.style.fontSize = `${size + 1}px`
      const started = performance.now()
      paginator.paginate()
      const cost = performance.now() - started
      element.style.fontSize = original
      paginator.paginate()
      publish()
      return cost
    }
  }
}
</script>

<template>
  <div ref="viewport" class="ct-page-viewport" data-page-viewport>
    <div
      ref="content"
      class="ct-page-content"
      data-page-content
      :data-page="snapshot.page"
      :data-pages="snapshot.pages"
      :style="{
        fontSize: `${typography.fontSize}px`,
        lineHeight: `${typography.lineHeight}`,
        letterSpacing: `${typography.letterSpacing}em`,
        '--ct-para-gap': `${typography.paragraphGap}em`
      }"
      v-html="html"
    />
  </div>
</template>

<style scoped>
.ct-page-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.ct-page-content {
  height: 100%;
  /*
   * column-fill: auto 是分页成立的前提：默认的 balance 会把内容均分到
   * 「容器宽度能放下的列数」里，而那个列数通常是 1 —— 于是整章挤在一页。
   * auto 才是「先填满第一列，再往右开新列」。
   */
  column-fill: auto;
  text-align: justify;
  word-break: break-word;
  /* 翻页是位移，交给合成层；不加这条时快速连按会看到一帧的旧位置 */
  will-change: transform;
}

/* 正文排版：v-html 插进来的元素没有 scoped 属性，必须 :deep 才能命中 */
.ct-page-content :deep(p) {
  margin: 0 0 var(--ct-para-gap, 0.7em);
  text-indent: 2em;
}

.ct-page-content :deep(h1),
.ct-page-content :deep(h2),
.ct-page-content :deep(h3),
.ct-page-content :deep(h4) {
  margin: 0.6em 0 0.5em;
  font-weight: 600;
  line-height: 1.5;
  text-indent: 0;
}

.ct-page-content :deep(h1) {
  font-size: 1.24em;
}

.ct-page-content :deep(h2) {
  font-size: 1.12em;
}

.ct-page-content :deep(blockquote) {
  margin: 0.6em 0;
  padding-left: 0.8em;
  border-left: 2px solid currentColor;
  opacity: 0.8;
}

.ct-page-content :deep(ul),
.ct-page-content :deep(ol) {
  margin: 0 0 var(--ct-para-gap, 0.7em);
  padding-left: 1.6em;
}

.ct-page-content :deep(li) {
  margin: 0.2em 0;
}

/* 图片不能高过一页：否则会溢出列高，把后面所有页的分页全部挤错 */
.ct-page-content :deep(img) {
  display: block;
  max-width: 100%;
  max-height: calc(var(--ct-page-height, 600px) - 2em);
  margin: 0.5em auto;
  object-fit: contain;
}

.ct-page-content :deep(table) {
  width: 100%;
  margin: 0.5em 0;
  border-collapse: collapse;
}

.ct-page-content :deep(td),
.ct-page-content :deep(th) {
  padding: 0.25em 0.5em;
  border: 1px solid currentColor;
  text-align: left;
}
</style>
