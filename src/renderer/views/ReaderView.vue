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
import TocDrawer from '@/components/reader/TocDrawer.vue'
import SettingsPanel from '@/components/reader/SettingsPanel.vue'
import NotesPanel from '@/components/reader/NotesPanel.vue'
import type { IconName } from '@/components/common/icons'
import { call } from '@/api'
import { pushToast } from '@/lib/toast'
import { ERROR_CODES } from '@shared/errors'
import type { BookDetailDTO, BookmarkDTO, ChapterContentDTO, ChapterDTO, ProgressDTO } from '@shared/dto'
import type { TextSelection } from '@/components/reader/PagedView.vue'
import type { PageSnapshot } from '@/reader/paginate'
import type { ScrollSnapshot } from '@/reader/scroll'
import { useReaderStore, type ReaderMode } from '@/stores/reader'
import { matchesAction, type ShortcutAction } from '@/reader/keymap'
import { windowApi } from '@/api'

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
/** 目录（M2-06）：首次打开抽屉时才拉，进阅读器不该白跑一次 IPC */
const chapters = ref<ChapterDTO[]>([])
const tocOpen = ref(false)
const settingsOpen = ref(false)
/** 书签与划线（M2-09） */
const bookmarks = ref<BookmarkDTO[]>([])
const notesOpen = ref(false)
const exporting = ref(false)
const selection = ref<TextSelection | null>(null)

/** 当前章的划线区间：交给视图套 <mark> */
const chapterHighlights = computed(() =>
  bookmarks.value
    .filter((item) => item.chapterIdx === chapterIdx.value && item.kind === 'highlight' && item.endOffset !== null)
    .map((item) => ({ id: item.id, offset: item.offset, endOffset: item.endOffset }))
)
let chaptersLoaded = false

/**
 * 当前配色。'system' 主题要看系统深浅色，而 Chromium 会跟着系统走，
 * 所以用 matchMedia 而不是自己判断（自己判断迟早和系统设置对不上）。
 */
const systemDark = ref(false)
let themeQuery: MediaQueryList | null = null

const palette = computed(() => reader.palette(systemDark.value))

interface PanelError {
  icon: IconName
  title: string
  desc: string
  /** 是否值得给「重试」按钮（书不存在这种重试也没用） */
  retryable: boolean
  /**
   * 除「重试」之外的恢复动作（M2-11）：
   *   - root：根目录整体换了位置（拔了盘换了盘符）→ 重新指定目录
   *   - file：根目录还在，但这本书的文件被挪走了 → 重新定位文件
   */
  action?: 'root' | 'file'
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
      retryable: true,
      action: 'root'
    }
  }
  if (code === ERROR_CODES.notFound) {
    return {
      icon: 'warning',
      title: '找不到这本书的文件',
      desc: '文件可能被移动、改名或删除了。把它放回原来的目录，或指定一个目录让 cText 按文件名找回来。',
      retryable: true,
      action: 'file'
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
  cancelSave()
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
/**
 * 根目录整体换了位置：选一个新目录，交给 `roots:relocate` 改掉根目录路径。
 * 它会按旧的 rel_path 逐本探测，回来告诉用户「找到 N 本，缺 M 本」。
 */
async function relocateRoot(): Promise<void> {
  const rootId = book.value?.rootId
  if (!rootId) return
  const picked = await call('import:pickFolder').catch(() => null)
  if (!picked) return
  try {
    const result = await call('roots:relocate', { rootId, newPath: picked.path })
    pushToast({
      level: result.missing > 0 ? 'warn' : 'info',
      message: `已重新指定目录：找到 ${result.matched} 本${result.missing > 0 ? `，缺 ${result.missing} 本` : ''}`
    })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '重新指定目录失败' })
    return
  }
  await retry()
}

/** 单本书的文件被挪走：按文件名在新目录下找唯一匹配，改写 rel_path */
async function relocateFile(): Promise<void> {
  const picked = await call('import:pickFolder').catch(() => null)
  if (!picked) return
  try {
    const result = await call('books:relocateFile', { bookId: bookId.value, searchDir: picked.path })
    if (!result.relPath) {
      pushToast({
        level: 'warn',
        message:
          result.candidates > 1
            ? `找到 ${result.candidates} 个同名文件，无法确定是哪一本`
            : '没找到同名文件，换一个目录再试'
      })
      return
    }
    pushToast({ level: 'info', message: '已重新定位到新位置' })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '重新定位失败' })
    return
  }
  await retry()
}

