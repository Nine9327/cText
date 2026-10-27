<script setup lang="ts">
/**
 * Toast 容器。挂在 App 根节点，固定底部居中，不参与布局。
 *
 * 只用 pointer-events-none 包外层、单条 toast 再打开 pointer-events，
 * 这样它不会挡住下面的书籍卡片点击（阅读器里尤其重要）。
 */
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons'
import { dismiss, toasts, type ToastLevel } from '@/lib/toast'

const ICONS: Record<ToastLevel, IconName> = {
  info: 'info',
  warn: 'warning',
  error: 'error'
}

const TONE: Record<ToastLevel, string> = {
  info: 'text-accent',
  warn: 'text-[#e0a13a]',
  error: 'text-[#e5534b]'
}
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
    <TransitionGroup name="ct-toast">
      <div
        v-for="item in toasts"
        :key="item.id"
        data-toast
        :data-toast-level="item.level"
        class="pointer-events-auto flex w-[min(440px,100%)] items-start gap-2.5 rounded-lg border border-line-strong bg-elevated px-3 py-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.45)]"
      >
        <AppIcon :name="ICONS[item.level]" :size="15" :class="['mt-px shrink-0', TONE[item.level]]" />

        <div class="min-w-0 flex-1">
          <p class="break-words text-[12.5px] leading-5 text-ink">{{ item.message }}</p>
          <p v-if="item.code" class="mt-0.5 truncate font-mono text-[10.5px] leading-4 text-faint">
            {{ item.code }}
          </p>
        </div>

        <button
          class="ct-icon-btn -mr-1 h-5 w-5 shrink-0"
          title="关闭"
          aria-label="关闭提示"
          @click="dismiss(item.id)"
        >
          <AppIcon name="close" :size="11" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.ct-toast-enter-active,
.ct-toast-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.ct-toast-enter-from,
.ct-toast-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

.ct-toast-move {
  transition: transform 0.16s ease;
}
</style>
