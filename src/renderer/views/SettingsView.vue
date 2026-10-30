<script setup lang="ts">
/**
 * 设置中心（M5-01）。
 *
 * 七组：常规 / 阅读 / 书库目录 / 网络书源 / 存储 / 快捷键 / 关于。
 * （产品文档里的「爬取任务」组随 M6 追加，现在连占位都不给。）
 *
 * 三条结构决策：
 *
 *   1. **左侧分组导航 + 右侧单组渲染**，不是一长条滚动。
 *      七组全铺开要滚三四屏，而「找设置」是「我知道我要改什么，直接去那一组」的行为，
 *      不是浏览行为。分组导航让人一次点击到位。
 *
 *   2. **阅读组与快捷键组的真相源是 `stores/reader`，不是 `stores/settings`**。
 *      阅读器正在用那份数据渲染正文；设置页改自己的一份再让阅读器去同步，
 *      会出现「设置页显示 20px、正文还是 18px」这种不可解释的状态。
 *      其余三组（常规/存储/书源）没有这样的运行时副本，走 settings store。
 *
 *   3. **每一组都能独立恢复默认**（页头的「恢复默认」是全部重置）。
 *      阅读组复用 `reader.resetTypography()`，快捷键组逐条回默认——它们各自
 *      有现成的「重置」语义，不需要再造一个。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingRow from '@/components/settings/SettingRow.vue'
import ToggleSwitch from '@/components/settings/ToggleSwitch.vue'
import ShortcutRow from '@/components/settings/ShortcutRow.vue'
import RootsSettings from '@/components/settings/RootsSettings.vue'
import AboutSettings from '@/components/settings/AboutSettings.vue'
import { sourcesApi } from '@/api/sources'
import { systemApi } from '@/api/system'
import { call } from '@/api/client'
import { pushToast } from '@/lib/toast'
import { formatSize } from '@/lib/format'
import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MARGIN_MAX,
  MARGIN_MIN,
  THEME_OPTIONS,
  useReaderStore
} from '@/stores/reader'
import { useSettingsStore } from '@/stores/settings'
import { DEFAULT_SHORTCUTS, SHORTCUTS } from '@/reader/keymap'
import type { CloseAction, SystemStorageStatsDTO } from '@shared/dto'
import type { IconName } from '@/components/common/icons'

const router = useRouter()
const settings = useSettingsStore()
const reader = useReaderStore()

type GroupKey = 'general' | 'reading' | 'library' | 'sources' | 'storage' | 'shortcuts' | 'about'

const GROUPS: ReadonlyArray<{ key: GroupKey; label: string; icon: IconName }> = [
  { key: 'general', label: '常规', icon: 'settings' },
  { key: 'reading', label: '阅读', icon: 'book' },
  { key: 'library', label: '书库目录', icon: 'folder' },
  { key: 'sources', label: '网络书源', icon: 'globe' },
  { key: 'storage', label: '存储', icon: 'layers' },
  { key: 'shortcuts', label: '快捷键', icon: 'list' },
  { key: 'about', label: '关于', icon: 'info' }
]

const active = ref<GroupKey>('general')
const activeLabel = computed(() => GROUPS.find((g) => g.key === active.value)?.label ?? '设置')

onMounted(async () => {
  await settings.load(true)
  // 阅读组直接改 reader store，必须先让它从库里读一次，否则显示的是硬编码默认值
  await reader.load()
  void loadStats()
})

// ---------------------------------------------------------------- 常规

const busyKey = ref<string | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 写一个设置项。
 *
 * 失败时提示并**不本地回退**：settings store 在失败后会重新读库，
 * 界面等下个 tick 就回到真实值——比手写「记住旧值再还原」少一条出错路径。
 */
async function commit(patch: Parameters<typeof settings.patch>[0], key: string): Promise<boolean> {
  if (busyKey.value !== null) return false
  busyKey.value = key
  const ok = await settings.patch(patch)
  busyKey.value = null
  if (!ok) pushToast({ level: 'error', message: settings.error ?? '保存设置失败' })
  return ok
}

async function setAutoLaunch(value: boolean): Promise<void> {
  await commit({ general: { autoLaunch: value } }, 'autoLaunch')
  if (value && !settings.current?.general.autoLaunch) {
    pushToast({ level: 'warn', message: '系统未接受自启动设置，请检查系统启动项权限' })
  }
}

async function setCloseAction(value: CloseAction): Promise<void> {
  const ok = await commit({ general: { closeAction: value } }, 'closeAction')
  if (ok && value === 'tray') {
    pushToast({ level: 'info', message: '关闭窗口后将隐藏到系统托盘，右键托盘图标可退出' })
  }
}

