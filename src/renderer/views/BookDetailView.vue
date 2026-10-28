<script setup lang="ts">
/**
 * 书籍详情页（M3-04，路由 `/book/:bookId`）。
 *
 * 这一页回答四个问题，顺序也是页面的顺序：
 *   1. **这是什么书**——封面、书名、作者、阅读状态、简介（都可改）；
 *   2. **它被怎么组织**——分类（题材标签）与书架（阅读安排），两者语义不同，
 *      所以是两个区块而不是一个「标签云」；
 *   3. **里面有什么**——章节列表（千章也要能秒开）与书签/划线汇总；
 *   4. **它从哪来**——根目录、相对路径、格式、大小、编码。
 *
 * 编辑一律「失焦或回车才提交」：书名/简介是打一半状态最多的字段，
 * 逐字 IPC 会让「三体」在输入过程中先把库里的记录改成「三」。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { pushToast } from '@/lib/toast'
import { coverGradient } from '@/lib/cover'
import { useLibraryStore } from '@/stores/library'
import { call } from '@/api/client'
import type { BookDetailDTO, BookmarkDTO, ChapterDTO } from '@shared/dto'

const route = useRoute()
const router = useRouter()
const library = useLibraryStore()

const bookId = computed(() => route.params['bookId'] as string)
const book = ref<BookDetailDTO | null>(null)
const chapters = ref<ChapterDTO[]>([])
const bookmarks = ref<BookmarkDTO[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

// ---------------------------------------------------------------- 元信息编辑

/** 当前在编辑哪个字段（null = 都没在编辑）。同一时刻只允许一个，避免两个输入框互相覆盖 */
const editing = ref<string | null>(null)
const draft = ref('')

interface MetaField {
  key: 'title' | 'author' | 'series' | 'publisher' | 'pubDate' | 'language'
  label: string
  value: string | null
  placeholder: string
}

const metaFields = computed<MetaField[]>(() => {
  const current = book.value
  if (!current) return []
  return [
    { key: 'title', label: '书名', value: current.title, placeholder: '未命名' },
    { key: 'author', label: '作者', value: current.author, placeholder: '佚名' },
    { key: 'series', label: '系列', value: current.series, placeholder: '未填写' },
    { key: 'publisher', label: '出版社', value: current.publisher, placeholder: '未填写' },
    { key: 'pubDate', label: '出版日期', value: current.pubDate, placeholder: '未填写' },
    { key: 'language', label: '语言', value: current.language, placeholder: '未填写' }
  ]
})

function startEdit(field: MetaField): void {
  editing.value = field.key
  draft.value = field.value ?? ''
}

async function submitEdit(): Promise<void> {
  const key = editing.value
  if (!key || !book.value) return
  editing.value = null
  const patch: Record<string, string | null> = { [key]: draft.value }
  try {
    const updated = await call('library:update', { id: book.value.id, patch })
    if (updated) book.value = updated
    // 书名/作者改了会影响列表与搜索：其它页面重新拉一次（本页数据已经是最新的）
    library.refresh()
    pushToast({ level: 'info', message: '已保存' })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '保存失败' })
  }
}

const introDraft = ref('')
const introEditing = ref(false)

async function submitIntro(): Promise<void> {
  if (!book.value) return
  introEditing.value = false
  try {
    const updated = await call('library:update', { id: book.value.id, patch: { intro: introDraft.value } })
    if (updated) book.value = updated
    library.refresh()
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '保存简介失败' })
  }
}

// ---------------------------------------------------------------- 分类 / 书架

const categoriesOpen = ref(false)
const categoryDraft = ref<string[]>([])
const shelvesOpen = ref(false)

function openCategories(): void {
  categoryDraft.value = (book.value?.categories ?? []).map((item) => item.id)
  categoriesOpen.value = true
}

async function submitCategories(): Promise<void> {
  if (!book.value) return
  categoriesOpen.value = false
  try {
    await call('library:setCategories', { id: book.value.id, categoryIds: [...categoryDraft.value] })
    book.value = await call('library:get', { id: book.value.id })
    pushToast({ level: 'info', message: '分类已更新' })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '更新分类失败' })
  }
}

