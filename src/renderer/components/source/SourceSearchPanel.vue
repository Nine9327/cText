<script setup lang="ts">
/**
 * 网络搜索面板（M4-09）。
 *
 * 嵌在「网络小说」页顶部：输入关键词 → 并发搜所有启用书源 → 按源分组展示 →
 * 每条结果可直接「加入书架」。产品文档 §2.9 的口径是「顶部搜索框在网络小说
 * 上下文下切换为搜索网络书籍」，所以它属于这一页，不单独开路由。
 *
 * 四条界面规则：
 *   1. **失败源单独列出**，但默认折叠。10 个源里挂 2 个是常态，展开一条条看原因
 *      会盖住真正有用的结果；而完全不说「有 2 个源没搜到」又会让用户以为书只有这些。
 *   2. **同名合并后仍能选源**。合并只合并展示，`alsoIn` 里每个源都有自己的
 *      `bookUrl`——加书架时必须选定一个，否则库里那条记录不知道该找谁要正文。
 *   3. **「加入书架」是唯一动作**，加入成功后按钮变成「已在书架」。搜索结果里
 *      再放一个「详情」会变成两次请求跳两页，而详情页在这一步就已经有了。
 *   4. **搜索中不允许重复提交**。一次搜索是 8 路并发抓取，连点三次就是三倍请求。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import { pushToast } from '@/lib/toast'
import { useLibraryStore } from '@/stores/library'
import { sourcesApi } from '@/api/sources'
import type { SourceSearchItemDTO, SourceSearchResultDTO } from '@shared/dto'

const emit = defineEmits<{ (event: 'active', value: boolean): void }>()

const router = useRouter()
const library = useLibraryStore()

const keyword = ref('')
const result = ref<SourceSearchResultDTO | null>(null)
const searching = ref(false)
const error = ref<string | null>(null)
const failuresOpen = ref(false)

/** 有输入之外的任何状态（搜索中 / 有结果 / 有错误）都算「接管了页面」 */
const active = computed(() => searching.value || result.value !== null || error.value !== null)

const total = computed(() => result.value?.groups.reduce((sum, group) => sum + group.items.length, 0) ?? 0)

function notify(): void {
  emit('active', active.value)
}

async function submit(): Promise<void> {
  const text = keyword.value.trim()
  if (text === '' || searching.value) return
  searching.value = true
  error.value = null
  result.value = null
  failuresOpen.value = false
  notify()
  try {
    result.value = await sourcesApi.search(text)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    searching.value = false
    notify()
  }
}

function clear(): void {
  keyword.value = ''
  result.value = null
  error.value = null
  failuresOpen.value = false
  notify()
}

// ---------------------------------------------------------------- 选源与加入书架

interface Candidate {
  sourceId: string
  sourceName: string
  bookUrl: string
}

const chosen = ref<Record<string, Candidate>>({})
const adding = ref<string | null>(null)
const added = ref<Record<string, string>>({})

function candidates(item: SourceSearchItemDTO): Candidate[] {
  return [
    { sourceId: item.sourceId, sourceName: item.sourceName, bookUrl: item.bookUrl },
    ...(item.alsoIn ?? [])
  ]
}

function current(item: SourceSearchItemDTO): Candidate {
  return chosen.value[item.bookUrl] ?? candidates(item)[0]
}

function pick(item: SourceSearchItemDTO, candidate: Candidate): void {
  chosen.value = { ...chosen.value, [item.bookUrl]: candidate }
}

async function addToShelf(item: SourceSearchItemDTO): Promise<void> {
  if (adding.value !== null) return
  const target = current(item)
  adding.value = item.bookUrl
  try {
    const outcome = await sourcesApi.addBook({
      sourceId: target.sourceId,
      bookUrl: target.bookUrl,
      title: item.title
    })
    added.value = { ...added.value, [item.bookUrl]: outcome.bookId }
    pushToast({
      level: 'info',
      message: outcome.reused
        ? `《${outcome.title}》已在书架，目录已更新（${outcome.chapterCount} 章）`
        : `已加入书架：《${outcome.title}》（${outcome.chapterCount} 章）`
    })
    library.refresh()
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '加入书架失败' })
  } finally {
    adding.value = null
  }
}

function openBook(item: SourceSearchItemDTO): void {
  const bookId = added.value[item.bookUrl]
  if (bookId) void router.push(`/book/${bookId}`)
}
</script>