async function setMinimizeToTray(value: boolean): Promise<void> {
  const ok = await commit({ general: { minimizeToTray: value } }, 'minimizeToTray')
  if (ok && value) pushToast({ level: 'info', message: '最小化后会在托盘保留图标' })
}

// ---------------------------------------------------------------- 阅读

function onRange(event: Event, apply: (value: number) => void): void {
  const target = event.target as HTMLInputElement
  apply(Number(target.value))
}

/** 阅读组的 select 需要显式类型转换：模板里不能写 as 断言 */
function setFont(event: Event): void {
  reader.setFontFamily((event.target as HTMLSelectElement).value)
}

function setThemeValue(event: Event): void {
  reader.setTheme((event.target as HTMLSelectElement).value as (typeof THEME_OPTIONS)[number]['value'])
}

function setMode(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  reader.setMode(value === 'auto' ? 'auto' : (value as 'paged' | 'scroll'))
}

// ---------------------------------------------------------------- 书源

async function acceptComplianceAgain(): Promise<void> {
  const ok = await commit({ sources: { complianceAccepted: false } }, 'compliance')
  if (ok) pushToast({ level: 'info', message: '下次打开网络小说并导入书源时会再次显示合规提示' })
}

async function setTtl(event: Event): Promise<void> {
  const days = Number((event.target as HTMLSelectElement).value)
  const ok = await commit({ sources: { cacheTtlDays: days } }, 'ttl')
  if (ok) pushToast({ level: 'info', message: `正文缓存保留 ${days} 天` })
}

// ---------------------------------------------------------------- 存储

const stats = ref<SystemStorageStatsDTO | null>(null)
const statsLoading = ref(false)
const clearingKey = ref<string | null>(null)

async function loadStats(): Promise<void> {
  statsLoading.value = true
  try {
    stats.value = await systemApi.storageStats()
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    statsLoading.value = false
  }
}