function goChapter(idx: number, atEnd = false): void {
  if (idx < 0) return
  if (book.value && idx >= book.value.chapterCount) return
  void loadChapter(idx, atEnd ? -1 : 0)
}

// ---------------------------------------------------------------- 书签与笔记（M2-09）

async function loadBookmarks(): Promise<void> {
  try {
    bookmarks.value = await call('bookmarks:list', { bookId: bookId.value })
  } catch {
    bookmarks.value = []
  }
}

function clearSelection(): void {
  selection.value = null
  window.getSelection()?.removeAllRanges()
}

/**
 * 划线。
 *
 * 位置存的是「起点 + 终点」两个字符偏移，并且**把选中的文字一起存下来**：
 * 后者不是位置的一部分，而是给人看的（列表里要展示摘录），也是划线画错位置时
 * 唯一能拿来比对的证据。
 */
async function addHighlight(withNote = false): Promise<void> {
  const picked = selection.value
  if (!picked || !chapter.value) return
  try {
    const created = await call('bookmarks:add', {
      bookId: bookId.value,
      chapterIdx: chapterIdx.value,
      offset: picked.offset,
      endOffset: picked.endOffset,
      kind: 'highlight',
      text: picked.text
    })
    if (!bookmarks.value.some((item) => item.id === created.id)) bookmarks.value.push(created)
    clearSelection()
    if (withNote) notesOpen.value = true
  } catch {
    // 失败时保留选区，用户可以重试
  }
}

/** 当前位置加纯书签（没有选区时用，Ctrl+D） */
async function addBookmarkHere(): Promise<void> {
  if (!chapter.value) return
  try {
    const created = await call('bookmarks:add', {
      bookId: bookId.value,
      chapterIdx: chapterIdx.value,
      offset: position.value.offset,
      endOffset: null,
      kind: 'bookmark',
      text: null
    })
    if (!bookmarks.value.some((item) => item.id === created.id)) bookmarks.value.push(created)
    notesOpen.value = true
  } catch {
    // 忽略：书签失败不该打断阅读
  }
}

async function saveNote(id: string, note: string | null): Promise<void> {
  await call('bookmarks:updateNote', { id, note }).catch(() => undefined)
  const target = bookmarks.value.find((item) => item.id === id)
  if (target) target.note = note
}

async function removeNote(id: string): Promise<void> {
  await call('bookmarks:remove', { id }).catch(() => undefined)
  bookmarks.value = bookmarks.value.filter((item) => item.id !== id)
}

function jumpToNote(item: BookmarkDTO): void {
  notesOpen.value = false
  if (item.chapterIdx === chapterIdx.value) {
    // 同一章：直接按偏移重排，不重新拉正文（省一次 IPC，也不闪）
    entryOffset.value = item.offset
    void loadChapter(item.chapterIdx, item.offset)
    return
  }
  void loadChapter(item.chapterIdx, item.offset)
}

async function exportNotes(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const saved = await call('bookmarks:export', { bookId: bookId.value, path: null })
    if (saved) pushToast({ level: 'info', message: `已导出到 ${saved.path}` })
  } catch {
    pushToast({ level: 'error', message: '导出失败' })
  } finally {
    exporting.value = false
  }
}

// ---------------------------------------------------------------- 进度（M2-08）

/**
 * 1s 防抖落库。
 *
 * 为什么不是「每翻一页就写」：连续翻页是常态，一次翻十页就是十次 SQL + 十次
 * JSON 序列化；而读者真正需要的是「停下来之后位置是准的」。1s 也是产品文档
 * §2.6 的口径。
 *
 * 为什么不在 `beforeunload` 里兜底保存：**强杀进程不会触发它**。所以位置
 * 必须在「读者停下来的 1s 内」就已经落库，退出时的 flush 只是正常关闭的补充。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: ProgressDTO | null = null

function currentProgress(): ProgressDTO | null {
  if (!chapter.value || !book.value) return null
  const total = position.value.total
  const within = total > 0 ? Math.min(1, position.value.offset / total) : 0
  const chapters = Math.max(1, book.value.chapterCount)
  return {
    bookId: bookId.value,
    chapterIdx: chapterIdx.value,
    offset: position.value.offset,
    percent: Math.min(1, (chapterIdx.value + within) / chapters)
  }
}

function scheduleSave(): void {
  if (!reader.rememberProgress) return
  pendingSave = currentProgress()
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushProgress, 1000)
}

/** 立即写一次（离开阅读器 / 正常关闭窗口时） */
function flushProgress(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const progress = pendingSave
  pendingSave = null
  if (!progress) return
  void call('reader:saveProgress', progress).catch(() => undefined)
}

