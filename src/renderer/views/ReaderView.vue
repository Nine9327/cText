<script setup lang="ts">
/**
 * 阅读器（M2-04 起）。
 *
 * 这一段承担「读一章」：进书 → 分页/滚动两种模式 → 跨章 → 退出。
 * 两种模式共用同一个「章内字符偏移」作为位置，所以切换模式、改字号之后
 * 停留位置都不丢（M2-05）。
 * 目录抽屉（M2-06）、排版面板（M2-07）、进度落库（M2-08）、书签（M2-09）、
 * 快捷键表（M2-10）、离线重定位（M2-11）都在后续节点接进来。
 *
 * 章节状态放在路由里（`?chapter=`）而不是 store：M2-06 的「目录跳转」与
 * M2-08 的「启动恢复」本质都是「给出一个 chapterIdx」，走 URL 让它们不必
 * 认识阅读器的内部状态，也顺带让重启后能直接回到同一章。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PagedView from '@/components/reader/PagedView.vue'
import ScrollView from '@/components/reader/ScrollView.vue'
import type { IconName } from '@/components/common/icons'
import { call } from '@/api'
import { ERROR_CODES } from '@shared/errors'
import type { BookDetailDTO, ChapterContentDTO } from '@shared/dto'
import type { PageSnapshot } from '@/reader/paginate'
import type { ScrollSnapshot } from '@/reader/scroll'
import { FONT_SIZE_MAX, FONT_SIZE_MIN, useReaderStore, type ReaderMode } from '@/stores/reader'

const route = useRoute()
const router = useRouter()
const reader = useReaderStore()

const MODES: { value: ReaderMode; label: string }[] = [
  { value: 'paged', label: '分页' },
  { value: 'scroll', label: '滚动' }
]

const book = ref<BookDetailDTO | null>(null)
const chapter = ref<ChapterContentDTO | null>(null)
const chapterIdx = ref(0)
/** 进入当前视图时从哪个字符开始（换章是 0，往回翻是 -1=章末，切模式是当前偏移） */
const entryOffset = ref(0)
/**
 * 当前位置 = 章内字符偏移。**两种阅读模式共用这一个量**：
 * 分页模式给的是「当前页首字符」，滚动模式给的是「顶部可见字符」。
 */
const position = ref({ offset: 0, total: 0 })
/** 分页模式的页码（滚动模式下没有意义） */
const snapshot = ref<PageSnapshot>({ page: 0, pages: 1, offset: 0, total: 0 })
/** 章节正文请求在途：用来显示细进度条，但**不清空**已有正文（否则每次翻章都闪白） */
const pending = ref(false)

interface PanelError {
  icon: IconName
  title: string
  desc: string
  /** 是否值得给「重试」按钮（书不存在这种重试也没用） */
  retryable: boolean
}

const bookError = ref<PanelError | null>(null)
const chapterError = ref<PanelError | null>(null)

const bookId = computed(() => String(route.params['bookId'] ?? ''))

/** 未手动选过时按格式取默认：EPUB 滚动、TXT 分页（产品文档 §2.6） */
const mode = computed<ReaderMode>(() => reader.modeFor(book.value?.format))

const chapterPercent = computed(() =>
  position.value.total > 0 ? Math.min(1, position.value.offset / position.value.total) : 0
)

const percent = computed(() => {
  if (!book.value || !chapter.value) return 0
  const chapters = Math.max(1, book.value.chapterCount)
  return Math.min(1, (chapterIdx.value + chapterPercent.value) / chapters)
})

/** 分页模式显页码，滚动模式显章内百分比——两种模式都要有个「读到哪了」的读数 */
const pageLabel = computed(() =>
  mode.value === 'paged'
    ? `${snapshot.value.page + 1} / ${snapshot.value.pages}`
    : `${Math.round(chapterPercent.value * 100)}%`
)