async function openDir(target: 'covers' | 'chapters' | 'data' | 'logs'): Promise<void> {
  try {
    await systemApi.openPath(target)
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}

async function setCoverLimit(event: Event): Promise<void> {
  const mb = Number((event.target as HTMLSelectElement).value)
  const ok = await commit({ storage: { coverCacheLimitMb: mb } }, 'coverLimit')
  if (!ok) return
  pushToast({ level: 'info', message: mb === 0 ? '已取消封面上限' : `封面上限 ${mb} MB，超出后自动清理最旧的图片` })
  // 主进程在保存后会裁一次，等它落盘再读用量
  setTimeout(() => void loadStats(), 300)
}

async function clearCovers(): Promise<void> {
  if (clearingKey.value !== null) return
  clearingKey.value = 'covers'
  try {
    const result = await systemApi.clearCovers()
    pushToast({ level: 'info', message: `已清理 ${result.files} 张封面（${formatSize(result.bytes)}）` })
    await loadStats()
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    clearingKey.value = null
  }
}

async function clearChapters(): Promise<void> {
  if (clearingKey.value !== null) return
  clearingKey.value = 'chapters'
  try {
    const result = await sourcesApi.clearCache()
    pushToast({
      level: 'info',
      message: result.files === 0 ? '没有可清理的正文缓存' : `已清理 ${result.files} 个文件（${formatSize(result.bytes)}）`
    })
    await loadStats()
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    clearingKey.value = null
  }
}

const coverLimitOptions = [0, 128, 256, 512, 1024, 2048]
const ttlOptions = [7, 15, 30, 60, 90]

// ---------------------------------------------------------------- 快捷键

async function resetShortcuts(): Promise<void> {
  try {
    const next = await call('settings:patch', { patch: { shortcuts: DEFAULT_SHORTCUTS } })
    reader.applyShortcuts(next.shortcuts)
    pushToast({ level: 'info', message: '快捷键已恢复默认' })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}

// ---------------------------------------------------------------- 全部重置

const resetting = ref(false)

async function confirmReset(): Promise<void> {
  resetting.value = false
  const ok = await settings.reset()
  if (!ok) {
    pushToast({ level: 'error', message: settings.error ?? '恢复默认失败' })
    return
  }
  // reader 的副本也要重读：设置表被清空后阅读排版回到 18px/1.9/日间
  await reader.load()
  await loadStats()
  pushToast({ level: 'info', message: '已恢复全部默认设置' })
}
</script>

<template>
  <div class="flex h-full min-h-0 bg-app" data-settings-page>
    <!-- 分组导航：固定宽度，不参与滚动 -->
    <nav class="w-[176px] shrink-0 border-r border-line bg-sidebar p-2.5" aria-label="设置分组">
      <p class="px-2 pb-1.5 pt-0.5 text-[10.5px] tracking-wider text-faint">设置</p>
      <button
        v-for="group in GROUPS"
        :key="group.key"
        type="button"
        class="ct-nav-item"
        :class="active === group.key && 'ct-nav-item-active'"
        :data-settings-nav="group.key"
        @click="active = group.key"
      >
        <AppIcon :name="group.icon" :size="14" />
        <span class="flex-1 truncate">{{ group.label }}</span>
      </button>
    </nav>

    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[760px] px-6 py-5">
        <header class="mb-4 flex items-baseline gap-3">
          <h1 class="text-[15px] font-medium text-ink" data-settings-title>{{ activeLabel }}</h1>
          <span class="flex-1" />
          <button type="button" class="ct-btn" data-settings-reset @click="resetting = true">
            恢复默认设置
          </button>
        </header>

        <div v-if="!settings.ready" class="rounded-xl border border-line bg-card px-4 py-8 text-center text-[12px] text-faint">
          正在读取设置…
        </div>

        <template v-else>
          <!-- ------------------------------------------------------------ 常规 -->
          <SettingsGroup
            v-if="active === 'general'"
            title="常规"
            desc="启动与窗口行为。改动立即生效，不需要重启。"
            data-settings-group="general"
          >
            <SettingRow
              label="开机自启"
              desc="登录系统时在后台启动，并收进系统托盘。开发态不会写入系统启动项。"
            >
              <ToggleSwitch
                :model-value="settings.general?.autoLaunch ?? false"
                :disabled="busyKey !== null"
                label="开机自启"
                data-settings-auto-launch
                @update:model-value="setAutoLaunch"
              />
            </SettingRow>

            <SettingRow label="关闭窗口时" desc="选择「最小化到托盘」后，请用托盘右键菜单里的「退出 cText」真正退出。">
              <div class="flex overflow-hidden rounded-md border border-line" data-settings-close-action>
                <button
                  type="button"
                  class="px-2.5 py-1 text-[11.5px] transition-colors duration-120"
                  :class="
                    settings.general?.closeAction === 'quit'
                      ? 'bg-active text-ink'
                      : 'bg-elevated text-dim hover:text-ink'
                  "
                  data-close-action="quit"
                  @click="setCloseAction('quit')"
                >
                  退出应用
                </button>
                <button
                  type="button"
                  class="border-l border-line px-2.5 py-1 text-[11.5px] transition-colors duration-120"
                  :class="
                    settings.general?.closeAction === 'tray'
                      ? 'bg-active text-ink'
                      : 'bg-elevated text-dim hover:text-ink'
                  "
                  data-close-action="tray"
                  @click="setCloseAction('tray')"
                >
                  最小化到托盘
                </button>
              </div>
            </SettingRow>

            <SettingRow label="最小化到托盘" desc="点最小化按钮时不留在任务栏，只在托盘保留图标。">
              <ToggleSwitch
                :model-value="settings.general?.minimizeToTray ?? false"
                :disabled="busyKey !== null"
                label="最小化到托盘"
                data-settings-minimize-tray
                @update:model-value="setMinimizeToTray"
              />
            </SettingRow>

            <SettingRow label="界面语言" desc="当前版本只有简体中文。">
              <span class="text-[12px] text-dim">简体中文</span>
            </SettingRow>
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 阅读 -->
          <SettingsGroup
            v-else-if="active === 'reading'"
            title="阅读"
            desc="作用于阅读器正文。改动会立刻同步到正在读的书。"
            data-settings-group="reading"
          >
            <SettingRow label="字号" desc="12 – 32 px">
              <div class="flex w-[220px] items-center gap-3">
                <input
                  type="range"
                  class="min-w-0 flex-1 accent-accent"
                  :min="FONT_SIZE_MIN"
                  :max="FONT_SIZE_MAX"
                  step="1"
                  data-settings-range="fontSize"
                  :value="reader.typography.fontSize"
                  @input="onRange($event, reader.setFontSize)"
                />
                <span class="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-dim">
                  {{ reader.typography.fontSize }}px
                </span>
              </div>
            </SettingRow>

            <SettingRow label="行距" desc="1.2 – 2.4 倍">
              <div class="flex w-[220px] items-center gap-3">
                <input
                  type="range"
                  class="min-w-0 flex-1 accent-accent"
                  :min="LINE_HEIGHT_MIN"
                  :max="LINE_HEIGHT_MAX"
                  step="0.1"
                  data-settings-range="lineHeight"
                  :value="reader.typography.lineHeight"
                  @input="onRange($event, reader.setLineHeight)"
                />
                <span class="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-dim">
                  {{ reader.typography.lineHeight.toFixed(1) }}
                </span>
              </div>
            </SettingRow>

            <SettingRow label="段间距" desc="段落之间的距离，单位 em">
              <div class="flex w-[220px] items-center gap-3">
                <input
                  type="range"
                  class="min-w-0 flex-1 accent-accent"
                  min="0"
                  max="2"
                  step="0.1"
                  data-settings-range="paragraphSpacing"
                  :value="reader.typography.paragraphSpacing"
                  @input="onRange($event, reader.setParagraphSpacing)"
                />
                <span class="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-dim">
                  {{ reader.typography.paragraphSpacing.toFixed(1) }}
                </span>
              </div>
            </SettingRow>

            <SettingRow label="页边距" :desc="`左右 ${MARGIN_MIN} – ${MARGIN_MAX} px，上下取 0.6 倍`">
              <div class="flex w-[220px] items-center gap-3">
                <input
                  type="range"
                  class="min-w-0 flex-1 accent-accent"
                  :min="MARGIN_MIN"
                  :max="MARGIN_MAX"
                  step="4"
                  data-settings-range="margin"
                  :value="reader.typography.margin"
                  @input="onRange($event, reader.setMargin)"
                />
                <span class="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-dim">
                  {{ reader.typography.margin }}px
                </span>
              </div>
            </SettingRow>

            <SettingRow label="字体">
              <select
                class="rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink outline-none hover:border-line-strong"
                data-settings-select="fontFamily"
                :value="reader.fontFamily"
                @change="setFont"
              >
                <option v-for="font in FONT_OPTIONS" :key="font.value" :value="font.value">
                  {{ font.label }}
                </option>
              </select>
            </SettingRow>

            <SettingRow label="主题">
              <div class="flex items-center gap-2">
                <span
                  v-for="option in THEME_OPTIONS"
                  :key="option.value"
                  class="h-4 w-4 rounded-full border border-line"
                  :style="option.bg ? { background: option.bg } : { background: 'linear-gradient(135deg,#f7f5ef 50%,#17181b 50%)' }"
                  :title="option.label"
                />
                <select
                  class="rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink outline-none hover:border-line-strong"
                  data-settings-select="theme"
                  :value="reader.theme"
                  @change="setThemeValue"
                >
                  <option v-for="option in THEME_OPTIONS" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </div>
            </SettingRow>

            <SettingRow label="阅读模式" desc="「跟随书籍」按格式决定：EPUB 滚动、TXT 分页。">
              <select
                class="rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink outline-none hover:border-line-strong"
                data-settings-select="mode"
                :value="reader.mode"
                @change="setMode"
              >
                <option value="auto">跟随书籍</option>
                <option value="paged">翻页</option>
                <option value="scroll">滚动</option>
              </select>
            </SettingRow>

            <SettingRow label="记住阅读进度" desc="关闭后不写入也不读取阅读位置，适合只用来查资料的书。">
              <ToggleSwitch
                :model-value="reader.rememberProgress"
                label="记住阅读进度"
                data-settings-remember-progress
                @update:model-value="reader.setRememberProgress"
              />
            </SettingRow>

            <template #footer>
              <button type="button" class="ct-btn" data-settings-reset-typography @click="reader.resetTypography()">
                恢复阅读默认
              </button>
            </template>
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 书库目录 -->
          <SettingsGroup
            v-else-if="active === 'library'"
            title="书库目录"
            desc="应用只读取这些目录里的书。移除目录不会删除磁盘上的文件。"
            data-settings-group="library"
          >
            <RootsSettings />
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 书源 -->
          <SettingsGroup
            v-else-if="active === 'sources'"
            title="网络书源"
            desc="书源规则由你自行导入，应用不内置、不分发任何书源。"
            data-settings-group="sources"
          >
            <SettingRow
              label="合规提示"
              :desc="
                settings.sources?.complianceAccepted
                  ? '已确认。重置后会再显示一次首次导入时的说明。'
                  : '尚未确认：下次导入书源时会先弹出说明。'
              "
            >
              <button
                v-if="settings.sources?.complianceAccepted"
                type="button"
                class="ct-btn"
                data-settings-compliance-reset
                @click="acceptComplianceAgain"
              >
                重新显示
              </button>
              <span v-else class="text-[12px] text-amber-300/90">待确认</span>
            </SettingRow>

            <SettingRow label="正文缓存保留" desc="超过天数的章节在联网时会重新抓取；离线仍然可读，不会被删。">
              <select
                class="rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink outline-none hover:border-line-strong"
                data-settings-select="ttl"
                :value="settings.sources?.cacheTtlDays ?? 30"
                @change="setTtl"
              >
                <option v-for="day in ttlOptions" :key="day" :value="day">{{ day }} 天</option>
              </select>
            </SettingRow>

            <SettingRow label="书源管理" desc="导入、启停、排序、规则调试都在网络小说页。">
              <button type="button" class="ct-btn" data-settings-goto-sources @click="router.push('/sources')">
                打开网络小说
              </button>
            </SettingRow>
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 存储 -->
          <SettingsGroup
            v-else-if="active === 'storage'"
            title="存储"
            desc="缓存都可以随时清理，清理不会影响书库、书架与阅读进度。"
            data-settings-group="storage"
          >
            <SettingRow label="正文缓存" :desc="stats ? `${stats.chapters.files} 个文件 · ${formatSize(stats.chapters.bytes)}` : '正在统计…'">
              <div class="flex gap-2">
                <button type="button" class="ct-btn" data-settings-open-chapters @click="openDir('chapters')">
                  打开目录
                </button>
                <button
                  type="button"
                  class="ct-btn"
                  :disabled="clearingKey !== null"
                  data-settings-clear-chapters
                  @click="clearChapters"
                >
                  清理
                </button>
              </div>
            </SettingRow>

            <SettingRow
              label="封面缓存"
              :desc="stats ? `${stats.covers.files} 张 · ${formatSize(stats.covers.bytes)}` : '正在统计…'"
            >
              <div class="flex gap-2">
                <button type="button" class="ct-btn" data-settings-open-covers @click="openDir('covers')">
                  打开目录
                </button>
                <button
                  type="button"
                  class="ct-btn"
                  :disabled="clearingKey !== null"
                  data-settings-clear-covers
                  @click="clearCovers"
                >
                  清理
                </button>
              </div>
            </SettingRow>

            <SettingRow label="封面缓存上限" desc="超出后自动删除最旧的封面图片。0 表示不限制。">
              <select
                class="rounded-md border border-line bg-elevated px-2 py-1 text-[12px] text-ink outline-none hover:border-line-strong"
                data-settings-select="coverLimit"
                :value="settings.storage?.coverCacheLimitMb ?? 512"
                @change="setCoverLimit"
              >
                <option v-for="mb in coverLimitOptions" :key="mb" :value="mb">
                  {{ mb === 0 ? '不限制' : `${mb} MB` }}
                </option>
              </select>
            </SettingRow>

            <template #footer>
              <div class="flex items-center gap-2">
                <button type="button" class="ct-btn" :disabled="statsLoading" data-settings-refresh-stats @click="loadStats">
                  刷新用量
                </button>
                <span v-if="stats" class="truncate text-[11px] text-faint">数据目录：{{ stats.dataDir }}</span>
              </div>
            </template>
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 快捷键 -->
          <SettingsGroup
            v-else-if="active === 'shortcuts'"
            title="快捷键"
            desc="点击右侧键位后按下新的组合，Esc 取消。阅读器内与这里共用同一套键位。"
            data-settings-group="shortcuts"
          >
            <ShortcutRow
              v-for="item in SHORTCUTS"
              :key="item.action"
              :action="item.action"
              :label="item.label"
              data-settings-shortcut
            />

            <template #footer>
              <div class="flex items-center gap-3">
                <button type="button" class="ct-btn" data-settings-reset-shortcuts @click="resetShortcuts">
                  全部恢复默认
                </button>
                <span class="text-[11px] text-faint">
                  方向键、PgUp/PgDn、空格等阅读惯例键始终可用，不参与改键
                </span>
              </div>
            </template>
          </SettingsGroup>

          <!-- ------------------------------------------------------------ 关于 -->
          <SettingsGroup
            v-else
            title="关于"
            desc="版本信息与本地数据位置，反馈问题时可一键复制。"
            data-settings-group="about"
          >
            <AboutSettings />
          </SettingsGroup>
        </template>

        <p class="mt-4 text-[11px] leading-relaxed text-faint">
          阅读偏好即时保存；常规设置里的自启动与托盘行为会同步到系统，不需要重启应用。
        </p>
      </div>
    </div>

    <ConfirmDialog
      :open="resetting"
      title="恢复全部默认设置？"
      desc="常规、阅读排版、存储与书源相关设置都会回到初始值，自定义键位也会清空。书库、书架、阅读进度与书源规则不受影响。"
      confirm-text="恢复默认"
      danger
      @confirm="confirmReset"
      @cancel="resetting = false"
    />
  </div>
</template>
