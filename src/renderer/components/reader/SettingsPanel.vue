<script setup lang="ts">
/**
 * 排版与主题面板（M2-07）。
 *
 * 每个控件都**直接调 store 的 setter**：本地状态立刻变 → 视图立刻重排，
 * 落库由 store 节流（300ms）统一处理。面板自己不持有任何临时状态，
 * 否则「面板显示的值」和「实际生效的值」迟早会分叉。
 *
 * 面板是右侧覆盖层而不是常驻侧栏：常驻会挤窄正文 → 每次开合都触发一次
 * 分页重排，读者会觉得「开个设置，正文跳了一下」。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { pushToast } from '@/lib/toast'
import {
  comboFromEvent,
  displayCombo,
  SHORTCUTS,
  type ShortcutAction
} from '@/reader/keymap'
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

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const reader = useReaderStore()

const fontSizeLabel = computed(() => `${reader.typography.fontSize}px`)

// ---------------------------------------------------------------- 快捷键（M2-10）

const recording = ref<ShortcutAction | null>(null)

function labelOf(action: ShortcutAction): string {
  return SHORTCUTS.find((item) => item.action === action)?.label ?? action
}

/**
 * 录制键位。
 *
 * 监听挂在 **capture 阶段**并用 `stopImmediatePropagation`：阅读器自己的 keydown
 * 也在 window 上，不拦住的话「录一个 → 键」会同时翻页。捕获阶段先跑，拦得干净。
 */
function startRecord(action: ShortcutAction): void {
  stopRecord()
  recording.value = action
  window.addEventListener('keydown', capture, true)
}

function stopRecord(): void {
  recording.value = null
  window.removeEventListener('keydown', capture, true)
}

function capture(event: KeyboardEvent): void {
  if (!recording.value) return
  event.preventDefault()
  event.stopImmediatePropagation()

  if (event.key === 'Escape') {
    stopRecord()
    return
  }

  const action = recording.value
  const combo = comboFromEvent(event)
  const result = reader.setShortcut(action, combo)
  if (!result.ok) {
    // 冲突时不改，并说清楚被谁占了——否则用户只会觉得「点了没反应」
    pushToast({ level: 'warn', message: `${displayCombo(combo)} 已被「${labelOf(result.conflict)}」占用` })
  }
  stopRecord()
}

onBeforeUnmount(() => stopRecord())
const marginLabel = computed(() => `${reader.typography.margin}px`)

/** range 的值永远是字符串，转换与取整都放在这里，模板里只负责绑 */
function onRange(event: Event, apply: (value: number) => void): void {
  const target = event.target as HTMLInputElement
  apply(Number(target.value))
}

function onColor(event: Event, which: 'bg' | 'text'): void {
  const target = event.target as HTMLInputElement
  if (which === 'bg') reader.setCustomColors(target.value, reader.customText)
  else reader.setCustomColors(reader.customBg, target.value)
}
</script>