async function toggleShelf(shelfId: string, on: boolean): Promise<void> {
  if (!book.value) return
  try {
    if (on) await library.addToShelf(shelfId, [book.value.id])
    else await library.removeFromShelf(shelfId, [book.value.id])
    book.value = await call('library:get', { id: book.value.id })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '书架操作失败' })
  }
}

function inShelf(shelfId: string): boolean {
  return (book.value?.shelves ?? []).some((item) => item.id === shelfId)
}

async function toggleFavorite(): Promise<void> {
  if (!book.value) return
  try {
    const next = !book.value.favorite
    await call('library:toggleFavorite', { id: book.value.id, value: next })
    book.value.favorite = next
    await library.reload()
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '收藏失败' })
  }
}

// ---------------------------------------------------------------- 章节列表

/**
 * 章节列表的虚拟滚动：固定 30px 行高 + 窗口化。
 *
 * 千章的书如果直接 v-for，DOM 会有上千个节点，打开详情页要几百毫秒；
 * 窗口化之后 DOM 恒为可视行数（约 12 行）。行高固定所以 `index * 30` 直接定位，
 * 不需要测量——与目录抽屉同一套手法。
 */
const CHAPTER_ROW = 30
const CHAPTER_BOX = 330
const chapterFilter = ref('')
const chapterScroll = ref(0)

const filteredChapters = computed(() => {
  const keyword = chapterFilter.value.trim()
  if (!keyword) return chapters.value
  return chapters.value.filter((chapter) => chapter.title.includes(keyword))
})

const visibleChapters = computed(() => {
  const start = Math.max(0, Math.floor(chapterScroll.value / CHAPTER_ROW) - 3)
  const end = Math.min(
    filteredChapters.value.length,
    Math.ceil((chapterScroll.value + CHAPTER_BOX) / CHAPTER_ROW) + 3
  )
  return filteredChapters.value.slice(start, end).map((chapter, index) => ({
    chapter,
    top: (start + index) * CHAPTER_ROW
  }))
})

function onChapterScroll(event: Event): void {
  chapterScroll.value = (event.target as HTMLElement).scrollTop
}

function openChapter(idx: number): void {
  void router.push(`/reader/${bookId.value}?chapter=${idx}`)
}

// ---------------------------------------------------------------- 书签跳转

/**
 * 跳到书签/划线所在位置。**必须带 `offset`**：只带章号只能跳到那一章开头，
 * 而一条划线通常在第 3 页——那就等于「跳到了但没跳对」。
 */
function openBookmark(bookmark: BookmarkDTO): void {
  void router.push(`/reader/${bookId.value}?chapter=${bookmark.chapterIdx}&offset=${bookmark.offset}`)
}

function openReader(): void {
  void router.push(`/reader/${bookId.value}`)
}

// ---------------------------------------------------------------- 加载

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const detail = await call('library:get', { id: bookId.value })
    if (!detail) {
      loadError.value = '这本书不在书库中，可能已被移除'
      book.value = null
      return
    }
    book.value = detail
    introDraft.value = detail.intro ?? ''
    // 分类/书架选择器要用到这两份列表；深链接直接进详情页时 store 还没加载过
    void library.loadCategories()
    void library.loadShelves()
    // 章节目录与书签是次要信息：失败了不影响页面主体（正文入口仍然可用）
    const [chapterList, bookmarkList] = await Promise.all([
      call('reader:chapters', { bookId: bookId.value }).catch(() => []),
      call('bookmarks:list', { bookId: bookId.value }).catch(() => [])
    ])
    chapters.value = chapterList
    bookmarks.value = bookmarkList
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载书籍失败'
  } finally {
    loading.value = false
  }
}

watch(bookId, () => void load(), { immediate: true })
onBeforeUnmount(() => {
  editing.value = null
})

// ---------------------------------------------------------------- 展示辅助

const coverStyle = computed(() => {
  const id = book.value?.id ?? ''
  const { from, to } = coverGradient(id)
  return { background: `linear-gradient(155deg, ${from} 0%, ${to} 100%)` }
})

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

