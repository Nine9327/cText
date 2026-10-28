<script setup lang="ts">
/**
 * 排序菜单（M1-09）。
 *
 * 五种排序对齐产品文档 §2.1「书籍排序（最近阅读 / 导入时间 / 书名 / 作者 / 进度）」。
 * 每种排序带**固定方向**（书名/作者升序，时间/进度倒序），不提供「再点一次反转」：
 * 用户看的是「按什么排」，不是「按什么方向排」——反序对这个产品没有使用场景，
 * 多一个方向开关只会让按钮和面板都需要两处状态。
 *
 * 交互与 LibrarySwitcher 一致：点面板外 / Esc / 再点触发器都关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useLibraryStore } from '@/stores/library'
import type { BookSort } from '@shared/dto'

interface SortPreset extends BookSort {
  label: string
}

const PRESETS: SortPreset[] = [
  { field: 'lastReadAt', direction: 'desc', label: '最近阅读' },
  { field: 'createdAt', direction: 'desc', label: '导入时间' },
  { field: 'title', direction: 'asc', label: '书名' },
  { field: 'author', direction: 'asc', label: '作者' },
  { field: 'progress', direction: 'desc', label: '阅读进度' }
]

/**
 * 「架内顺序」（M3-02）只在书架页出现。
 *
 * 别的页面没有 `shelfId`，选它等于选了一个无意义的排序（仓储会退回导入时间）。
 * 反过来在书架页里它是**唯一能回到拖拽结果**的入口，所以不能因为
 * 「用户选了书名」就把它藏起来——`shelf` 由调用方按路由给，不看当前选中项。
 */
const SHELF_PRESET: SortPreset = { field: 'shelfOrder', direction: 'asc', label: '架内顺序' }

const props = defineProps<{ shelf?: boolean }>()

const library = useLibraryStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const presets = computed<SortPreset[]>(() => (props.shelf ? [SHELF_PRESET, ...PRESETS] : PRESETS))

const current = computed<SortPreset>(
  () =>
    presets.value.find(
      (preset) => preset.field === library.sort.field && preset.direction === library.sort.direction
    ) ?? (PRESETS[1] as SortPreset)
)

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

function select(preset: SortPreset): void {
  library.setSort({ field: preset.field, direction: preset.direction })
  close()
}

function isActive(preset: SortPreset): boolean {
  return preset.field === library.sort.field && preset.direction === library.sort.direction
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (rootEl.value && target && rootEl.value.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    close()
    rootEl.value?.querySelector<HTMLElement>('[data-sort-trigger]')?.focus()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      type="button"
      class="ct-btn"
      :class="open && 'border-line-strong'"
      aria-haspopup="listbox"
      :aria-expanded="open"
      aria-label="书籍排序"
      data-sort-trigger
      @click="toggle"
    >
      <AppIcon name="sort" :size="14" />
      <span data-sort-label>{{ current.label }}</span>
      <AppIcon
        name="chevron-down"
        :size="12"
        class="text-faint transition-transform duration-120"
        :class="open && 'rotate-180'"
      />
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-[calc(100%+4px)] z-30 w-[168px] rounded-lg border border-line bg-elevated p-1 shadow-[0_10px_28px_rgba(0,0,0,.5)]"
      role="listbox"
      aria-label="选择排序方式"
      data-sort-panel
    >
      <p class="px-2 pb-1 pt-0.5 text-[10.5px] tracking-wider text-faint">书籍排序</p>
      <button
        v-for="preset in presets"
        :key="preset.field"
        type="button"
        role="option"
        :aria-selected="isActive(preset)"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink/90 transition-colors duration-120 hover:bg-hover"
        :class="isActive(preset) && 'bg-active'"
        data-sort-option
        :data-sort-field="preset.field"
        @click="select(preset)"
      >
        <span class="min-w-0 flex-1 truncate">{{ preset.label }}</span>
        <AppIcon v-if="isActive(preset)" name="check" :size="12" class="shrink-0 text-accent" />
      </button>
    </div>
  </div>
</template>
