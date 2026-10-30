<script setup lang="ts">
/**
 * 规则调试面板（M4-11，产品文档 §2.7 的「最小形态」）。
 *
 * 填一个地址（可选关键词 / 章节地址）→ 四段依次真跑一遍 → 逐段展开
 * 「请求 / 规则 → 结果 / 耗时 / 错误」。**只读**：不写书架、目录与缓存，
 * 也不提供「在面板里改规则」——那是另一件需要版本与回滚的事。
 *
 * 四条界面规则：
 *   1. **失败段默认展开、成功段默认收起**。面板 90% 的用途是查「为什么没取到」，
 *      把四段几万字的成功轨迹全摊开会把失败那段挤到看不见。
 *   2. **请求和规则分开上色**。用户要区分「站点没给」（请求 403 / 空）与「规则没取到」
 *      （200 但 values 为空），这两件事的修法完全相反。
 *   3. **每段可复制**。复制的是纯文本（规则原文 + 结果），贴到 issue 或论坛里能直接看，
 *      截图没法搜。
 *   4. **地址留空不算错**。没填关键词就跳过搜索段，段里写明「未填关键词」，
 *      而不是报一个看不懂的错。
 */
import { computed, ref, watch } from 'vue'
import { pushToast } from '@/lib/toast'
import { sourcesApi } from '@/api/sources'
import type { SourceDebugPhase, SourceDebugResultDTO, SourceDebugSectionDTO } from '@shared/dto'

const props = defineProps<{ sourceId: string }>()

const PHASES: ReadonlyArray<{ key: SourceDebugPhase; label: string; hint: string }> = [
  { key: 'search', label: '搜索', hint: '需要关键词' },
  { key: 'info', label: '详情', hint: '需要详情页地址' },
  { key: 'toc', label: '目录', hint: '需要目录页地址' },
  { key: 'content', label: '正文', hint: '取目录第一章，或直接填章节地址' }
]

const url = ref('')
const keyword = ref('')
const chapterUrl = ref('')
const selected = ref<SourceDebugPhase[]>(PHASES.map((phase) => phase.key))

const running = ref(false)
const result = ref<SourceDebugResultDTO | null>(null)
const error = ref<string | null>(null)
const openPhases = ref<SourceDebugPhase[]>([])

const canRun = computed(() => !running.value && selected.value.length > 0)

function togglePhase(key: SourceDebugPhase): void {
  selected.value = selected.value.includes(key)
    ? selected.value.filter((phase) => phase !== key)
    : [...selected.value, key]
}

async function run(): Promise<void> {
  if (!canRun.value) return
  running.value = true
  error.value = null
  result.value = null
  try {
    const outcome = await sourcesApi.debug({
      sourceId: props.sourceId,
      ...(url.value.trim() === '' ? {} : { url: url.value.trim() }),
      ...(keyword.value.trim() === '' ? {} : { keyword: keyword.value.trim() }),
      ...(chapterUrl.value.trim() === '' ? {} : { chapterUrl: chapterUrl.value.trim() }),
      // `phases` 必须展开成普通数组：reactive 的 Proxy 过不了 IPC 的结构化克隆，
      // 报的还是一句不知所云的「An object could not be cloned」
      phases: [...selected.value]
    })
    result.value = outcome
    // 失败与跳过段直接摊开：这正是用户点「开始调试」想知道的东西
    openPhases.value = outcome.sections.filter((section) => !section.ok).map((section) => section.phase)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    running.value = false
  }
}

/** 换书源就清空：上一个源的结果留着会让人以为是新的 */
watch(
  () => props.sourceId,
  () => {
    result.value = null
    error.value = null
    openPhases.value = []
  }
)

const PHASE_LABEL: Record<SourceDebugPhase, string> = {
  search: '搜索',
  info: '详情',
  toc: '目录',
  content: '正文'
}

function isOpen(section: SourceDebugSectionDTO): boolean {
  return openPhases.value.includes(section.phase)
}

