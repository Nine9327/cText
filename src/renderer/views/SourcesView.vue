<script setup lang="ts">
/**
 * 网络小说 / 书源（/sources、/sources/:sourceId）。
 *
 * M4-07 把 M0-08 的 fixture 壳换成了真实数据：导入（文件 / 粘贴 / URL 直链）、
 * 逐条结果清单、启停、拖动排序、删除、导出。M4-09 补上搜索面板与「加入书架」，
 * M4-10 补缓存卡，M4-11 补单个书源页的「规则调试」（只读跑一遍四段链路）。
 *
 * 三条界面规则，都是踩过的：
 *   1. **导入结果必须逐条列出**。批量导入 100 条时，「成功 94 / 失败 6」不够用——
 *      用户要知道是哪 6 条、为什么。所以结果面板是可滚动的明细表，不是一个 toast。
 *   2. **兼容级别用词固定**（完整支持 / 部分支持 / 不支持）。级别由主进程判定，
 *      界面只负责展示，不自己算——两处各算一遍迟早会不一致。
 *   3. **合规提示只弹一次并落库**（产品文档 §2.7）。它不是免责声明，是功能边界说明：
 *      不内置、不分发、规则由用户自备。落库后在设置里能看到已确认状态。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SourceSearchPanel from '@/components/source/SourceSearchPanel.vue'
import SourceDebugPanel from '@/components/source/SourceDebugPanel.vue'
import { pushToast } from '@/lib/toast'
import { formatSize } from '@/lib/format'
import { call } from '@/api/client'
import { sourcesApi } from '@/api/sources'
import type { CompatLevel, SourceCacheStatsDTO, SourceDTO, SourceImportResultDTO } from '@shared/dto'

const route = useRoute()
const router = useRouter()

const sources = ref<SourceDTO[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

const sourceId = computed(() => route.params.sourceId as string | undefined)
const current = computed(() => sources.value.find((source) => source.id === sourceId.value) ?? null)
const enabledCount = computed(() => sources.value.filter((source) => source.enabled).length)
/** 搜索面板接管页面时收起书源清单（见模板注释） */
const searchActive = ref(false)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function reload(): Promise<void> {
  loading.value = true
  try {
    sources.value = await sourcesApi.list()
    loadError.value = null
  } catch (err) {
    loadError.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await reload()
  void loadCache()
  try {
    const settings = await call('settings:get')
    complianceAccepted.value = settings.sources.complianceAccepted
  } catch {
    // 设置读不到不该挡住书源页；最坏结果是合规提示多弹一次
  }
})

// ---------------------------------------------------------------- 合规确认

const complianceAccepted = ref(false)
const complianceOpen = ref(false)
/** 合规确认通过后要接着做的事（打开导入面板）；用户取消就丢掉 */
let afterCompliance: (() => void) | null = null

function requestImport(): void {
  if (complianceAccepted.value) {
    openImport()
    return
  }
  afterCompliance = openImport
  complianceOpen.value = true
}

async function acceptCompliance(): Promise<void> {
  complianceOpen.value = false
  complianceAccepted.value = true
  // 落库失败不阻断：这只是「别再弹」的偏好，不是权限。下次启动会再弹一次
  void call('settings:patch', { patch: { sources: { complianceAccepted: true } } }).catch(() => undefined)
  const next = afterCompliance
  afterCompliance = null
  next?.()
}

function cancelCompliance(): void {
  complianceOpen.value = false
  afterCompliance = null
}

// ---------------------------------------------------------------- 导入

type ImportMode = 'file' | 'paste' | 'url'

/** 模板里不能写 `as` 断言（编译器不认），选项表放这儿 */
const IMPORT_TABS: ReadonlyArray<{ key: ImportMode; label: string }> = [
  { key: 'file', label: '选文件' },
  { key: 'paste', label: '粘贴 JSON' },
  { key: 'url', label: 'URL 直链' }
]

const importOpen = ref(false)
const mode = ref<ImportMode>('file')
const pasteText = ref('')
const urlValue = ref('')
const busy = ref(false)
const result = ref<SourceImportResultDTO | null>(null)

