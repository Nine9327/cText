<script setup lang="ts">
/**
 * 导入面板（M1-07）。
 *
 * 四段式：**选目录 → 预览分类 → 导入中 → 结果**。
 *
 * 为什么必须有「预览」这一段：导入是**写库**操作，而用户拖进来的目录里往往
 * 混着 PDF、空文件、以及已经导入过的书。先看一眼「新增 5 / 重复 132 / 不支持 3」
 * 再决定要不要导入，比导入完了再想办法清理要省事得多。
 *
 * 为什么「导入中」是独立一段而不是让预览原地变进度条：导入可被取消，
 * 而取消后用户要看的是「已经进去了几本」，不是原来那张预览表。
 */
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import { useImportStore } from '@/stores/import'
import type { ScanPreviewItemDTO } from '@shared/dto'
import { pushToast } from '@/lib/toast'

const store = useImportStore()

/**
 * 「不支持」与「跳过」必须分开：PDF 是「这个格式我们不要」，空文件是
 * 「这个文件没内容」。混在一个页签里，用户会以为空文件也是不支持的格式。
 */
const tabs = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '新增' },
  { value: 'duplicate', label: '已存在' },
  { value: 'unsupported', label: '不支持' },
  { value: 'skipped', label: '跳过' }
]

const tab = computed({
  get: () => store.tab,
  set: (value: string) => {
    store.tab = value as typeof store.tab
  }
})

const statusText: Record<ScanPreviewItemDTO['status'], string> = {
  new: '新增',
  duplicate: '已存在',
  unsupported: '不支持',
  empty: '空文件',
  failed: '读不了'
}

const statusClass: Record<ScanPreviewItemDTO['status'], string> = {
  new: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  duplicate: 'border-line bg-hover text-dim',
  unsupported: 'border-line bg-hover text-faint',
  empty: 'border-amber-500/30 bg-amber-500/10 text-amber-300/90',
  failed: 'border-rose-500/30 bg-rose-500/10 text-rose-300'
}

const running = computed(() => store.stage === 'running')
const progress = computed(() => store.progress)
const result = computed(() => store.result)

const percent = computed(() => {
  const dto = progress.value
  if (!dto || dto.total <= 0) return 0
  return Math.min(100, Math.round((dto.processed / dto.total) * 100))
})