function toggleSection(section: SourceDebugSectionDTO): void {
  openPhases.value = isOpen(section)
    ? openPhases.value.filter((phase) => phase !== section.phase)
    : [...openPhases.value, section.phase]
}

function statusLabel(section: SourceDebugSectionDTO): string {
  if (section.skipped) return '跳过'
  return section.ok ? '成功' : '失败'
}

function statusClass(section: SourceDebugSectionDTO): string {
  if (section.skipped) return 'border-line text-faint'
  return section.ok ? 'border-emerald-500/30 text-emerald-300/90' : 'border-rose-500/30 text-rose-300/90'
}

/** 复制成纯文本：规则原文 + 实际地址 + 结果，贴到 issue 里能直接搜 */
function sectionText(section: SourceDebugSectionDTO): string {
  const lines = [`【${PHASE_LABEL[section.phase]}】${section.summary}（${section.elapsedMs}ms）`]
  if (section.error) lines.push(`错误：${section.error}`)
  for (const step of section.steps) {
    lines.push('', `— ${step.label}${step.elapsedMs ? ` · ${step.elapsedMs}ms` : ''}`)
    if (step.rule !== null) lines.push(`规则：${step.rule}`)
    if (step.url !== null) lines.push(`地址：${step.url}`)
    if (step.status !== null) lines.push(`状态：HTTP ${step.status}`)
    if (step.error !== null) lines.push(`错误：${step.error}`)
    if (step.values.length > 0) lines.push(`结果：${step.values.join(' ｜ ')}`)
    if (step.snippet !== null) lines.push(`响应：${step.snippet.slice(0, 500)}`)
  }
  return lines.join('\n')
}

async function copySection(section: SourceDebugSectionDTO): Promise<void> {
  try {
    await navigator.clipboard.writeText(sectionText(section))
    pushToast({ level: 'info', message: `已复制「${PHASE_LABEL[section.phase]}」段的调试结果` })
  } catch {
    pushToast({ level: 'error', message: '复制失败，可以手动选中文本' })
  }
}
</script>