function describe(err: unknown): PanelError {
  const code = (err as { code?: string }).code ?? ''
  if (code === ERROR_CODES.rootOffline) {
    return {
      icon: 'offline',
      title: '书籍所在目录当前离线',
      desc: '插回移动硬盘或重新连接网络位置后再试。进度与书签都在本地保存，不会丢。',
      retryable: true
    }
  }
  if (code === ERROR_CODES.notFound) {
    return {
      icon: 'warning',
      title: '找不到这本书的文件',
      desc: '文件可能被移动、改名或删除了。把它放回原来的目录，或在设置里重新指定书库目录。',
      retryable: true
    }
  }
  if (code === ERROR_CODES.parseFailed) {
    return {
      icon: 'error',
      title: '这一章读不出来',
      desc: '文件可能已损坏，或者内容加密。',
      retryable: true
    }
  }
  const message = err instanceof Error ? err.message : '未知错误'
  return { icon: 'error', title: '打不开这一章', desc: message, retryable: true }
}

async function loadBook(): Promise<boolean> {
  bookError.value = null
  try {
    const detail = await call('library:get', { id: bookId.value })
    if (!detail) {
      bookError.value = {
        icon: 'warning',
        title: '这本书不在书库里',
        desc: '它可能已被移除。返回书库看看还有没有。',
        retryable: false
      }
      return false
    }
    book.value = detail
    return true
  } catch (err) {
    bookError.value = describe(err)
    return false
  }
}

async function loadChapter(idx: number, offset = 0): Promise<void> {
  if (idx < 0) return
  if (book.value && idx >= book.value.chapterCount) return
  pending.value = true
  chapterError.value = null
  try {
    const content = await call('reader:content', { bookId: bookId.value, chapterIdx: idx })
    entryOffset.value = offset
    chapterIdx.value = idx
    chapter.value = content
    // 章节写进 URL：刷新/重启能回到同一章，M2-06 的跳转也只是改这个参数
    if (Number(route.query['chapter'] ?? 0) !== idx) {
      void router.replace({ query: { ...route.query, chapter: String(idx) } })
    }
  } catch (err) {
    chapterError.value = describe(err)
  } finally {
    pending.value = false
  }
}

async function retry(): Promise<void> {
  if (bookError.value) {
    if (!(await loadBook())) return
  }
  if (chapter.value || chapterError.value) {
    const panel = chapterError.value
    chapterError.value = null
    // 离线态先让主进程复核一次根目录：用户刚插回硬盘时，这里应该直接成功
    if (panel?.icon === 'offline') await call('roots:check').catch(() => undefined)
    await loadChapter(chapterIdx.value, entryOffset.value)
  }
}

/**
 * 换章。
 *
 * `atEnd` 只在「往回翻」时为真：从第 2 章第 1 页按 ← 应该落到第 1 章的**最后一页**，
 * 落到第 1 页的话读者要重新翻一遍整章才能回到原来的位置。
 */
function goChapter(idx: number, atEnd = false): void {
  if (idx < 0) return
  if (book.value && idx >= book.value.chapterCount) return
  void loadChapter(idx, atEnd ? -1 : 0)
}

// ---------------------------------------------------------------- 翻页 / 滚动

const paged = ref<InstanceType<typeof PagedView> | null>(null)
const scroller = ref<InstanceType<typeof ScrollView> | null>(null)

/**
 * 前进/后退一格。
 *
 * `unit='page'` 是整屏（←/→、空格、PgUp/PgDn），`unit='line'` 是单行（↑/↓）。
 * 两种模式的边界处理一样：到头了就换章——但「回头」时落到上一章末页
 * （`atEnd`），不是第 1 页。
 */
function turn(direction: 1 | -1, unit: 'page' | 'line' = 'page'): void {
  if (!chapter.value || chapterError.value) return
  if (mode.value === 'paged') {
    const result = direction === 1 ? paged.value?.next() : paged.value?.prev()
    if (result && !result.ok && result.atEdge) goChapter(chapterIdx.value + direction, direction === -1)
    return
  }
  const result =
    unit === 'line' ? scroller.value?.scrollLine(direction) : scroller.value?.scrollPage(direction)
  if (result === 'edge') goChapter(chapterIdx.value + direction, direction === -1)
}

