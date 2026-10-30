<script setup lang="ts">
/**
 * 单个快捷键行（M5-01）。
 *
 * 录制逻辑与阅读器内的面板（`components/reader/SettingsPanel.vue`）一致：
 * 监听在 **capture 阶段**并 `stopImmediatePropagation`，否则录一个「→」会同时翻页。
 *
 * 冲突不在这里解决：`reader.setShortcut` 会返回被谁占用，这里只负责把提示说清楚。
 * 两个入口（阅读器面板 / 设置页）共用同一个 store 方法，键位不会出现两套值。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { comboFromEvent, displayCombo, SHORTCUTS, type ShortcutAction } from '@/reader/keymap'
import { useReaderStore } from '@/stores/reader'
import { pushToast } from '@/lib/toast'

const props = defineProps<{ action: ShortcutAction; label: string }>()

const reader = useReaderStore()
const recording = ref(false)

const defaultCombo = computed(() => SHORTCUTS.find((item) => item.action === props.action)?.primary ?? '')
/** `shortcuts` 里没有的动作显示默认值：store 的语义就是「用户配置覆盖默认」 */
const current = computed(() => reader.shortcuts[props.action] ?? defaultCombo.value)
const isCustom = computed(
  () => reader.shortcuts[props.action] !== undefined && reader.shortcuts[props.action] !== defaultCombo.value
)

function labelOf(action: ShortcutAction): string {
  return SHORTCUTS.find((item) => item.action === action)?.label ?? action
}

function startRecord(): void {
  stopRecord()
  recording.value = true
  window.addEventListener('keydown', capture, true)
}

function stopRecord(): void {
  recording.value = false
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

  const combo = comboFromEvent(event)
  const result = reader.setShortcut(props.action, combo)
  if (!result.ok) {
    // 冲突时不改，并说清被谁占了——否则用户只会觉得「点了没反应」
    pushToast({ level: 'warn', message: `${displayCombo(combo)} 已被「${labelOf(result.conflict)}」占用` })
  }
  stopRecord()
}

function resetOne(): void {
  const result = reader.setShortcut(props.action, defaultCombo.value)
  if (!result.ok) pushToast({ level: 'warn', message: '默认键位已被其它动作占用' })
}

onBeforeUnmount(stopRecord)
</script>

<template>
  <div class="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0">
    <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink/90">{{ label }}</span>
    <button
      type="button"
      class="min-w-[104px] rounded-md border px-2 py-1 text-[11.5px] transition-colors duration-120"
      :class="
        recording
          ? 'border-accent/70 bg-accent/15 text-accent'
          : 'border-line bg-elevated text-dim hover:border-line-strong hover:text-ink'
      "
      data-shortcut-record
      @click="startRecord"
    >
      {{ recording ? '按下新键位…' : displayCombo(current) }}
    </button>
    <button
      v-if="isCustom"
      type="button"
      class="ct-icon-btn h-6 w-6 text-faint"
      title="恢复默认键位"
      data-shortcut-reset
      @click="resetOne"
    >
      <span class="text-[10.5px] leading-none">重置</span>
    </button>
    <span v-else class="h-6 w-6" />
  </div>
</template>