const phaseText = computed(() => {
  const phase = progress.value?.phase
  if (phase === 'scan') return '正在扫描目录…'
  if (phase === 'parse') return '正在解析书籍…'
  if (phase === 'commit') return '正在写入书库…'
  return '处理中…'
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function copyPath(relPath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(relPath)
    pushToast({ level: 'info', message: '路径已复制' })
  } catch {
    pushToast({ level: 'warn', message: '复制失败，请手动选中路径' })
  }
}
</script>

<template>
  <div
    v-if="store.visible"
    class="fixed inset-0 z-[70] flex items-center justify-center"
    :data-stage="store.stage"
    data-import-dialog
  >
    <div class="absolute inset-0 bg-black/60" data-import-backdrop @click="store.close()" />

    <div
      class="relative flex max-h-[86vh] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line-strong bg-elevated shadow-[0_18px_60px_rgba(0,0,0,.6)]"
    >
      <!-- 标题栏 -->
      <div class="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
        <h2 class="flex items-center gap-2 text-[14px] font-medium text-ink">
          <AppIcon name="import" :size="15" class="text-dim" />
          导入书籍
        </h2>
        <button type="button" class="ct-icon-btn app-no-drag" data-import-close @click="store.close()">
          <AppIcon name="close" :size="14" />
        </button>
      </div>

      <!-- ① 选目录 -->
      <div v-if="store.stage === 'pick'" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p v-if="store.notice" class="mb-3 rounded-md border border-line bg-card px-3 py-2 text-[12px] text-dim">
          {{ store.notice }}
        </p>

        <label class="mb-1.5 block text-[12px] text-dim">文件夹</label>
        <div class="flex items-center gap-2">
          <input
            v-model="store.dirPath"
            type="text"
            placeholder="D:\books 或点击右侧按钮选择"
            class="min-w-0 flex-1 rounded-md border border-line bg-card px-3 py-2 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
            data-import-path
            @keyup.enter="store.scan()"
          />
          <button type="button" class="ct-btn shrink-0" data-import-pick @click="store.pickFolder()">
            <AppIcon name="folder" :size="14" />
            选择
          </button>
        </div>

        <div class="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
          <div>
            <label class="mb-1.5 block text-[12px] text-dim">扫描深度</label>
            <input
              v-model.number="store.options.scanDepth"
              type="number"
              min="1"
              max="16"
              class="w-full rounded-md border border-line bg-card px-3 py-1.5 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
            />
          </div>
          <div>
            <label class="mb-1.5 block text-[12px] text-dim">重复的书</label>
            <select
              v-model="store.options.onDuplicate"
              class="w-full rounded-md border border-line bg-card px-3 py-1.5 text-[12.5px] text-ink focus:border-line-strong focus:outline-none"
            >
              <option value="skip">跳过（保留原记录）</option>
              <option value="overwrite">覆盖（文件内容变了才更新）</option>
            </select>
          </div>
          <div class="col-span-2">
            <label class="mb-1.5 block text-[12px] text-dim">忽略规则（可选，正则，匹配相对路径）</label>
            <input
              v-model="store.options.ignorePattern"
              type="text"
              placeholder="例如 (^|/)草稿(/|$)"
              class="w-full rounded-md border border-line bg-card px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
            />
          </div>
          <label class="col-span-2 flex items-center gap-2 text-[12.5px] text-dim">
            <input
              v-model="store.options.registerAsRoot"
              type="checkbox"
              class="h-3.5 w-3.5 accent-[#5b8def]"
            />
            该目录尚未登记时，同时登记为书库根目录
          </label>
        </div>

        <p v-if="store.error" class="mt-3 text-[12px] text-rose-300" data-import-error>{{ store.error }}</p>
      </div>

      <!-- ② 预览 -->
      <div v-else-if="store.stage === 'preview'" class="flex min-h-0 flex-1 flex-col">
        <div class="shrink-0 border-b border-line px-5 py-3">
          <p class="mb-2 truncate font-mono text-[11.5px] text-faint" data-import-target>{{ store.dirPath }}</p>
          <div class="flex flex-wrap items-center gap-2" data-import-stats>
            <span
              class="rounded border px-2 py-0.5 text-[11.5px] border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              data-stat="new"
              >新增 {{ store.counts.fresh }}</span
            >
            <span
              class="rounded border border-line bg-hover px-2 py-0.5 text-[11.5px] text-dim"
              data-stat="duplicate"
              >已存在 {{ store.counts.duplicate }}</span
            >
            <span
              class="rounded border border-line bg-hover px-2 py-0.5 text-[11.5px] text-faint"
              data-stat="unsupported"
              >不支持 {{ store.counts.unsupported }}</span
            >
            <span
              v-if="store.counts.skipped > 0"
              class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11.5px] text-amber-300/90"
              data-stat="empty"
              >跳过 {{ store.counts.skipped }}</span
            >
            <span class="text-[11.5px] text-faint"
              >扫描 {{ store.preview?.elapsedMs ?? 0 }}ms，共 {{ store.preview?.total ?? 0 }} 项</span
            >
          </div>
          <p v-if="store.preview?.truncated" class="mt-1.5 text-[11.5px] text-amber-300/80">
            目录过大，列表只显示前 {{ store.maxRows }} 项；导入仍会处理全部文件。
          </p>
        </div>

        <div class="shrink-0 px-5 py-2.5">
          <SegmentedControl v-model="tab" :options="tabs" />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-3" data-import-list>
          <div
            v-for="item in store.rows"
            :key="item.relPath"
            class="flex items-center gap-2.5 border-b border-line/60 py-1.5 last:border-b-0"
            data-import-row
            :data-row-status="item.status"
          >
            <span
              class="shrink-0 rounded border px-1.5 py-px text-[10.5px]"
              :class="statusClass[item.status]"
              >{{ statusText[item.status] }}</span
            >
            <span class="min-w-0 flex-1 truncate text-[12px] text-ink/90" :title="item.relPath">{{ item.relPath }}</span>
            <span class="shrink-0 text-[11px] text-faint">{{ formatSize(item.sizeBytes) }}</span>
            <span v-if="item.duplicateOf" class="max-w-[210px] shrink-0 truncate text-[11px] text-faint">
              已在书库：{{ item.duplicateOf.title }}
            </span>
            <span v-else-if="item.reason" class="max-w-[210px] shrink-0 truncate text-[11px] text-faint">
              {{ item.reason }}
            </span>
          </div>
          <p v-if="store.rows.length === 0" class="py-6 text-center text-[12px] text-faint">这个分类下没有文件</p>
        </div>
      </div>

      <!-- ③ 导入中 -->
      <div v-else-if="running" class="flex min-h-0 flex-1 flex-col px-5 py-5" data-import-progress>
        <p class="text-[13px] text-ink">{{ phaseText }}</p>
        <p class="mt-1 truncate font-mono text-[11.5px] text-faint">
          {{ progress?.currentPath ?? '准备中…' }}
        </p>

        <div class="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-card">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-200"
            :style="{ width: `${percent}%` }"
            data-import-bar
          />
        </div>
        <div class="mt-2 flex items-center justify-between text-[11.5px] text-faint">
          <span>{{ progress?.processed ?? 0 }} / {{ progress?.total ?? 0 }}</span>
          <span>{{ percent }}%</span>
        </div>

        <dl class="mt-4 grid grid-cols-4 gap-2 text-center">
          <div class="rounded-md border border-line bg-card py-2">
            <dt class="text-[11px] text-faint">新增</dt>
            <dd class="mt-0.5 text-[15px] text-ink" data-live="imported">{{ progress?.imported ?? 0 }}</dd>
          </div>
          <div class="rounded-md border border-line bg-card py-2">
            <dt class="text-[11px] text-faint">覆盖</dt>
            <dd class="mt-0.5 text-[15px] text-ink" data-live="updated">{{ progress?.updated ?? 0 }}</dd>
          </div>
          <div class="rounded-md border border-line bg-card py-2">
            <dt class="text-[11px] text-faint">跳过</dt>
            <dd class="mt-0.5 text-[15px] text-ink" data-live="skipped">{{ progress?.skipped ?? 0 }}</dd>
          </div>
          <div class="rounded-md border border-line bg-card py-2">
            <dt class="text-[11px] text-faint">失败</dt>
            <dd class="mt-0.5 text-[15px] text-ink" data-live="failed">{{ progress?.failedTotal ?? 0 }}</dd>
          </div>
        </dl>

        <p class="mt-4 text-[11.5px] leading-relaxed text-faint">
          关闭面板不会中断导入；要停止请点「取消导入」。
        </p>
      </div>

      <!-- ④ 结果 -->
      <div v-else-if="store.stage === 'result' && result" class="flex min-h-0 flex-1 flex-col" data-import-result>
        <div class="shrink-0 px-5 py-5">
          <p class="flex items-center gap-2 text-[13.5px] text-ink">
            <AppIcon
              :name="result.phase === 'done' ? 'check' : result.phase === 'cancelled' ? 'info' : 'error'"
              :size="15"
              :class="result.phase === 'done' ? 'text-emerald-400' : result.phase === 'cancelled' ? 'text-dim' : 'text-rose-400'"
            />
            {{
              result.phase === 'done'
                ? '导入完成'
                : result.phase === 'cancelled'
                  ? '已取消导入'
                  : '导入失败'
            }}
          </p>
          <dl class="mt-4 grid grid-cols-4 gap-2 text-center">
            <div class="rounded-md border border-line bg-card py-2">
              <dt class="text-[11px] text-faint">新增</dt>
              <dd class="mt-0.5 text-[15px] text-ink" data-result="imported">{{ result.imported }}</dd>
            </div>
            <div class="rounded-md border border-line bg-card py-2">
              <dt class="text-[11px] text-faint">覆盖</dt>
              <dd class="mt-0.5 text-[15px] text-ink" data-result="updated">{{ result.updated }}</dd>
            </div>
            <div class="rounded-md border border-line bg-card py-2">
              <dt class="text-[11px] text-faint">跳过</dt>
              <dd class="mt-0.5 text-[15px] text-ink" data-result="skipped">{{ result.skipped }}</dd>
            </div>
            <div class="rounded-md border border-line bg-card py-2">
              <dt class="text-[11px] text-faint">失败</dt>
              <dd class="mt-0.5 text-[15px] text-ink" data-result="failed">{{ result.failedTotal }}</dd>
            </div>
          </dl>
        </div>

        <div v-if="result.failures.length > 0" class="min-h-0 flex-1 overflow-y-auto border-t border-line px-5 py-3">
          <p class="mb-2 text-[12px] text-dim">
            失败 {{ result.failedTotal }} 项（列出最近 {{ result.failures.length }} 条）
          </p>
          <div
            v-for="failure in result.failures"
            :key="failure.relPath"
            class="flex items-center gap-2 border-b border-line/60 py-1.5 last:border-b-0"
            data-import-failure
          >
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink/85">{{ failure.relPath }}</span>
            <span class="shrink-0 text-[11px] text-rose-300/90">{{ failure.reason }}</span>
            <button
              type="button"
              class="ct-icon-btn shrink-0"
              title="复制路径"
              data-import-copy
              @click="copyPath(failure.relPath)"
            >
              <AppIcon name="layers" :size="13" />
            </button>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="flex shrink-0 items-center justify-between gap-2 border-t border-line px-5 py-3">
        <span class="text-[11.5px] text-faint">
          {{
            store.stage === 'preview'
              ? `共 ${store.preview?.total ?? 0} 项`
              : store.stage === 'result'
                ? '可再次扫描同一目录确认没有重复'
                : '支持 TXT / EPUB'
          }}
        </span>
        <div class="flex items-center gap-2">
          <button
            v-if="store.stage === 'pick'"
            type="button"
            class="ct-btn"
            :disabled="store.scanning"
            data-import-scan
            @click="store.scan()"
          >
            <AppIcon name="search" :size="14" />
            {{ store.scanning ? '扫描中…' : '扫描目录' }}
          </button>

          <template v-else-if="store.stage === 'preview'">
            <button type="button" class="ct-btn" data-import-rescan @click="store.scan()">重新扫描</button>
            <button
              type="button"
              class="ct-btn border-accent/50 bg-accent/15 text-ink hover:border-accent hover:bg-accent/25"
              :disabled="!store.canStart"
              data-import-start
              @click="store.start()"
            >
              <AppIcon name="import" :size="14" />
              开始导入
            </button>
          </template>

          <template v-else-if="running">
            <button type="button" class="ct-btn" data-import-cancel @click="store.cancel()">
              <AppIcon name="close" :size="13" />
              取消导入
            </button>
          </template>

          <template v-else>
            <button type="button" class="ct-btn" data-import-again @click="store.reset()">再导一个</button>
            <button
              type="button"
              class="ct-btn border-accent/50 bg-accent/15 text-ink hover:border-accent hover:bg-accent/25"
              data-import-finish
              @click="store.close()"
            >
              完成
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
