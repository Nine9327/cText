<script setup lang="ts">
/**
 * 分类管理（M3-03）：新建 / 改名 / 改色 / 排序 / 删除。
 *
 * 三个约定：
 *   1. 改名与改色都是**失焦或回车才提交**（不是每次按键发一个 IPC）——
 *      分类名是「打一半的状态」最多的字段，逐字提交会让「科幻」一度变成「科」。
 *   2. 删除要二次确认，并且说清「书不会被删除，只是不再带这个标签」。
 *   3. 排序用上移/下移而不是拖拽：分类通常只有十来个，而拖拽在弹出面板里
 *      与「点选分类」的手势冲突（书架那套拖拽是因为书架条目本身就是列表）。
 */
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { pushToast } from '@/lib/toast'
import { useLibraryStore } from '@/stores/library'
import type { CategoryDTO } from '@shared/dto'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const library = useLibraryStore()

const draftName = ref('')
const draftColor = ref('#5b8def')
const removing = ref<CategoryDTO | null>(null)

/** 名称草稿：每行一个，输入时只改本地，提交时才落库 */
const names = ref<Record<string, string>>({})

const categories = computed(() => library.categories)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    draftName.value = ''
    names.value = Object.fromEntries(library.categories.map((item) => [item.id, item.name]))
  },
  { immediate: true }
)

/**
 * 新建的分类也要立刻有名字草稿。
 *
 * 只在打开时初始化会让新行渲染出一个**空输入框**——看起来像「名字没保存成功」，
 * 而且此时失焦会把名字改成空串（rename 里 trim 后为空会回滚，但那是一次无谓往返）。
 */
watch(
  categories,
  (list) => {
    const next = { ...names.value }
    let changed = false
    for (const item of list) {
      if (next[item.id] === undefined) {
        next[item.id] = item.name
        changed = true
      }
    }
    if (changed) names.value = next
  },
  { deep: true }
)

async function create(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) return
  try {
    await library.createCategory(name, draftColor.value)
    draftName.value = ''
    pushToast({ level: 'info', message: `已创建分类「${name}」` })
  } catch (err) {
    // 重名是这里最常见的失败，主进程已经给出「已经有叫 x 的分类了」
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '创建分类失败' })
  }
}

async function rename(category: CategoryDTO): Promise<void> {
  const next = (names.value[category.id] ?? '').trim()
  if (!next || next === category.name) {
    names.value[category.id] = category.name
    return
  }
  try {
    await library.updateCategory(category.id, { name: next })
  } catch (err) {
    names.value[category.id] = category.name
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '改名失败' })
  }
}

async function recolor(category: CategoryDTO, event: Event): Promise<void> {
  const color = (event.target as HTMLInputElement).value
  try {
    await library.updateCategory(category.id, { color })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '改色失败' })
  }
}

/** 上移/下移：交换 sort 后整体重排，避免两条记录撞号 */
async function move(category: CategoryDTO, delta: number): Promise<void> {
  const ids = categories.value.map((item) => item.id)
  const from = ids.indexOf(category.id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return
  ids.splice(from, 1)
  ids.splice(to, 0, category.id)
  try {
    await library.reorderCategories(ids)
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '排序失败' })
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value
  removing.value = null
  if (!target) return
  try {
    await library.removeCategory(target.id)
    pushToast({ level: 'info', message: `已删除分类「${target.name}」，书籍仍保留在书库中` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '删除分类失败' })
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-6"
    data-category-manager
    @click.self="emit('close')"
  >
    <div class="flex max-h-[76vh] w-full max-w-[460px] flex-col rounded-xl border border-line bg-elevated p-5 shadow-2xl">
      <div class="flex items-center justify-between">
        <p class="text-[13.5px] font-medium text-ink">管理分类</p>
        <button type="button" class="ct-icon-btn" title="关闭" aria-label="关闭" data-category-manager-close @click="emit('close')">
          <AppIcon name="close" :size="14" />
        </button>
      </div>

      <!-- 新建 -->
      <div class="mt-4 flex items-center gap-2">
        <input
          v-model="draftName"
          type="text"
          maxlength="20"
          placeholder="新分类名，例如：科幻"
          class="min-w-0 flex-1 rounded-lg border border-line bg-app px-3 py-1.5 text-[12.5px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          data-category-new-name
          @keydown.enter.prevent="create"
        />
        <input
          v-model="draftColor"
          type="color"
          class="h-8 w-8 shrink-0 cursor-pointer rounded border border-line bg-app"
          title="分类颜色"
          data-category-new-color
        />
        <button type="button" class="ct-btn shrink-0" data-category-create @click="create">添加</button>
      </div>

      <!-- 列表 -->
      <div class="mt-3 min-h-0 flex-1 overflow-y-auto">
        <p v-if="categories.length === 0" class="py-6 text-center text-[12px] text-faint">
          还没有分类。分类是题材标签（科幻 / 历史 / 技术），与「书架」不是一回事。
        </p>

        <div
          v-for="(category, index) in categories"
          :key="category.id"
          class="flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-hover"
          data-category-row
          :data-category-id="category.id"
        >
          <input
            type="color"
            :value="category.color ?? '#8b8f98'"
            class="h-6 w-6 shrink-0 cursor-pointer rounded border border-line bg-transparent"
            title="分类颜色"
            data-category-color
            @change="recolor(category, $event)"
          />
          <input
            v-model="names[category.id]"
            type="text"
            maxlength="20"
            class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-ink hover:border-line focus:border-line-strong focus:outline-none"
            data-category-name
            @blur="rename(category)"
            @keydown.enter.prevent="rename(category)"
          />
          <span class="w-10 shrink-0 text-right text-[10.5px] text-faint">{{ category.bookCount }}</span>
          <button
            type="button"
            class="ct-icon-btn h-6 w-6"
            title="上移"
            aria-label="上移"
            :disabled="index === 0"
            data-category-up
            @click="move(category, -1)"
          >
            <AppIcon name="chevron-left" :size="12" class="rotate-90" />
          </button>
          <button
            type="button"
            class="ct-icon-btn h-6 w-6"
            title="下移"
            aria-label="下移"
            :disabled="index === categories.length - 1"
            data-category-down
            @click="move(category, 1)"
          >
            <AppIcon name="chevron-right" :size="12" class="rotate-90" />
          </button>
          <button
            type="button"
            class="ct-icon-btn h-6 w-6 hover:text-rose-300"
            title="删除分类（不影响书籍）"
            aria-label="删除分类"
            data-category-remove
            @click="removing = category"
          >
            <AppIcon name="close" :size="12" />
          </button>
        </div>
      </div>

      <ConfirmDialog
        :open="!!removing"
        title="删除这个分类？"
        :desc="`「${removing?.name ?? ''}」会从筛选器里消失，${removing?.bookCount ?? 0} 本书只是不再带这个标签，书本身与阅读进度都不受影响。`"
        confirm-text="删除分类"
        danger
        @confirm="confirmRemove"
        @cancel="removing = null"
      />
    </div>
  </div>
</template>
