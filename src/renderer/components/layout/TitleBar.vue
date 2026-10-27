<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'

const maximized = ref(false)
let off: (() => void) | undefined

const win = () => window.api?.window

onMounted(() => {
  win()
    ?.isMaximized()
    .then((v) => (maximized.value = v))
    .catch(() => undefined)
  off = win()?.onState((s) => (maximized.value = s.maximized))
})

onBeforeUnmount(() => off?.())
</script>

<template>
  <header class="app-drag flex h-9 shrink-0 items-center justify-between border-b border-line bg-app pl-3">
    <div class="flex items-center gap-2">
      <div class="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-accent/90 text-white">
        <AppIcon name="book" :size="11" :stroke="2" />
      </div>
      <span class="text-[12.5px] font-medium text-dim">cText</span>
      <span class="rounded border border-line px-1.5 py-px text-[10px] leading-[14px] text-faint">Dev</span>
    </div>

    <div class="app-no-drag flex h-full">
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-hover hover:text-ink" title="最小化" @click="win()?.minimize()">
        <AppIcon name="minimize" :size="14" />
      </button>
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-hover hover:text-ink" :title="maximized ? '还原' : '最大化'" @click="win()?.toggleMaximize()">
        <AppIcon :name="maximized ? 'restore' : 'maximize'" :size="13" />
      </button>
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-[#c42b1c] hover:text-white" title="关闭" @click="win()?.close()">
        <AppIcon name="close" :size="14" />
      </button>
    </div>
  </header>
</template>