function onPageChange(next: PageSnapshot): void {
  snapshot.value = next
  position.value = { offset: next.offset, total: next.total }
}

function onScrollProgress(next: ScrollSnapshot): void {
  position.value = { offset: next.offset, total: next.total }
}

/**
 * 切模式。**切换前先记下当前字符偏移**，新视图就以它为入口——
 * 这就是「切模式后停留位置不丢」的全部实现：两个视图认同一个坐标系。
 */
function setMode(next: ReaderMode): void {
  if (mode.value === next) return
  entryOffset.value = position.value.offset
  reader.setMode(next)
}

// ---------------------------------------------------------------- 键盘

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

  if (event.ctrlKey && (event.key === '=' || event.key === '+' || event.key === '-')) {
    event.preventDefault()
    reader.stepFontSize(event.key === '-' ? -1 : 1)
    return
  }

  switch (event.key) {
    case 'ArrowRight':
    case 'PageDown':
      event.preventDefault()
      turn(1)
      break
    case 'ArrowLeft':
    case 'PageUp':
      event.preventDefault()
      turn(-1)
      break
    case 'ArrowDown':
      event.preventDefault()
      turn(1, 'line')
      break
    case 'ArrowUp':
      event.preventDefault()
      turn(-1, 'line')
      break
    case ' ':
      event.preventDefault()
      turn(event.shiftKey ? -1 : 1)
      break
    case 'Escape':
      event.preventDefault()
      void router.push('/library')
      break
    default:
      break
  }
}

// ---------------------------------------------------------------- 生命周期

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  if (!(await loadBook())) return
  if (!book.value || book.value.chapterCount <= 0) {
    // 空文件 / 解析出 0 章的样本：留在骨架上等一个永远不来的正文最难排查
    chapterError.value = {
      icon: 'info',
      title: '这本书没有可读的内容',
      desc: '文件里没有识别到章节，也可能是空文件。',
      retryable: false
    }
    return
  }
  const fromQuery = Number(route.query['chapter'] ?? 0)
  await loadChapter(Number.isFinite(fromQuery) && fromQuery > 0 ? fromQuery : 0)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// 同一组件实例内切换书（书架里连点两本）时重新加载
