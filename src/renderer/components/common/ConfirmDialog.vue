<script setup lang="ts">
/**
 * 二次确认对话框（M3-02）。
 *
 * 产品文档 §2.5 的硬约束：**删除类操作必须二次确认**，且确认框要说清
 * 「删的是什么、什么不会被删」。后一句比前一句重要——用户怕的往往不是
 * 点了删除，而是不知道删完之后会连带丢掉什么。
 *
 * 不用原生 `dialog.showMessageBox`：那是系统模态，验收里点不到（M2-11 已经
 * 为「选目录」付过一次替换 API 的代价），而且无法跟随应用的配色。
 */
import AppIcon from '@/components/common/AppIcon.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    desc?: string
    /** 危险操作的确认键文案用动词（「删除书架」），不要用「确定」 */
    confirmText?: string
    danger?: boolean
  }>(),
  { desc: '', confirmText: '确定', danger: false }
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
    data-confirm-dialog
    @click.self="emit('cancel')"
  >
    <div class="w-full max-w-[380px] rounded-xl border border-line bg-elevated p-5 shadow-2xl">
      <div class="flex items-start gap-2.5">
        <span
          class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          :class="danger ? 'bg-rose-500/15 text-rose-400' : 'bg-accent/15 text-accent'"
        >
          <AppIcon :name="danger ? 'warning' : 'info'" :size="14" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[13.5px] font-medium text-ink" data-confirm-title>{{ title }}</p>
          <p v-if="desc" class="mt-1.5 text-[12px] leading-relaxed text-dim">{{ desc }}</p>
        </div>
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="ct-btn" data-confirm-cancel @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="ct-btn"
          :class="danger ? 'border-rose-500/40 text-rose-300 hover:border-rose-400 hover:text-rose-200' : 'border-accent/40 text-accent'"
          data-confirm-ok
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>
