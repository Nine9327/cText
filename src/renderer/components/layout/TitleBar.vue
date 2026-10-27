<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { windowApi } from '@/api'

const maximized = ref(false)
// 「Dev」角标只在开发服务器下显示。之前是硬编码的，打包后仍然挂着，
// 用户会以为装到了开发版（M0-07 截图时发现）
const isDev = import.meta.env.DEV
let off: (() => void) | undefined

onMounted(() => {
  // 先订阅再取初始值：两次窗口状态变化之间的窗口期不会漏事件
  off = windowApi.onState((s) => (maximized.value = s.maximized))
  windowApi
    .getState()
    .then((s) => (maximized.value = s.maximized))
    .catch(() => undefined)
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
      <span
        v-if="isDev"
        class="rounded border border-line px-1.5 py-px text-[10px] leading-[14px] text-faint"
        >Dev</span
      >
    </div>

    <div class="app-no-drag flex h-full">
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-hover hover:text-ink" title="最小化" @click="windowApi.minimize()">
        <AppIcon name="minimize" :size="14" />
      </button>
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-hover hover:text-ink" :title="maximized ? '还原' : '最大化'" @click="windowApi.toggleMaximize()">
        <AppIcon :name="maximized ? 'restore' : 'maximize'" :size="13" />
      </button>
      <button class="flex w-11 items-center justify-center text-dim transition-colors duration-120 hover:bg-[#c42b1c] hover:text-white" title="关闭" @click="windowApi.close()">
        <AppIcon name="close" :size="14" />
      </button>
    </div>
  </header>
</template>