const formatDate = (ts: number | null): string => {
  if (!ts) return '—'
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const stateText = computed(() => {
  const current = book.value
  if (!current) return ''
  if (current.readState === 'finished') return '已读完'
  if (current.readState === 'reading') return `已读 ${Math.round(current.progress * 100)}%`
  return '未读'
})
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <div class="flex h-14 shrink-0 items-center gap-3 px-6">
      <button type="button" class="ct-icon-btn" title="返回书库" aria-label="返回书库" data-detail-back @click="router.back()">
        <AppIcon name="chevron-left" :size="16" />
      </button>
      <h1 class="text-[15px] font-medium text-ink" data-detail-title>{{ book?.title ?? '书籍详情' }}</h1>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <div v-if="loading" class="py-16 text-center text-[12.5px] text-faint" data-detail-loading>正在加载…</div>

      <EmptyState
        v-else-if="loadError"
        icon="warning"
        title="打不开这本书"
        :desc="loadError"
      >
        <button type="button" class="ct-btn" @click="load">重试</button>
      </EmptyState>

      <template v-else-if="book">
        <!-- 主信息 -->
        <section class="flex gap-5">
          <div
            class="relative h-[168px] w-[124px] shrink-0 overflow-hidden rounded-lg shadow-[0_6px_20px_rgba(0,0,0,.45)]"
            :style="coverStyle"
            data-detail-cover
          >
            <span class="pointer-events-none absolute inset-y-0 left-0 w-[6px] bg-black/25" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start gap-2">
              <h2 class="min-w-0 flex-1 text-[17px] font-medium leading-snug text-ink" data-detail-name>{{ book.title }}</h2>
              <button
                type="button"
                class="ct-fav-btn"
                :class="book.favorite ? 'ct-fav-on' : 'opacity-70 hover:opacity-100'"
                :aria-pressed="book.favorite"
                :title="book.favorite ? '取消收藏' : '收藏'"
                data-detail-favorite
                @click="toggleFavorite"
              >
                <AppIcon name="star" :size="14" :filled="book.favorite" />
              </button>
            </div>
            <p class="mt-1 text-[12.5px] text-dim" data-detail-author>{{ book.author ?? '佚名' }}</p>

            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
              <span data-detail-state>{{ stateText }}</span>
              <span class="uppercase tracking-wide">{{ book.format }}</span>
              <span>{{ book.chapterCount }} 章</span>
              <span v-if="book.offline" class="text-amber-400/90">目录离线</span>
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" class="ct-btn border-accent/40 text-accent hover:border-accent" data-detail-read @click="openReader">
                <AppIcon name="book" :size="14" />
                {{ book.readState === 'unread' ? '开始阅读' : '继续阅读' }}
              </button>
              <button type="button" class="ct-btn" data-detail-shelves @click="shelvesOpen = !shelvesOpen">
                <AppIcon name="folder" :size="14" />
                加入书架
              </button>
              <button type="button" class="ct-btn" data-detail-categories @click="openCategories">
                <AppIcon name="layers" :size="14" />
                设置分类
              </button>
            </div>
          </div>
        </section>

        <!-- 书架多选（勾选即生效） -->
        <section v-if="shelvesOpen" class="mt-4 rounded-lg border border-line bg-card p-3" data-detail-shelf-panel>
          <p class="mb-2 text-[11.5px] text-dim">加入或移出书架（同一本书可以放进多个书架）</p>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="shelf in library.shelves"
              :key="shelf.id"
              class="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink/90"
              :data-detail-shelf="shelf.id"
            >
              <input
                type="checkbox"
                :checked="inShelf(shelf.id)"
                class="h-3 w-3 accent-[var(--ct-accent,#5b8def)]"
                :data-detail-shelf-toggle="shelf.id"
                @change="toggleShelf(shelf.id, ($event.target as HTMLInputElement).checked)"
              />
              {{ shelf.name }}
            </label>
            <p v-if="library.shelves.length === 0" class="text-[11.5px] text-faint">还没有书架，先到「我的书架」建一个。</p>
          </div>
        </section>

        <!-- 分类 -->
        <section class="mt-6" data-detail-category-section>
          <h3 class="mb-2 text-[12px] text-dim">分类</h3>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="category in book.categories"
              :key="category.id"
              class="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-0.5 text-[11.5px] text-ink/90"
              :data-detail-category="category.id"
            >
              <span class="h-1.5 w-1.5 rounded-full" :style="{ background: category.color ?? '#8b8f98' }" />
              {{ category.name }}
            </span>
            <span v-if="book.categories.length === 0" class="text-[11.5px] text-faint" data-detail-no-category>
              还没有分类。分类是题材标签，可在「设置分类」里勾选。
            </span>
          </div>
        </section>

        <!-- 元信息（行内编辑） -->
        <section class="mt-6" data-detail-meta>
          <h3 class="mb-2 text-[12px] text-dim">元信息</h3>
          <dl class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            <div v-for="field in metaFields" :key="field.key" class="flex items-center gap-2 border-b border-line/60 py-1.5">
              <dt class="w-16 shrink-0 text-[11.5px] text-faint">{{ field.label }}</dt>
              <input
                v-if="editing === field.key"
                v-model="draft"
                type="text"
                class="min-w-0 flex-1 rounded border border-line-strong bg-app px-1.5 py-0.5 text-[12.5px] text-ink focus:outline-none"
                :data-detail-input="field.key"
                @blur="submitEdit"
                @keydown.enter.prevent="submitEdit"
                @keydown.esc.prevent="editing = null"
              />
              <button
                v-else
                type="button"
                class="min-w-0 flex-1 truncate text-left text-[12.5px] hover:text-accent"
                :class="field.value ? 'text-ink/90' : 'text-faint'"
                :title="`点击编辑${field.label}`"
                :data-detail-field="field.key"
                @click="startEdit(field)"
              >
                {{ field.value || field.placeholder }}
              </button>
            </div>
          </dl>
        </section>

        <!-- 简介 -->
        <section class="mt-6" data-detail-intro-section>
          <h3 class="mb-2 text-[12px] text-dim">简介</h3>
          <textarea
            v-if="introEditing"
            v-model="introDraft"
            rows="5"
            class="w-full rounded-lg border border-line-strong bg-app px-3 py-2 text-[12.5px] leading-relaxed text-ink focus:outline-none"
            data-detail-intro-input
            @blur="submitIntro"
          />
          <p
            v-else
            class="cursor-text whitespace-pre-wrap rounded-lg border border-transparent px-1 py-1 text-[12.5px] leading-relaxed hover:border-line"
            :class="book.intro ? 'text-ink/85' : 'text-faint'"
            data-detail-intro
            @click="((introEditing = true), (introDraft = book.intro ?? ''))"
          >
            {{ book.intro || '还没有简介，点击填写。' }}
          </p>
        </section>

        <!-- 章节 -->
        <section class="mt-6" data-detail-chapters>
          <div class="mb-2 flex items-center gap-2">
            <h3 class="text-[12px] text-dim">章节</h3>
            <span class="text-[11px] text-faint" data-detail-chapter-count>{{ chapters.length }} 章</span>
            <input
              v-model="chapterFilter"
              type="text"
              placeholder="筛选章节标题"
              class="ml-auto w-48 rounded-lg border border-line bg-elevated px-2.5 py-1 text-[11.5px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
              data-detail-chapter-filter
            />
          </div>

          <div
            class="relative overflow-y-auto rounded-lg border border-line bg-card"
            :style="{ height: `${CHAPTER_BOX}px` }"
            data-detail-chapter-box
            @scroll.passive="onChapterScroll"
          >
            <div :style="{ height: `${filteredChapters.length * CHAPTER_ROW}px`, position: 'relative' }">
              <button
                v-for="row in visibleChapters"
                :key="row.chapter.idx"
                type="button"
                class="absolute inset-x-0 flex items-center truncate px-3 text-left text-[12px] text-ink/85 hover:bg-hover hover:text-ink"
                :style="{ top: `${row.top}px`, height: `${CHAPTER_ROW}px` }"
                :data-detail-chapter="row.chapter.idx"
                @click="openChapter(row.chapter.idx)"
              >
                <span class="w-12 shrink-0 text-[10.5px] text-faint">{{ row.chapter.idx + 1 }}</span>
                <span class="truncate">{{ row.chapter.title }}</span>
              </button>
            </div>
            <p
              v-if="filteredChapters.length === 0"
              class="absolute inset-0 flex items-center justify-center text-[12px] text-faint"
            >
              没有匹配的章节
            </p>
          </div>
        </section>

        <!-- 书签与划线 -->
        <section class="mt-6" data-detail-bookmarks>
          <div class="mb-2 flex items-center gap-2">
            <h3 class="text-[12px] text-dim">书签与划线</h3>
            <span class="text-[11px] text-faint" data-detail-bookmark-count>{{ bookmarks.length }} 条</span>
          </div>
          <p v-if="bookmarks.length === 0" class="text-[11.5px] text-faint">还没有书签。阅读时选中文字即可划线，Ctrl+D 加书签。</p>
          <ul v-else class="space-y-1">
            <li v-for="bookmark in bookmarks" :key="bookmark.id">
              <button
                type="button"
                class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                :data-detail-bookmark="bookmark.id"
                @click="openBookmark(bookmark)"
              >
                <span
                  class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="bookmark.kind === 'highlight' ? 'bg-accent' : 'bg-amber-400'"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] text-ink/90">
                    {{ bookmark.text || bookmark.note || `第 ${bookmark.chapterIdx + 1} 章` }}
                  </span>
                  <span class="mt-0.5 block text-[10.5px] text-faint">
                    第 {{ bookmark.chapterIdx + 1 }} 章 · 偏移 {{ bookmark.offset }}
                    <template v-if="bookmark.note"> · 备注：{{ bookmark.note }}</template>
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </section>

        <!-- 来源 -->
        <section class="mt-6" data-detail-source>
          <h3 class="mb-2 text-[12px] text-dim">来源</h3>
          <dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-[11.5px] sm:grid-cols-2">
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">书库</dt>
              <dd class="min-w-0 flex-1 truncate text-ink/85" data-detail-root>
                {{ book.rootId ? book.rootId : '未归属（根目录已移除）' }}
              </dd>
            </div>
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">相对路径</dt>
              <dd class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink/85" data-detail-path>{{ book.relPath ?? '—' }}</dd>
            </div>
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">大小</dt>
              <dd class="flex-1 text-ink/85">{{ formatSize(book.sizeBytes) }}</dd>
            </div>
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">编码</dt>
              <dd class="flex-1 text-ink/85">{{ book.encoding ?? `—（${book.format.toUpperCase()} 自带编码）` }}</dd>
            </div>
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">字数</dt>
              <dd class="flex-1 text-ink/85">{{ book.wordCount?.toLocaleString() ?? '—' }}</dd>
            </div>
            <div class="flex gap-2 border-b border-line/60 py-1.5">
              <dt class="w-20 shrink-0 text-faint">导入时间</dt>
              <dd class="flex-1 text-ink/85">{{ formatDate(book.createdAt) }}</dd>
            </div>
          </dl>
        </section>
      </template>
    </div>

    <!-- 分类选择 -->
    <div
      v-if="categoriesOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
      data-detail-category-dialog
      @click.self="categoriesOpen = false"
    >
      <div class="w-full max-w-[380px] rounded-xl border border-line bg-elevated p-5">
        <p class="text-[13.5px] font-medium text-ink">设置分类</p>
        <p class="mt-1 text-[11.5px] text-faint">分类是题材标签，一本书可以同时属于多个。</p>
        <div class="mt-3 max-h-[240px] space-y-1 overflow-y-auto">
          <label
            v-for="category in library.categories"
            :key="category.id"
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            :data-detail-category-option="category.id"
          >
            <input
              type="checkbox"
              :value="category.id"
              v-model="categoryDraft"
              class="h-3.5 w-3.5 accent-[var(--ct-accent,#5b8def)]"
              :data-detail-category-toggle="category.id"
            />
            <span class="h-2 w-2 rounded-full" :style="{ background: category.color ?? '#8b8f98' }" />
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink/90">{{ category.name }}</span>
          </label>
          <p v-if="library.categories.length === 0" class="px-2 py-3 text-[11.5px] text-faint">
            还没有分类。到书库页的「分类 → 管理分类」里建一个。
          </p>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="ct-btn" data-detail-category-cancel @click="categoriesOpen = false">取消</button>
          <button type="button" class="ct-btn border-accent/40 text-accent" data-detail-category-ok @click="submitCategories">
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
