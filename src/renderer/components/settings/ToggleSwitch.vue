<script setup lang="ts">
/**
 * 开关（M5-01）。
 *
 * 用 `<button role="switch">` 而不是 checkbox：设置页的开关是**立即生效**的动作，
 * 不是表单里的待提交值。role=switch 让读屏软件念出「开/关」，比一个没有文字的
 * checkbox 清楚。禁用态保留在 DOM 里（不是 v-if），位置不会跳。
 */
const props = defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** 无障碍名称：开关旁边通常只有文字标签，读屏软件需要它 */
  label?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-120"
    :class="[
      modelValue
        ? 'border-accent/70 bg-accent/70 hover:bg-accent/80'
        : 'border-line bg-elevated hover:border-line-strong',
      disabled ? 'cursor-not-allowed opacity-45' : ''
    ]"
    data-settings-toggle
    @click="toggle"
  >
    <!--
      `left-0` 不能省：绝对定位元素只写 `top` 时，水平方向的起点取的是**静态位置**，
      而按钮默认会把内容居中，静态位置就落在轨道中间（实测 18px），再叠加
      `translate-x-[18px]` 会把圆点整个推到轨道外面去。
      显式钉住 left-0，位移才有确定的参考点：关 2px、开 20px，两侧各留 2px
      （轨道 w-9 = 36、圆点 w-3.5 = 14，改宽度时这两个位移要一起改）。
    -->
    <span
      class="absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.35)] transition-transform duration-120"
      :class="modelValue ? 'translate-x-[20px]' : 'translate-x-0.5'"
    />
  </button>
</template>
