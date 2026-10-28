<script setup lang="ts">
/**
 * 书架命名对话框（M3-02）：新建与重命名共用一个。
 *
 * 两个细节值得留在这里：
 *   - 打开时自动聚焦并全选（重命名场景下用户十有八九要整段替换）；
 *   - 空名不提交、超长截断在 40 字（与 `shelves:create` 的 zod schema 同口径）。
 *     把「  」这种纯空白存进去，侧栏会出现一行看不见的空书架。
 */
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{ open: boolean; title: string; initial?: string; confirmText?: string }>()
const emit = defineEmits<{ (e: 'confirm', name: string): void; (e: 'cancel'): void }>()

const value = ref(props.initial ?? '')
const inputEl = ref<HTMLInputElement | null>(null)
const error = ref('')

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    value.value = props.initial ?? ''
    error.value = ''
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  },
  { immediate: true }
)

function submit(): void {
  const name = value.value.trim()
  if (!name) {
    error.value = '书架名不能为空'
    inputEl.value?.focus()
    return
  }
  if (name.length > 40) {
    error.value = '书架名最多 40 字'
    return
  }
  emit('confirm', name)
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
    data-shelf-dialog
    @click.self="emit('cancel')"
  >
    <div class="w-full max-w-[380px] rounded-xl border border-line bg-elevated p-5 shadow-2xl">
      <p class="text-[13.5px] font-medium text-ink" data-shelf-dialog-title>{{ title }}</p>
      <input
        ref="inputEl"
        v-model="value"
        type="text"
        maxlength="40"
        placeholder="例如：睡前读物"
        class="mt-3 w-full rounded-lg border border-line bg-app px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
        data-shelf-name-input
        @keydown.enter.prevent="submit"
        @keydown.esc.prevent="emit('cancel')"
      />
      <p v-if="error" class="mt-1.5 text-[11.5px] text-rose-400" data-shelf-name-error>{{ error }}</p>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="ct-btn" data-shelf-dialog-cancel @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="ct-btn border-accent/40 text-accent hover:border-accent"
          data-shelf-dialog-ok
          @click="submit"
        >
          {{ confirmText ?? '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>
