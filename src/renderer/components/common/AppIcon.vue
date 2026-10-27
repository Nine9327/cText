<script setup lang="ts">
import { computed } from 'vue'
import { iconPaths, type IconName } from './icons'

const props = withDefaults(
  defineProps<{
    name: IconName
    size?: number
    stroke?: number
    filled?: boolean
  }>(),
  { size: 16, stroke: 1.6, filled: false }
)

const d = computed(() => iconPaths[props.name])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path :d="d" />
  </svg>
</template>