<template>
  <div v-if="open" class="absolute inset-0 z-20" data-settings-panel>
    <div class="absolute inset-0" @click="emit('close')" />

    <aside
      class="absolute inset-y-0 right-0 flex w-[320px] flex-col border-l border-line bg-sidebar shadow-[-8px_0_24px_rgba(0,0,0,.28)]"
      role="dialog"
      aria-label="排版与主题"
    >
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <AppIcon name="settings" :size="14" class="text-faint" />
        <span class="text-[12.5px] text-ink">排版与主题</span>
        <span class="flex-1" />
        <button class="ct-icon-btn" title="恢复默认" data-reset-typography @click="reader.resetTypography()">
          <span class="text-[11px] leading-none">重置</span>
        </button>
        <button class="ct-icon-btn" title="关闭（Esc）" data-settings-close @click="emit('close')">
          <AppIcon name="close" :size="13" />
        </button>
      </header>

      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4">
        <!-- 主题 -->
        <section>
          <p class="mb-2 text-[11px] tracking-wider text-faint">主题</p>
          <div class="grid grid-cols-5 gap-1.5">
            <button
              v-for="item in THEME_OPTIONS"
              :key="item.value"
              class="flex h-[46px] flex-col items-center justify-center gap-1 rounded-md border text-[10.5px] transition-colors duration-120"
              :class="reader.theme === item.value ? 'border-accent text-ink' : 'border-line text-dim hover:border-line-strong'"
              :data-theme="item.value"
              :aria-pressed="reader.theme === item.value"
              :title="item.label"
              @click="reader.setTheme(item.value)"
            >
              <span
                class="h-4 w-4 rounded-full border border-black/20"
                :style="{ background: item.bg || 'linear-gradient(135deg,#f7f5ef 50%,#17181b 50%)' }"
              />
              {{ item.label }}
            </button>
          </div>

          <div class="mt-2 flex items-center gap-2 text-[11.5px] text-dim">
            <label class="flex items-center gap-1">
              背景
              <input
                type="color"
                class="h-5 w-6 cursor-pointer rounded border border-line bg-transparent p-0"
                data-custom-bg
                :value="reader.customBg ?? '#f7f5ef'"
                @input="onColor($event, 'bg')"
              />
            </label>
            <label class="flex items-center gap-1">
              文字
              <input
                type="color"
                class="h-5 w-6 cursor-pointer rounded border border-line bg-transparent p-0"
                data-custom-text
                :value="reader.customText ?? '#2b2b2b'"
                @input="onColor($event, 'text')"
              />
            </label>
            <span class="flex-1" />
            <button
              class="ct-btn !px-2 !py-0.5 !text-[11px]"
              data-custom-clear
              @click="reader.setCustomColors(null, null)"
            >
              用主题色
            </button>
          </div>
        </section>

        <!-- 字号 -->
        <section>
          <div class="mb-1.5 flex items-center justify-between text-[11px] text-faint">
            <span>字号</span>
            <span class="tabular-nums text-dim" data-font-size>{{ fontSizeLabel }}</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="ct-icon-btn shrink-0"
              data-font-down
              :disabled="reader.typography.fontSize <= FONT_SIZE_MIN"
              @click="reader.stepFontSize(-1)"
            >
              <span class="text-[11px] leading-none">A−</span>
            </button>
            <input
              type="range"
              class="min-w-0 flex-1 accent-accent"
              :min="FONT_SIZE_MIN"
              :max="FONT_SIZE_MAX"
              step="1"
              data-range="fontSize"
              :value="reader.typography.fontSize"
              @input="onRange($event, reader.setFontSize)"
            />
            <button
              class="ct-icon-btn shrink-0"
              data-font-up
              :disabled="reader.typography.fontSize >= FONT_SIZE_MAX"
              @click="reader.stepFontSize(1)"
            >
              <span class="text-[13px] leading-none">A+</span>
            </button>
          </div>
        </section>

        <!-- 行距 / 字距 / 段距 / 页边距 -->
        <section class="space-y-3">
          <div>
            <div class="mb-1 flex items-center justify-between text-[11px] text-faint">
              <span>行距</span>
              <span class="tabular-nums text-dim">{{ reader.typography.lineHeight.toFixed(1) }}</span>
            </div>
            <input
              type="range"
              class="w-full accent-accent"
              :min="LINE_HEIGHT_MIN"
              :max="LINE_HEIGHT_MAX"
              step="0.1"
              data-range="lineHeight"
              :value="reader.typography.lineHeight"
              @input="onRange($event, reader.setLineHeight)"
            />
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between text-[11px] text-faint">
              <span>字距</span>
              <span class="tabular-nums text-dim">{{ reader.typography.letterSpacing.toFixed(2) }}em</span>
            </div>
            <input
              type="range"
              class="w-full accent-accent"
              min="-0.02"
              max="0.2"
              step="0.01"
              data-range="letterSpacing"
              :value="reader.typography.letterSpacing"
              @input="onRange($event, reader.setLetterSpacing)"
            />
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between text-[11px] text-faint">
              <span>段间距</span>
              <span class="tabular-nums text-dim">{{ reader.typography.paragraphSpacing.toFixed(1) }}em</span>
            </div>
            <input
              type="range"
              class="w-full accent-accent"
              min="0"
              max="2"
              step="0.1"
              data-range="paragraphSpacing"
              :value="reader.typography.paragraphSpacing"
              @input="onRange($event, reader.setParagraphSpacing)"
            />
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between text-[11px] text-faint">
              <span>页边距</span>
              <span class="tabular-nums text-dim" data-margin-label>{{ marginLabel }}</span>
            </div>
            <input
              type="range"
              class="w-full accent-accent"
              :min="MARGIN_MIN"
              :max="MARGIN_MAX"
              step="2"
              data-range="margin"
              :value="reader.typography.margin"
              @input="onRange($event, reader.setMargin)"
            />
          </div>
        </section>

        <!-- 字体 -->
        <section>
          <p class="mb-1.5 text-[11px] tracking-wider text-faint">字体</p>
          <select
            class="w-full rounded-md border border-line bg-elevated px-2 py-1.5 text-[12px] text-dim focus:border-line-strong focus:outline-none"
            data-font-select
            :value="reader.fontFamily"
            @change="reader.setFontFamily(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="font in FONT_OPTIONS" :key="font.value" :value="font.value">{{ font.label }}</option>
          </select>
          <p class="mt-1.5 text-[10.5px] leading-relaxed text-faint">导入字体在 M5 的存储与字体设置里提供。</p>
        </section>

        <!-- 快捷键：键位存 settings.shortcuts，与设置页是同一份数据 -->
        <section>
          <p class="mb-1.5 text-[11px] tracking-wider text-faint">快捷键</p>
          <div class="space-y-1">
            <div v-for="item in SHORTCUTS" :key="item.action" class="flex items-center gap-2 text-[11.5px]">
              <span class="min-w-0 flex-1 truncate text-dim">{{ item.label }}</span>
              <button
                class="shrink-0 rounded border px-1.5 py-0.5 tabular-nums transition-colors duration-120"
                :class="
                  recording === item.action
                    ? 'border-accent text-accent'
                    : 'border-line text-faint hover:border-line-strong hover:text-dim'
                "
                :data-shortcut="item.action"
                :title="recording === item.action ? '按下新的组合键，Esc 取消' : '点击后按下新的组合键'"
                @click="startRecord(item.action)"
              >
                {{ recording === item.action ? '按下按键…' : displayCombo(reader.resolvedShortcuts.bindings[item.action] ?? '') }}
              </button>
            </div>
          </div>
          <p v-if="reader.resolvedShortcuts.conflicts.length > 0" class="mt-1.5 text-[10.5px] leading-relaxed text-[#e0a23c]" data-shortcut-conflicts>
            键位冲突：
            <span v-for="conflict in reader.resolvedShortcuts.conflicts" :key="conflict.combo">
              {{ displayCombo(conflict.combo) }} 被 {{ conflict.actions.map(labelOf).join(' / ') }} 同时占用
            </span>
          </p>
          <p v-else class="mt-1.5 text-[10.5px] leading-relaxed text-faint">与设置页共用同一份键位表。</p>
        </section>
      </div>
    </aside>
  </div>
</template>
