<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { IconName } from '@/components/common/icons'

defineProps<{
  modelValue: string
  options: { value: string; label: string; icon?: IconName }[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="inline-flex items-center gap-0.5 rounded-md border border-line bg-elevated p-0.5">
    <button
      v-for="option in options"
      :key="option.value"
      class="flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors duration-120"
      :class="
        modelValue === option.value
          ? 'bg-active text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.04)]'
          : 'text-faint hover:text-dim'
      "
      @click="emit('update:modelValue', option.value)"
    >
      <AppIcon v-if="option.icon" :name="option.icon" :size="13" />
      {{ option.label }}
    </button>
  </div>
</template>