/** 换章/换书时丢掉待写进度：新章的 idx 配旧章的偏移会写出一条错得离谱的记录 */
function cancelSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  pendingSave = null
}

// ---------------------------------------------------------------- 目录（M2-06）

async function ensureChapters(): Promise<void> {
  if (chaptersLoaded) return
  try {
    chapters.value = await call('reader:chapters', { bookId: bookId.value })
    chaptersLoaded = true
  } catch {
    // 目录拉不到不该拦住阅读：正文已经在屏幕上，抽屉里空着即可
    chapters.value = []
  }
}

async function toggleToc(): Promise<void> {
  if (tocOpen.value) {
    tocOpen.value = false
    return
  }
  await ensureChapters()
  tocOpen.value = true
}

function jumpTo(idx: number): void {
  tocOpen.value = false
  if (idx === chapterIdx.value) return
  void loadChapter(idx, 0)
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
  scheduleSave()
}

function onScrollProgress(next: ScrollSnapshot): void {
  position.value = { offset: next.offset, total: next.total }
  scheduleSave()
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

/**
 * Esc 的语义分层：先取消刚划出的选区 → 关笔记 → 关排版 → 关目录 → 退出阅读器。
 * 一次 Esc 只做一件事，读者的意图总是「退回到上一步」。
 */
function closeTopLayer(): void {
  if (selection.value) {
    clearSelection()
    return
  }
  if (notesOpen.value) {
    notesOpen.value = false
    return
  }
  if (settingsOpen.value) {
    settingsOpen.value = false
    return
  }
  if (tocOpen.value) {
    tocOpen.value = false
    return
  }
  void router.push('/library')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

  // 键位来自设置（M2-10）：改键之后立刻生效，不需要重启
  const keys = reader.resolvedShortcuts
  const hit = (action: ShortcutAction): boolean => matchesAction(event, action, keys)

  if (hit('reader.back')) {
    event.preventDefault()
    closeTopLayer()
    return
  }
  if (hit('reader.next')) {
    event.preventDefault()
    turn(1, 'page')
    return
  }
  if (hit('reader.prev')) {
    event.preventDefault()
    turn(-1, 'page')
    return
  }
  if (hit('reader.lineNext')) {
    event.preventDefault()
    turn(1, 'line')
    return
  }
  if (hit('reader.linePrev')) {
    event.preventDefault()
    turn(-1, 'line')
    return
  }
  if (hit('reader.toc')) {
    event.preventDefault()
    void toggleToc()
    return
  }
  if (hit('reader.notes')) {
    event.preventDefault()
    notesOpen.value = !notesOpen.value
    return
  }
  if (hit('reader.settings')) {
    event.preventDefault()
    settingsOpen.value = !settingsOpen.value
    return
  }
  if (hit('reader.bookmark')) {
    event.preventDefault()
    void addBookmarkHere()
    return
  }
  if (hit('reader.fontUp')) {
    event.preventDefault()
    reader.stepFontSize(1)
    return
  }
  if (hit('reader.fontDown')) {
    event.preventDefault()
    reader.stepFontSize(-1)
    return
  }
  if (hit('reader.fullscreen')) {
    event.preventDefault()
    windowApi.toggleFullscreen()
  }
}

// ---------------------------------------------------------------- 生命周期

function onSystemTheme(event: MediaQueryListEvent): void {
  systemDark.value = event.matches
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  systemDark.value = themeQuery.matches
  themeQuery.addEventListener('change', onSystemTheme)

  // 先把设置读回来再渲染正文：否则会先用默认字号排一次版，再跳成用户的字号
  await reader.load()
  if (!(await loadBook())) return
  await loadBookmarks()
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
  // 恢复优先级：URL 里的章号（目录跳转/分享链接）> 上次读到的位置 > 第 1 章
  const fromQuery = Number(route.query['chapter'] ?? 0)
  if (Number.isFinite(fromQuery) && fromQuery > 0) {
    await loadChapter(fromQuery)
    return
  }

  const saved = reader.rememberProgress ? await call('reader:progress', { bookId: bookId.value }).catch(() => null) : null
  if (saved && saved.chapterIdx < (book.value?.chapterCount ?? 0)) {
    await loadChapter(saved.chapterIdx, saved.offset)
    return
  }
  await loadChapter(0)
})