<template>
  <div class="rounded-lg border border-line bg-card p-4" data-source-debug>
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-[13px] text-ink">规则调试</p>
        <p class="mt-0.5 text-[11.5px] leading-relaxed text-faint">
          用这个源的规则真跑一遍，逐段给出请求、规则原文与提取结果。只读：不会改动书架、目录与缓存。
        </p>
      </div>
      <button type="button" class="ct-btn shrink-0" :disabled="!canRun" data-source-debug-submit @click="run">
        {{ running ? '调试中…' : '开始调试' }}
      </button>
    </div>

    <div class="mt-3 space-y-2">
      <label class="block">
        <span class="text-[11px] text-faint">详情页地址（只跑目录时可填目录页）</span>
        <input
          v-model="url"
          type="url"
          spellcheck="false"
          class="mt-1 w-full rounded-md border border-line bg-app px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-line-strong"
          placeholder="https://example.com/book/123"
          data-source-debug-url
        />
      </label>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="block">
          <span class="text-[11px] text-faint">搜索关键词（搜索段用）</span>
          <input
            v-model="keyword"
            type="text"
            spellcheck="false"
            class="mt-1 w-full rounded-md border border-line bg-app px-2.5 py-1.5 text-[11.5px] text-ink outline-none focus:border-line-strong"
            placeholder="三体"
            data-source-debug-keyword
          />
        </label>
        <label class="block">
          <span class="text-[11px] text-faint">章节地址（正文段用，可留空）</span>
          <input
            v-model="chapterUrl"
            type="url"
            spellcheck="false"
            class="mt-1 w-full rounded-md border border-line bg-app px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-line-strong"
            placeholder="留空则取目录第一章"
            data-source-debug-chapter
          />
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[11px] text-faint">跑哪几段</span>
        <button
          v-for="phase in PHASES"
          :key="phase.key"
          type="button"
          class="rounded border px-1.5 py-px text-[10.5px] transition-colors"
          :class="selected.includes(phase.key)
            ? 'border-accent/50 bg-accent/10 text-accent'
            : 'border-line text-dim hover:border-line-strong hover:text-ink'"
          :title="phase.hint"
          data-source-debug-phase
          @click="togglePhase(phase.key)"
        >
          {{ phase.label }}
        </button>
        <span v-if="selected.length === 0" class="text-[10.5px] text-rose-300">至少选一段</span>
      </div>
    </div>

    <p v-if="error" class="mt-3 text-[12px] text-rose-300" data-source-debug-error>调试失败：{{ error }}</p>

    <p v-if="running" class="mt-3 flex items-center gap-2 text-[11.5px] text-dim" data-source-debug-running>
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      正在按顺序跑：搜索 → 详情 → 目录 → 正文（每段最多 25 秒）…
    </p>

    <div v-else-if="result" class="mt-3 space-y-2">
      <p class="text-[11.5px] text-faint" data-source-debug-summary>
        共 {{ result.sections.length }} 段 · {{ result.elapsedMs }}ms
      </p>

      <section
        v-for="section in result.sections"
        :key="section.phase"
        class="rounded-md border border-line bg-elevated"
        data-source-debug-section
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2.5 py-2 text-left"
          data-source-debug-section-head
          @click="toggleSection(section)"
        >
          <span class="text-[11px] text-faint">{{ isOpen(section) ? '▾' : '▸' }}</span>
          <span class="text-[12px] text-ink/85">{{ PHASE_LABEL[section.phase] }}</span>
          <span class="rounded border px-1.5 py-px text-[10px]" :class="statusClass(section)">
            {{ statusLabel(section) }}
          </span>
          <span class="min-w-0 flex-1 truncate text-[11.5px]" :class="section.ok ? 'text-dim' : 'text-amber-300/90'">
            {{ section.summary }}
          </span>
          <span class="shrink-0 text-[10.5px] text-faint">{{ section.elapsedMs }}ms</span>
        </button>

        <div v-if="isOpen(section)" class="space-y-2 border-t border-line px-2.5 py-2">
          <p v-if="section.error" class="text-[11.5px] leading-relaxed text-rose-300">
            {{ section.error }}
          </p>

          <div
            v-for="(step, index) in section.steps"
            :key="`${section.phase}-${index}`"
            class="rounded border border-line/70 bg-app px-2 py-1.5"
            data-source-debug-step
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]">
              <span class="rounded bg-elevated px-1 py-px" :class="step.kind === 'request' ? 'text-sky-300' : 'text-violet-300'">
                {{ step.kind === 'request' ? '请求' : '规则' }}
              </span>
              <span class="text-ink/80">{{ step.label }}</span>
              <span v-if="step.status !== null" class="text-faint">HTTP {{ step.status }}</span>
              <span class="text-faint">{{ step.elapsedMs }}ms</span>
              <span v-if="step.error !== null" class="text-rose-300">{{ step.error }}</span>
            </div>

            <p v-if="step.rule !== null" class="mt-1 break-all font-mono text-[11px] text-violet-200/90">
              {{ step.rule }}
            </p>
            <p v-if="step.url !== null" class="mt-1 break-all font-mono text-[11px] text-sky-200/90">
              {{ step.url }}
            </p>

            <p v-if="step.values.length > 0" class="mt-1 break-words text-[11.5px] text-ink/85">
              <span class="text-faint">结果：</span>{{ step.values.join(' ｜ ') }}
            </p>
            <p v-else-if="step.kind === 'rule'" class="mt-1 text-[11.5px] text-amber-300/90">
              <span class="text-faint">结果：</span>（空）
            </p>

            <pre
              v-if="step.snippet !== null"
              class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-card px-2 py-1 font-mono text-[10.5px] leading-relaxed text-dim"
              >{{ step.snippet }}</pre
            >
          </div>

          <button type="button" class="ct-btn" data-source-debug-copy @click="copySection(section)">
            复制这一段
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