const canSubmit = computed(() => {
  if (busy.value) return false
  if (mode.value === 'paste') return pasteText.value.trim() !== ''
  if (mode.value === 'url') return /^https?:\/\//i.test(urlValue.value.trim())
  return true
})

function openImport(): void {
  result.value = null
  importOpen.value = true
}

function closeImport(): void {
  if (busy.value) return
  importOpen.value = false
}

async function finishImport(dto: SourceImportResultDTO): Promise<void> {
  result.value = dto
  await reload()
  const changed = dto.imported + dto.updated
  if (changed > 0) {
    pushToast({ level: 'info', message: `已写入 ${changed} 个书源（新增 ${dto.imported}，更新 ${dto.updated}）` })
  }
}

async function submitPaste(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  try {
    await finishImport(await sourcesApi.importText(pasteText.value))
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

async function submitFile(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const picked = await sourcesApi.pickFile()
    if (!picked) return
    await finishImport(await sourcesApi.importFile(picked.path))
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

async function submitUrl(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  try {
    await finishImport(await sourcesApi.importUrl(urlValue.value.trim()))
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------- 启停 / 删除 / 排序 / 导出

async function toggle(source: SourceDTO): Promise<void> {
  const next = !source.enabled
  source.enabled = next // 乐观更新：开关必须先跟手，失败再回滚
  try {
    await sourcesApi.toggle(source.id, next)
  } catch (err) {
    source.enabled = !next
    pushToast({ level: 'error', message: messageOf(err) })
  }
}

/**
 * 手动恢复熔断（M4-12）。
 *
 * 不做乐观更新：恢复后状态里的 `breakerNote` 由主进程按当前时间重算，
 * 本地拼一个「已恢复」再被后端覆盖只会闪一下。
 */
async function resetBreaker(source: SourceDTO): Promise<void> {
  try {
    const next = await sourcesApi.resetBreaker(source.id)
    source.failStreak = next.failStreak
    source.breakerNote = next.breakerNote
    pushToast({ level: 'info', message: `已恢复书源「${source.name}」，可重新搜索` })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}

const pendingRemove = ref<SourceDTO | null>(null)

async function confirmRemove(): Promise<void> {
  const target = pendingRemove.value
  pendingRemove.value = null
  if (!target) return
  try {
    await sourcesApi.remove(target.id)
    if (sourceId.value === target.id) void router.push('/sources')
    await reload()
    pushToast({ level: 'info', message: `已删除书源「${target.name}」` })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}

const dragId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

function onDragStart(source: SourceDTO): void {
  dragId.value = source.id
}

function onDragOver(source: SourceDTO): void {
  if (dragId.value === null || dragId.value === source.id) return
  dragOverId.value = source.id
}

async function onDrop(target: SourceDTO): Promise<void> {
  const from = dragId.value
  dragId.value = null
  dragOverId.value = null
  if (from === null || from === target.id) return

  const list = [...sources.value]
  const fromIndex = list.findIndex((s) => s.id === from)
  const toIndex = list.findIndex((s) => s.id === target.id)
  if (fromIndex < 0 || toIndex < 0) return

  const [moved] = list.splice(fromIndex, 1)
  if (!moved) return
  list.splice(toIndex, 0, moved)
  sources.value = list

  try {
    await sourcesApi.reorder(list.map((s) => s.id))
  } catch (err) {
    // 顺序没存上就把列表拉回真实顺序，别让界面显示一个不存在的排序
    pushToast({ level: 'error', message: messageOf(err) })
    await reload()
  }
}

function onDragEnd(): void {
  dragId.value = null
  dragOverId.value = null
}

const exporting = ref(false)

async function exportAll(): Promise<void> {
  if (exporting.value || sources.value.length === 0) return
  exporting.value = true
  try {
    const saved = await sourcesApi.exportTo()
    if (saved) pushToast({ level: 'info', message: `已导出 ${saved.count} 个书源` })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    exporting.value = false
  }
}

// ---------------------------------------------------------------- 展示辅助

const COMPAT_LABEL: Record<CompatLevel, string> = {
  full: '完整支持',
  partial: '部分支持',
  unsupported: '不支持'
}

const COMPAT_CLASS: Record<CompatLevel, string> = {
  full: 'border-emerald-500/30 text-emerald-300/90',
  partial: 'border-amber-500/30 text-amber-300/90',
  unsupported: 'border-rose-500/30 text-rose-300/90'
}

const STATUS_LABEL: Record<string, string> = {
  imported: '新增',
  updated: '更新',
  skipped: '跳过',
  failed: '失败'
}

const STATUS_CLASS: Record<string, string> = {
  imported: 'text-emerald-300',
  updated: 'text-sky-300',
  skipped: 'text-faint',
  failed: 'text-rose-300'
}

/** 结果清单里默认只看有问题的条目；全成功时展开也没意义 */
const resultHasProblem = computed(() => (result.value?.failed ?? 0) > 0 || (result.value?.skipped ?? 0) > 0)

const resultSummary = computed(() => {
  const r = result.value
  if (!r) return ''
  const parts = [`新增 ${r.imported}`, `更新 ${r.updated}`, `跳过 ${r.skipped}`]
  if (r.failed > 0) parts.push(`失败 ${r.failed}`)
  return parts.join(' · ')
})

watch(importOpen, (open) => {
  if (!open) {
    pasteText.value = ''
    urlValue.value = ''
    result.value = null
    busy.value = false
  }
})

function goDetail(source: SourceDTO): void {
  void router.push(`/sources/${source.id}`)
}

// ---------------------------------------------------------------- 规则调试（M4-11）

const debugOpen = ref(false)

/** 换书源就收起面板：上一个源的调试结果留在屏幕上会被当成本次的 */
watch(sourceId, () => {
  debugOpen.value = false
})

// ---------------------------------------------------------------- 缓存（M4-10）

const cacheStats = ref<SourceCacheStatsDTO | null>(null)
const cacheClearing = ref(false)
const cacheConfirmOpen = ref(false)

const cacheSummary = computed(() => {
  const s = cacheStats.value
  if (!s) return '统计不可用'
  if (s.files === 0) return `暂无缓存 · 保留 ${s.ttlDays} 天`
  return `${formatSize(s.bytes)} · ${s.files} 章 · ${s.totalBooks} 本书 · 保留 ${s.ttlDays} 天`
})

/** 过期部分单独说一句：它是「联网时重抓」，不是「已经没用」——断网还能读 */
const cacheExpired = computed(() => {
  const s = cacheStats.value
  if (!s || s.expiredFiles === 0) return ''
  return `其中 ${formatSize(s.expiredBytes)} 已过期（联网时重抓，断网仍可读）`
})

const cacheEmpty = computed(() => (cacheStats.value?.files ?? 0) === 0)

async function loadCache(): Promise<void> {
  try {
    cacheStats.value = await sourcesApi.cacheStats()
  } catch {
    // 统计失败不该挡住书源管理：卡片显示「统计不可用」，其它功能照常
    cacheStats.value = null
  }
}

async function clearCache(): Promise<void> {
  cacheConfirmOpen.value = false
  cacheClearing.value = true
  try {
    const result = await sourcesApi.clearCache()
    pushToast({
      level: 'info',
      message:
        result.files === 0
          ? '缓存已经是空的'
          : `已清理 ${formatSize(result.bytes)}（${result.files} 个章节文件）`
    })
    await loadCache()
  } catch (err) {
    pushToast({ level: 'error', message: `清理失败：${messageOf(err)}` })
  } finally {
    cacheClearing.value = false
  }
}

async function openCacheDir(): Promise<void> {
  try {
    await sourcesApi.openCacheDir()
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <div class="flex h-14 shrink-0 items-center gap-3 px-6">
      <button
        v-if="current"
        type="button"
        class="ct-icon-btn -ml-1"
        title="返回书源列表"
        data-source-back
        @click="router.push('/sources')"
      >
        <AppIcon name="chevron-left" :size="15" />
      </button>
      <h1 class="truncate text-[15px] font-medium text-ink">
        {{ current ? current.name : '网络小说' }}
      </h1>
      <span v-if="!current" class="text-[11.5px] text-faint">
        {{ sources.length }} 个书源<template v-if="sources.length > 0">（{{ enabledCount }} 个启用）</template>
      </span>

      <button
        v-if="sources.length > 0 && !current"
        type="button"
        class="ct-btn ml-auto"
        :disabled="exporting"
        data-source-export
        @click="exportAll"
      >
        <AppIcon name="download" :size="14" />
        导出
      </button>
      <button
        type="button"
        class="ct-btn"
        :class="sources.length === 0 || current ? 'ml-auto' : ''"
        data-source-import
        @click="requestImport"
      >
        <AppIcon name="import" :size="14" />
        导入书源
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <!-- 详情：单个书源 -->
      <div v-if="current" class="max-w-[620px] space-y-3" data-source-detail>
        <div class="rounded-lg border border-line bg-card p-4">
          <div class="flex items-start gap-3">
            <span
              class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
              :class="current.enabled ? 'bg-emerald-500/80' : 'bg-faint/50'"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13.5px] text-ink">{{ current.name }}</p>
              <p class="mt-0.5 truncate text-[11.5px] text-faint">{{ current.url }}</p>
            </div>
            <span
              class="shrink-0 rounded border px-1.5 py-px text-[10.5px]"
              :class="COMPAT_CLASS[current.compatLevel]"
            >
              {{ COMPAT_LABEL[current.compatLevel] }}
            </span>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
            <div>
              <dt class="text-faint">分组</dt>
              <dd class="mt-0.5 text-dim">{{ current.group ?? '未分组' }}</dd>
            </div>
            <div>
              <dt class="text-faint">状态</dt>
              <dd class="mt-0.5 text-dim">{{ current.enabled ? '已启用' : '已停用' }}</dd>
            </div>
            <div v-if="current.breakerNote">
              <dt class="text-faint">运行状态</dt>
              <dd class="mt-0.5 text-amber-300/90" data-source-breaker-note>{{ current.breakerNote }}</dd>
            </div>
            <div>
              <dt class="text-faint">最近使用</dt>
              <dd class="mt-0.5 text-dim">
                {{ current.lastUsedAt ? new Date(current.lastUsedAt).toLocaleString('zh-CN') : '从未使用' }}
              </dd>
            </div>
            <div>
              <dt class="text-faint">导入时间</dt>
              <dd class="mt-0.5 text-dim">{{ new Date(current.createdAt).toLocaleString('zh-CN') }}</dd>
            </div>
          </dl>

          <p
            v-if="current.compatNote"
            class="mt-3 rounded-md border border-line bg-elevated px-2.5 py-2 text-[11.5px] leading-relaxed text-dim"
            data-source-compat-note
          >
            {{ current.compatNote }}
          </p>

          <div class="mt-4 flex gap-2">
            <button type="button" class="ct-btn" data-source-toggle @click="toggle(current)">
              {{ current.enabled ? '停用' : '启用' }}
            </button>
            <button
              v-if="current.breakerNote"
              type="button"
              class="ct-btn border-amber-500/30 text-amber-300/90 hover:border-amber-400/60"
              data-source-breaker-reset
              @click="resetBreaker(current)"
            >
              恢复
            </button>
            <button type="button" class="ct-btn" data-source-debug-open @click="debugOpen = !debugOpen">
              {{ debugOpen ? '收起调试' : '规则调试' }}
            </button>
            <button
              type="button"
              class="ct-btn border-rose-500/30 text-rose-300/90 hover:border-rose-400/60 hover:text-rose-200"
              data-source-remove
              @click="pendingRemove = current"
            >
              <AppIcon name="trash" :size="14" />
              删除
            </button>
          </div>
        </div>

        <SourceDebugPanel v-if="debugOpen" :source-id="current.id" />

        <p class="text-[11.5px] leading-relaxed text-faint">
          搜索在列表页顶部直接可用；「规则调试」用这个源真跑一遍四段链路，定位某个字段为什么取不到。
        </p>
      </div>

      <!-- 列表 -->
      <template v-else>
        <p v-if="loadError" class="text-[12px] text-rose-300">读取失败：{{ loadError }}</p>

        <!--
          正文缓存（M4-10）。只放「用了多少 + 两个动作」，明细交给文件管理器：
          在设置页把缓存做成一张可排序的表格，对 99% 的用户是噪音。
        -->
        <div
          v-if="!loading && !searchActive"
          class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-card px-3 py-2"
          data-source-cache
        >
          <AppIcon name="download" :size="13" class="shrink-0 text-dim" />
          <span class="text-[12px] text-ink/80">正文缓存</span>
          <span class="text-[11.5px] text-faint" data-source-cache-size>{{ cacheSummary }}</span>
          <span v-if="cacheExpired" class="text-[11px] text-amber-300/80" data-source-cache-expired>
            {{ cacheExpired }}
          </span>
          <div class="ml-auto flex items-center gap-1.5">
            <button type="button" class="ct-btn" data-source-cache-open @click="openCacheDir">
              <AppIcon name="folder" :size="13" />
              打开目录
            </button>
            <button
              type="button"
              class="ct-btn"
              :disabled="cacheClearing || cacheEmpty"
              data-source-cache-clear
              @click="cacheConfirmOpen = true"
            >
              <AppIcon name="trash" :size="13" />
              {{ cacheClearing ? '清理中…' : '清理' }}
            </button>
          </div>
        </div>

        <!-- 搜索接管页面时不显示书源清单：结果很长，两段列表叠在一起会互相抢注意力 -->
        <SourceSearchPanel
          v-if="!loading && enabledCount > 0"
          @active="searchActive = $event"
        />

        <div v-if="!loading && sources.length > 0 && !searchActive" class="space-y-2">
          <div
            v-for="source in sources"
            :key="source.id"
            class="group flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 transition-colors duration-120 hover:border-line-strong hover:bg-hover"
            :class="[dragOverId === source.id ? 'border-accent/50' : '', dragId === source.id ? 'opacity-40' : '']"
            data-source-row
            draggable="true"
            @dragstart="onDragStart(source)"
            @dragover.prevent="onDragOver(source)"
            @drop.prevent="onDrop(source)"
            @dragend="onDragEnd"
          >
            <span class="cursor-grab text-dim/70 transition-colors hover:text-ink active:cursor-grabbing" title="拖动排序">
              <AppIcon name="drag" :size="13" />
            </span>
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="source.enabled ? 'bg-emerald-500/80' : 'bg-faint/50'"
            />
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left text-[13px] text-ink/90 hover:text-ink"
              data-source-open
              @click="goDetail(source)"
            >
              {{ source.name }}
            </button>
            <span class="hidden shrink-0 rounded border border-line px-1.5 py-px text-[10.5px] text-faint sm:inline">
              {{ source.group ?? '未分组' }}
            </span>
            <span
              class="shrink-0 rounded border px-1.5 py-px text-[10.5px]"
              :class="COMPAT_CLASS[source.compatLevel]"
              :title="source.compatNote ?? ''"
            >
              {{ COMPAT_LABEL[source.compatLevel] }}
            </span>
            <button
              v-if="source.breakerNote"
              type="button"
              class="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10.5px] text-amber-300/90 hover:border-amber-400/70"
              :title="`${source.breakerNote}（点击恢复）`"
              data-source-breaker
              @click="resetBreaker(source)"
            >
              熔断
            </button>

            <button
              type="button"
              class="relative h-4 w-7 shrink-0 rounded-full transition-colors duration-120"
              :class="source.enabled ? 'bg-emerald-500/70' : 'bg-line-strong'"
              :title="source.enabled ? '停用' : '启用'"
              :aria-checked="source.enabled"
              role="switch"
              data-source-switch
              @click="toggle(source)"
            >
              <span
                class="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all duration-120"
                :class="source.enabled ? 'left-3.5' : 'left-0.5'"
              />
            </button>

            <button
              type="button"
              class="ct-icon-btn shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-300"
              title="删除书源"
              data-source-delete
              @click="pendingRemove = source"
            >
              <AppIcon name="trash" :size="13" />
            </button>
          </div>

          <p class="pt-2 text-[11.5px] leading-relaxed text-faint">
            拖动左侧把手可调整顺序（搜索按这个顺序发起）。启停只影响是否参与搜索，不会删除规则。
          </p>
        </div>

        <EmptyState
          v-else-if="!loading && sources.length === 0"
          icon="globe"
          title="还没有导入书源"
          desc="cText 不内置、不分发任何书源；书源规则由你自行提供，格式对齐「阅读 3.0」的 JSON。"
        >
          <button type="button" class="ct-btn" data-source-import-empty @click="requestImport">
            <AppIcon name="import" :size="14" />
            导入书源
          </button>
        </EmptyState>

        <p v-else-if="loading" class="text-[12px] text-faint">正在读取书源…</p>

        <p class="mt-6 max-w-[560px] text-[11.5px] leading-relaxed text-faint">
          支持三种导入方式：选 <code class="text-dim">.json</code> 文件、粘贴 JSON、填 JSON 直链。
          导入时逐条校验并给出结果清单；规则预编译不通过的书源会标「部分支持」但**仍会保留**。
        </p>
      </template>
    </div>

    <!-- 合规确认（首次导入） -->
    <div
      v-if="complianceOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
      data-compliance-dialog
    >
      <div class="w-full max-w-[440px] rounded-xl border border-line bg-elevated p-5 shadow-2xl">
        <p class="text-[13.5px] font-medium text-ink">开始使用网络书源</p>
        <ul class="mt-3 space-y-2 text-[12px] leading-relaxed text-dim">
          <li>· cText <span class="text-ink">不内置、不分发</span>任何书源，也不提供书源下载或订阅。</li>
          <li>· 书源规则由你自行提供，仅供个人合法获取可公开访问的内容。</li>
          <li>· 请求会附带书源自带的 UA，并受全局限速（单域名 ≤ 1 次/秒）约束。</li>
          <li>· 需要登录、付费或绕过访问限制的内容，本应用不做任何技术兜底。</li>
        </ul>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="ct-btn" data-compliance-cancel @click="cancelCompliance">取消</button>
          <button
            type="button"
            class="ct-btn border-accent/40 text-accent"
            data-compliance-ok
            @click="acceptCompliance"
          >
            我已了解，继续
          </button>
        </div>
      </div>
    </div>

    <!-- 导入对话框 -->
    <div
      v-if="importOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
      data-import-dialog
      @click.self="closeImport"
    >
      <div class="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-xl border border-line bg-elevated shadow-2xl">
        <div class="flex items-center gap-3 border-b border-line px-4 py-3">
          <p class="text-[13.5px] font-medium text-ink">导入书源</p>
          <button type="button" class="ct-icon-btn ml-auto" :disabled="busy" @click="closeImport">
            <AppIcon name="close" :size="14" />
          </button>
        </div>

        <!-- 结果清单 -->
        <div v-if="result" class="flex min-h-0 flex-1 flex-col">
          <div class="px-4 py-3">
            <p class="text-[12.5px] text-ink" data-import-summary>{{ resultSummary }}</p>
            <p v-if="!resultHasProblem" class="mt-1 text-[11.5px] text-faint">全部条目都已处理完成。</p>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto border-t border-line">
            <div
              v-for="(item, index) in result.items"
              :key="index"
              class="flex items-start gap-2 border-b border-line/60 px-4 py-2 last:border-b-0"
              data-import-item
            >
              <span class="w-9 shrink-0 text-[11px]" :class="STATUS_CLASS[item.status]">
                {{ STATUS_LABEL[item.status] }}
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[12px] text-ink/90">{{ item.name ?? '(无名称)' }}</p>
                <p class="truncate text-[11px] text-faint">{{ item.url ?? '—' }}</p>
                <p v-if="item.reason" class="mt-0.5 text-[11px] leading-relaxed text-dim">{{ item.reason }}</p>
              </div>
              <span
                v-if="item.compatLevel"
                class="shrink-0 rounded border px-1.5 py-px text-[10px]"
                :class="COMPAT_CLASS[item.compatLevel]"
              >
                {{ COMPAT_LABEL[item.compatLevel] }}
              </span>
            </div>
          </div>
          <div class="flex justify-end gap-2 border-t border-line px-4 py-3">
            <button type="button" class="ct-btn" data-import-again @click="result = null">再导入一批</button>
            <button type="button" class="ct-btn border-accent/40 text-accent" data-import-done @click="closeImport">
              完成
            </button>
          </div>
        </div>

        <!-- 三种来源 -->
        <template v-else>
          <div class="flex gap-1 border-b border-line px-4 py-2">
            <button
              v-for="tab in IMPORT_TABS"
              :key="tab.key"
              type="button"
              class="rounded-md px-2.5 py-1 text-[12px] transition-colors duration-120"
              :class="mode === tab.key ? 'bg-active text-ink' : 'text-dim hover:bg-hover hover:text-ink'"
              :data-import-tab="tab.key"
              @click="mode = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>

          <div class="px-4 py-4">
            <template v-if="mode === 'file'">
              <p class="text-[12px] leading-relaxed text-dim">
                选择「阅读 3.0 → 书源管理 → 导出」得到的 <code>.json</code> 文件，可以是单个书源对象或数组。
              </p>
              <button type="button" class="ct-btn mt-3" :disabled="busy" data-import-file @click="submitFile">
                <AppIcon name="folder" :size="14" />
                {{ busy ? '读取中…' : '选择文件' }}
              </button>
            </template>

            <template v-else-if="mode === 'paste'">
              <textarea
                v-model="pasteText"
                rows="9"
                spellcheck="false"
                class="w-full resize-none rounded-md border border-line bg-app px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink outline-none focus:border-line-strong"
                placeholder='[{ "bookSourceUrl": "https://…", "bookSourceName": "…", "ruleSearch": { … } }]'
                data-import-textarea
              />
              <p class="mt-1.5 text-[11px] text-faint">单条 JSON、数组都行；上限 5MB。</p>
            </template>

            <template v-else>
              <input
                v-model="urlValue"
                type="url"
                spellcheck="false"
                class="w-full rounded-md border border-line bg-app px-2.5 py-2 text-[12px] text-ink outline-none focus:border-line-strong"
                placeholder="https://example.com/sources.json"
                data-import-url
              />
              <p class="mt-1.5 text-[11px] leading-relaxed text-faint">
                只接受 <code>http(s)</code> 的 JSON / 纯文本直链；返回网页的地址会被拒绝。
                不做订阅同步——要更新就再导入一次。指向内网或本机的地址同样会被拒绝。
              </p>
            </template>
          </div>

          <div class="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
            <span v-if="busy" class="mr-auto text-[11.5px] text-faint">正在处理…</span>
            <button type="button" class="ct-btn" :disabled="busy" @click="closeImport">取消</button>
            <button
              v-if="mode !== 'file'"
              type="button"
              class="ct-btn border-accent/40 text-accent"
              :disabled="!canSubmit"
              data-import-submit
              @click="mode === 'paste' ? submitPaste() : submitUrl()"
            >
              导入
            </button>
          </div>
        </template>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingRemove !== null"
      title="删除这个书源？"
      :desc="`将从列表移除「${pendingRemove?.name ?? ''}」的规则。已加入书架的书籍会保留，但无法再刷新目录与正文。`"
      confirm-text="删除书源"
      danger
      @confirm="confirmRemove"
      @cancel="pendingRemove = null"
    />

    <!--
      清理缓存必须二次确认，而且要说清「不会删什么」——用户怕的不是点错按钮，
      而是不知道点完之后书架会不会空（产品文档 §2.5 对删除类操作的要求）。
    -->
    <ConfirmDialog
      :open="cacheConfirmOpen"
      title="清理正文缓存？"
      :desc="`将删除已下载的 ${cacheStats?.files ?? 0} 个章节文件（${formatSize(cacheStats?.bytes ?? 0)}）。书架、目录与阅读进度都会保留；已读章节下次打开时需要重新联网抓取。`"
      confirm-text="清理缓存"
      danger
      @confirm="clearCache"
      @cancel="cacheConfirmOpen = false"
    />
  </div>
</template>