<template>
  <div class="mb-3">
    <div class="flex items-center gap-2">
      <div class="relative flex-1">
        <span class="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
          <AppIcon name="search" :size="14" />
        </span>
        <input
          v-model="keyword"
          type="search"
          spellcheck="false"
          class="w-full rounded-md border border-line bg-app py-2 pl-8 pr-2.5 text-[12.5px] text-ink outline-none focus:border-line-strong"
          placeholder="搜索网络书籍（书名或作者），回车开始"
          data-source-search-input
          @keydown.enter.prevent="submit"
        />
      </div>
      <button
        type="button"
        class="ct-btn shrink-0"
        :disabled="searching || keyword.trim() === ''"
        data-source-search-submit
        @click="submit"
      >
        {{ searching ? '搜索中…' : '搜索' }}
      </button>
      <button v-if="active" type="button" class="ct-btn shrink-0" data-source-search-clear @click="clear">
        清除
      </button>
    </div>

    <!-- 搜索中 -->
    <p v-if="searching" class="mt-2 flex items-center gap-2 text-[11.5px] text-dim" data-source-search-loading>
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      正在并发搜索所有启用书源（单个源超时 8 秒）…
    </p>

    <p v-else-if="error" class="mt-2 text-[12px] text-rose-300" data-source-search-error>
      搜索失败：{{ error }}
    </p>

    <template v-else-if="result">
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
        <span data-source-search-summary>
          「{{ result.keyword }}」共 {{ total }} 条 · {{ result.groups.length }} 个源有结果 · {{ result.elapsedMs }}ms
        </span>
        <button
          v-if="result.failures.length > 0"
          type="button"
          class="text-amber-400/90 hover:text-amber-300"
          data-source-search-failures
          @click="failuresOpen = !failuresOpen"
        >
          {{ result.failures.length }} 个源未返回结果
          <span class="text-[10px]">{{ failuresOpen ? '收起' : '查看原因' }}</span>
        </button>
      </div>

      <ul v-if="failuresOpen" class="mt-1.5 space-y-1 rounded-md border border-line bg-elevated px-2.5 py-2" data-source-search-failure-list>
        <li v-for="failure in result.failures" :key="failure.sourceId" class="text-[11.5px] leading-relaxed text-dim">
          <span class="text-ink/85">{{ failure.sourceName }}</span>
          <span class="ml-1.5 rounded bg-app px-1 py-px font-mono text-[10px] text-faint">{{ failure.code }}</span>
          <span class="ml-1.5">{{ failure.message }}</span>
        </li>
      </ul>

      <p v-if="total === 0" class="mt-3 text-[12px] text-faint" data-source-search-empty>
        没有找到相关书籍。换个关键词，或者换一批书源再试。
      </p>

      <div v-else class="mt-3 space-y-3">
        <section v-for="group in result.groups" :key="group.sourceId" data-source-search-group>
          <h3 class="mb-1.5 flex items-center gap-2 text-[11.5px] text-dim">
            <span class="truncate">{{ group.sourceName }}</span>
            <span class="text-faint">{{ group.items.length }} 条 · {{ group.elapsedMs }}ms</span>
          </h3>
          <ul class="space-y-1.5">
            <li
              v-for="item in group.items"
              :key="`${item.sourceId}:${item.bookUrl}`"
              class="rounded-lg border border-line bg-card px-3 py-2"
              data-source-search-item
            >
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[13px] text-ink" data-source-search-title>{{ item.title }}</p>
                  <p class="mt-0.5 truncate text-[11.5px] text-faint">
                    {{ item.author ?? '佚名' }}
                    <template v-if="item.kind"> · {{ item.kind }}</template>
                    <template v-if="item.lastChapter"> · 最新：{{ item.lastChapter }}</template>
                  </p>
                  <p v-if="item.intro" class="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-dim">
                    {{ item.intro }}
                  </p>

                  <!-- 同名合并后可以换源：不同源的章节完整度差别很大 -->
                  <div v-if="(item.alsoIn?.length ?? 0) > 0" class="mt-1.5 flex flex-wrap items-center gap-1">
                    <span class="text-[10.5px] text-faint">来源</span>
                    <button
                      v-for="candidate in candidates(item)"
                      :key="candidate.sourceId"
                      type="button"
                      class="rounded border px-1.5 py-px text-[10.5px] transition-colors"
                      :class="current(item).sourceId === candidate.sourceId
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-line text-dim hover:border-line-strong hover:text-ink'"
                      data-source-search-candidate
                      @click="pick(item, candidate)"
                    >
                      {{ candidate.sourceName }}
                    </button>
                  </div>
                </div>

                <button
                  v-if="added[item.bookUrl]"
                  type="button"
                  class="ct-btn shrink-0 border-accent/40 text-accent"
                  data-source-search-open
                  @click="openBook(item)"
                >
                  <AppIcon name="check" :size="13" />
                  已在书架
                </button>
                <button
                  v-else
                  type="button"
                  class="ct-btn shrink-0"
                  :disabled="adding !== null"
                  data-source-search-add
                  @click="addToShelf(item)"
                >
                  {{ adding === item.bookUrl ? '抓取目录…' : '加入书架' }}
                </button>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