watch(bookId, async () => {
  book.value = null
  chapter.value = null
  chapterError.value = null
  if (await loadBook()) await loadChapter(0)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-app" data-reader :data-reader-mode="mode">
    <!-- 顶栏：返回 / 书名 · 章名 / 页码 / 字号 -->
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
      <button class="ct-icon-btn" title="返回书库（Esc）" data-reader-back @click="router.push('/library')">
        <AppIcon name="chevron-left" :size="16" />
      </button>

      <div class="min-w-0 flex-1">
        <p class="truncate text-[12.5px] text-ink" data-reader-title>
          {{ book?.title ?? '加载中…' }}
          <span v-if="chapter" class="text-faint">· {{ chapter.title }}</span>
        </p>
      </div>

      <div class="flex items-center gap-1.5">
        <!-- 模式切换：分页 / 滚动（产品文档 §2.6「与分页模式可切换」） -->
        <div class="flex items-center rounded-md border border-line p-0.5" data-reader-mode>
          <button
            v-for="item in MODES"
            :key="item.value"
            class="rounded px-1.5 py-[3px] text-[11px] leading-none transition-colors duration-120"
            :class="mode === item.value ? 'bg-active text-ink' : 'text-faint hover:text-dim'"
            :data-mode="item.value"
            :aria-pressed="mode === item.value"
            @click="setMode(item.value)"
          >
            {{ item.label }}
          </button>
        </div>

        <span class="min-w-[52px] text-right text-[11.5px] tabular-nums text-faint" data-reader-page>
          {{ chapter ? pageLabel : '' }}
        </span>
        <button
          class="ct-icon-btn"
          title="减小字号（Ctrl+-）"
          data-font-down
          :disabled="reader.typography.fontSize <= FONT_SIZE_MIN"
          @click="reader.stepFontSize(-1)"
        >
          <span class="text-[11px] leading-none">A−</span>
        </button>
        <button
          class="ct-icon-btn"
          title="增大字号（Ctrl+=）"
          data-font-up
          :disabled="reader.typography.fontSize >= FONT_SIZE_MAX"
          @click="reader.stepFontSize(1)"
        >
          <span class="text-[13px] leading-none">A+</span>
        </button>
      </div>
    </header>

    <!-- 正文舞台：浅色纸面 + 页边距，视口铺满内部 -->
    <main class="relative min-h-0 flex-1 overflow-hidden bg-[#f7f5ef]">
      <div
        class="absolute inset-0 text-[#2b2b2b]"
        :style="{
          paddingLeft: `${reader.typography.marginX}px`,
          paddingRight: `${reader.typography.marginX}px`,
          paddingTop: `${reader.typography.marginY}px`,
          paddingBottom: `${reader.typography.marginY}px`
        }"
      >
        <!-- 两种模式互斥渲染：key 带上模式，切换时整块重建，位置由 entryOffset 带过去 -->
        <PagedView
          v-if="chapter && mode === 'paged'"
          :key="`paged:${bookId}:${chapterIdx}`"
          ref="paged"
          :html="chapter.html"
          :typography="reader.typography"
          :start-offset="entryOffset"
          @page-change="onPageChange"
        />
        <ScrollView
          v-else-if="chapter"
          :key="`scroll:${bookId}:${chapterIdx}`"
          ref="scroller"
          :html="chapter.html"
          :typography="reader.typography"
          :start-offset="entryOffset"
          @progress="onScrollProgress"
        />
      </div>

      <!-- 首屏骨架：正文没到之前给出行块，避免一片空白 -->
      <div v-if="!chapter && !chapterError" class="absolute inset-0 flex flex-col gap-3 p-12" data-reader-skeleton>
        <div v-for="n in 9" :key="n" class="h-3 animate-pulse rounded bg-black/10" :style="{ width: n % 4 === 0 ? '62%' : '100%' }" />
      </div>

      <!-- 异常态：离线 / 文件缺失 / 解析失败都落在这里 -->
      <div v-if="chapterError || bookError" class="absolute inset-0 flex items-center justify-center bg-app" data-reader-panel>
        <EmptyState
          :icon="(chapterError ?? bookError)!.icon"
          :title="(chapterError ?? bookError)!.title"
          :desc="(chapterError ?? bookError)!.desc"
        >
          <div class="mt-1 flex items-center gap-2">
            <button v-if="(chapterError ?? bookError)!.retryable" class="ct-btn" data-reader-retry @click="retry">
              重试
            </button>
            <button class="ct-btn" @click="router.push('/library')">返回书库</button>
          </div>
        </EmptyState>
      </div>

      <!-- 换章在途：只给一条细进度线，正文留在原位 -->
      <div v-if="pending" class="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
        <div class="h-full w-1/3 animate-pulse bg-accent/70" />
      </div>
    </main>

    <!-- 底栏：上一章 / 进度 / 下一章 -->
    <footer class="flex h-10 shrink-0 items-center gap-3 border-t border-line px-3">
      <button class="ct-btn" data-reader-prev :disabled="!chapter?.hasPrev" @click="goChapter(chapterIdx - 1, true)">
        <AppIcon name="chevron-left" :size="13" />
        上一章
      </button>

      <div class="min-w-0 flex-1">
        <div class="h-1 overflow-hidden rounded-full bg-active">
          <div class="h-full rounded-full bg-accent transition-[width] duration-200" :style="{ width: `${percent * 100}%` }" />
        </div>
      </div>

      <span class="text-[11.5px] tabular-nums text-faint" data-reader-percent>
        {{ Math.round(percent * 100) }}%
      </span>

      <button class="ct-btn" data-reader-next :disabled="!chapter?.hasNext" @click="goChapter(chapterIdx + 1)">
        下一章
        <AppIcon name="chevron-right" :size="13" />
      </button>
    </footer>
  </div>
</template>
