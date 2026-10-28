<script setup lang="ts">
/**
 * 书签与笔记侧栏（M2-09）。
 *
 * 列表按「章 → 起点偏移」排序（仓储已排好），点一行就跳过去。
 * 备注是行内编辑：点「备注」把这一行变成输入框，保存后立刻落库——
 * 不做弹窗，因为用户往往要一边看原文一边写批注。
 */
import { nextTick, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { BookmarkDTO, ChapterDTO } from '@shared/dto'

const props = defineProps<{
  open: boolean
  items: BookmarkDTO[]
  currentChapter: number
  chapters: ChapterDTO[]
  exporting?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'jump', item: BookmarkDTO): void
  (e: 'save-note', id: string, note: string | null): void
  (e: 'remove', id: string): void
  (e: 'export'): void
}>()

const editingId = ref<string | null>(null)
const draft = ref('')

function chapterLabel(idx: number): string {
  const chapter = props.chapters.find((item) => item.idx === idx)
  return chapter?.title ?? `第 ${idx + 1} 章`
}

async function startEdit(item: BookmarkDTO): Promise<void> {
  editingId.value = item.id
  draft.value = item.note ?? ''
  await nextTick()
  // 直接查 DOM 而不是用模板 ref：ref 写在 v-for 里会变成数组，只有一个元素时也要按下标取，
  // 那是纯粹为了「聚焦一次」而引入的错误面
  document.querySelector<HTMLTextAreaElement>('[data-note-input]')?.focus()
}

function saveNote(item: BookmarkDTO): void {
  const note = draft.value.trim()
  emit('save-note', item.id, note.length > 0 ? note : null)
  editingId.value = null
}
</script>

<template>
  <div v-if="open" class="absolute inset-0 z-20" data-notes-panel>
    <div class="absolute inset-0" @click="emit('close')" />

    <aside
      class="absolute inset-y-0 right-0 flex w-[340px] flex-col border-l border-line bg-sidebar shadow-[-8px_0_24px_rgba(0,0,0,.28)]"
      role="dialog"
      aria-label="书签与笔记"
    >
      <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <AppIcon name="bookmark" :size="14" class="text-faint" />
        <span class="text-[12.5px] text-ink">书签与笔记</span>
        <span class="text-[11.5px] tabular-nums text-faint" data-notes-count>{{ items.length }}</span>
        <span class="flex-1" />
        <button
          class="ct-btn !px-2 !py-1 !text-[11px]"
          data-notes-export
          :disabled="exporting || items.length === 0"
          @click="emit('export')"
        >
          {{ exporting ? '导出中…' : '导出' }}
        </button>
        <button class="ct-icon-btn" title="关闭（Esc）" data-notes-close @click="emit('close')">
          <AppIcon name="close" :size="13" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="items.length === 0" class="px-4 py-10 text-center text-[12px] leading-relaxed text-faint" data-notes-empty>
          选中正文即可划线，按 Ctrl+D 也能给当前位置加书签。
        </p>

        <ul v-else class="divide-y divide-line/60">
          <li
            v-for="item in items"
            :key="item.id"
            class="group px-3 py-2.5 transition-colors duration-120 hover:bg-hover"
            :class="item.chapterIdx === currentChapter && 'bg-hover/50'"
            :data-note-id="item.id"
            :data-note-kind="item.kind"
          >
            <div class="mb-1 flex items-center gap-1.5 text-[10.5px] text-faint">
              <button class="truncate hover:text-dim" :title="chapterLabel(item.chapterIdx)" @click="emit('jump', item)">
                {{ chapterLabel(item.chapterIdx) }}
              </button>
              <span class="shrink-0">·</span>
              <span class="shrink-0 tabular-nums">第 {{ item.offset }} 字</span>
              <span class="flex-1" />
              <button class="opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink" data-note-edit @click="startEdit(item)">
                备注
              </button>
              <button class="opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink" data-note-remove @click="emit('remove', item.id)">
                删除
              </button>
            </div>

            <p
              v-if="item.kind === 'highlight' && item.text"
              class="line-clamp-3 cursor-pointer text-[12px] leading-[1.6] text-dim"
              data-note-text
              @click="emit('jump', item)"
            >
              {{ item.text }}
            </p>
            <p v-else class="cursor-pointer text-[12px] text-faint" @click="emit('jump', item)">书签</p>

            <template v-if="editingId === item.id">
              <textarea
                v-model="draft"
                rows="3"
                class="mt-1.5 w-full resize-none rounded-md border border-line bg-elevated px-2 py-1.5 text-[12px] leading-relaxed text-ink focus:border-line-strong focus:outline-none"
                data-note-input
                @keydown.ctrl.enter="saveNote(item)"
              />
              <div class="mt-1 flex justify-end gap-1.5">
                <button class="ct-btn !px-2 !py-0.5 !text-[11px]" @click="editingId = null">取消</button>
                <button class="ct-btn !px-2 !py-0.5 !text-[11px]" data-note-save @click="saveNote(item)">保存</button>
              </div>
            </template>
            <p v-else-if="item.note" class="mt-1 rounded bg-active/60 px-2 py-1 text-[11.5px] leading-relaxed text-dim" data-note-note>
              {{ item.note }}
            </p>
          </li>
        </ul>
      </div>
    </aside>
  </div>
</template>