function onBeforeUnload(): void {
  flushProgress()
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  flushProgress()
  themeQuery?.removeEventListener('change', onSystemTheme)
  themeQuery = null
})

// 同一组件实例内切换书（书架里连点两本）时重新加载
watch(bookId, async () => {
  book.value = null
  chapter.value = null
  chapterError.value = null
  chapters.value = []
  chaptersLoaded = false
  tocOpen.value = false
  settingsOpen.value = false
  notesOpen.value = false
  bookmarks.value = []
  selection.value = null
  if (await loadBook()) await loadChapter(0)
})
</script>

<template>
  <div
    class="relative flex h-full min-h-0 flex-col bg-app"
    data-reader
    :data-reader-mode="mode"
    :data-reader-theme="reader.theme"
  >
    <!-- 顶栏：返回 / 书名 · 章名 / 页码 / 字号 -->
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-line px-3">
      <button class="ct-icon-btn" title="返回书库（Esc）" data-reader-back @click="router.push('/library')">
        <AppIcon name="chevron-left" :size="16" />
      </button>

      <button class="ct-icon-btn" title="目录（Ctrl+T）" data-reader-toc @click="toggleToc">
        <AppIcon name="list" :size="15" />
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
        <button class="ct-icon-btn" title="书签与笔记" data-reader-notes @click="notesOpen = !notesOpen">
          <AppIcon name="bookmark" :size="15" />
        </button>
        <button class="ct-icon-btn" title="排版与主题" data-reader-settings @click="settingsOpen = !settingsOpen">
          <AppIcon name="settings" :size="15" />
        </button>
      </div>
    </header>

    <!-- 正文舞台：浅色纸面 + 页边距，视口铺满内部 -->
    <main
      class="relative min-h-0 flex-1 overflow-hidden transition-colors duration-200"
      data-reader-stage-outer
      :style="{ background: palette.bg }"
    >
      <div
        class="absolute inset-0"
        data-reader-stage
        :style="{
          background: palette.bg,
          color: palette.text,
          fontFamily: reader.fontStack(),
          paddingLeft: `${reader.typography.margin}px`,
          paddingRight: `${reader.typography.margin}px`,
          paddingTop: `${reader.verticalMargin()}px`,
          paddingBottom: `${reader.verticalMargin()}px`
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
          :highlights="chapterHighlights"
          @page-change="onPageChange"
          @select="selection = $event"
        />
        <ScrollView
          v-else-if="chapter"
          :key="`scroll:${bookId}:${chapterIdx}`"
          ref="scroller"
          :html="chapter.html"
          :typography="reader.typography"
          :start-offset="entryOffset"
          :highlights="chapterHighlights"
          @progress="onScrollProgress"
          @select="selection = $event"
        />
      </div>

      <!-- 选中文字后的操作条：浮在正文上方，不参与排版（否则一选中就重排） -->
      <div
        v-if="selection"
        class="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-line-strong bg-elevated/95 px-1.5 py-1 shadow-lg backdrop-blur"
        data-selection-bar
      >
        <span class="max-w-[220px] truncate px-1 text-[11px] text-faint" data-selection-text>
          {{ selection.text }}
        </span>
        <button class="ct-btn !px-2 !py-1 !text-[11px]" data-highlight @click="addHighlight(false)">划线</button>
        <button class="ct-btn !px-2 !py-1 !text-[11px]" data-highlight-note @click="addHighlight(true)">划线并备注</button>
        <button class="ct-icon-btn" title="取消" data-selection-cancel @click="clearSelection">
          <AppIcon name="close" :size="12" />
        </button>
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
          <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
            <button
              v-if="(chapterError ?? bookError)!.action === 'root'"
              class="ct-btn"
              data-reader-relocate-root
              @click="relocateRoot"
            >
              重新指定目录
            </button>
            <button
              v-if="(chapterError ?? bookError)!.action === 'file'"
              class="ct-btn"
              data-reader-relocate-file
              @click="relocateFile"
            >
              重新定位文件
            </button>
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

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />

    <NotesPanel
      :open="notesOpen"
      :items="bookmarks"
      :current-chapter="chapterIdx"
      :chapters="chapters"
      :exporting="exporting"
      @close="notesOpen = false"
      @jump="jumpToNote"
      @save-note="saveNote"
      @remove="removeNote"
      @export="exportNotes"
    />

    <TocDrawer
      :open="tocOpen"
      :chapters="chapters"
      :current="chapterIdx"
      @jump="jumpTo"
      @close="tocOpen = false"
    />

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
