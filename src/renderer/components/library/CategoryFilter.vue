<script setup lang="ts">
/**
 * 分类筛选面板（M3-03）。
 *
 * 与排序、搜索三者**正交**：筛选决定「哪些书」，排序决定「什么顺序」，
 * 搜索决定「哪些关键字」。所以它们各占一个控件，而不是塞进同一个下拉——
 * 一个控件里放两类状态，用户永远不知道自己清掉的是哪一层。
 *
 * 多选之间是 OR（沾一个标签就算命中）：标签的直觉就是「这个词能描述它」，
 * 用 AND 的话勾两个标签时结果几乎必然为空。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useLibraryStore } from '@/stores/library'

const emit = defineEmits<{ (e: 'manage'): void }>()

const library = useLibraryStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const selected = computed(() => library.categoryFilter)
const activeCount = computed(() => selected.value.length)

function toggle(id: string): void {
  const next = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]
  library.setCategoryFilter(next)
}

function clear(): void {
  library.setCategoryFilter([])
  open.value = false
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (rootEl.value && target && rootEl.value.contains(target)) return
  open.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) open.value = false
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
      :class="(open || activeCount > 0) && 'border-line-strong text-ink'"
      aria-haspopup="true"
      :aria-expanded="open"
      aria-label="按分类筛选"
      data-category-trigger
      @click="open = !open"
    >
      <AppIcon name="layers" :size="14" />
      <span data-category-label>{{ activeCount > 0 ? `分类 ${activeCount}` : '分类' }}</span>
      <AppIcon name="chevron-down" :size="12" class="text-faint transition-transform duration-120" :class="open && 'rotate-180'" />
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-[calc(100%+4px)] z-30 w-[228px] rounded-lg border border-line bg-elevated p-1 shadow-[0_10px_28px_rgba(0,0,0,.5)]"
      data-category-panel
    >
      <div class="flex items-center justify-between px-2 pb-1 pt-0.5">
        <p class="text-[10.5px] tracking-wider text-faint">按分类筛选</p>
        <button
          v-if="activeCount > 0"
          type="button"
          class="text-[10.5px] text-accent hover:underline"
          data-category-clear
          @click="clear"
        >
          清除
        </button>
      </div>

      <p v-if="library.categories.length === 0" class="px-2 py-2 text-[11.5px] text-faint">
        还没有分类。点下面的「管理分类」新建。
      </p>

      <div v-else class="max-h-[280px] overflow-y-auto">
        <button
          v-for="category in library.categories"
          :key="category.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink/90 transition-colors duration-120 hover:bg-hover"
          :class="selected.includes(category.id) && 'bg-active'"
          :data-category-option="category.id"
          :data-category-active="selected.includes(category.id) ? '1' : '0'"
          @click="toggle(category.id)"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :style="{ background: category.color ?? '#8b8f98' }"
          />
          <span class="min-w-0 flex-1 truncate">{{ category.name }}</span>
          <span class="text-[10.5px] text-faint">{{ category.bookCount }}</span>
          <AppIcon v-if="selected.includes(category.id)" name="check" :size="12" class="shrink-0 text-accent" />
        </button>
      </div>

      <div class="mt-1 border-t border-line pt-1">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-dim transition-colors duration-120 hover:bg-hover hover:text-ink"
          data-category-manage
          @click="((open = false), emit('manage'))"
        >
          <AppIcon name="settings" :size="12" />
          管理分类…
        </button>
      </div>
    </div>
  </div>
</template>
