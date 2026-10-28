<script setup lang="ts">
/**
 * 书籍右键菜单（M3-05）。
 *
 * 七项操作对齐产品文档 §2.4：阅读 / 详情 / 收藏 / 加入书架 / 打上分类 /
 * 重新识别 / 从书库移除。
 *
 * 两条约束：
 *   1. 「加入书架」与「打上分类」是**二级列表**而不是弹窗。右键菜单一旦弹窗，
 *      用户就丢掉了「我刚才点的是哪本书」的上下文；就地展开能把目标一直摆在眼前。
 *   2. 这两项是**增量**动作（加上去），不是「设置归属」——批量场景下
 *      「把 500 本都加上科幻」和「把它们的标签全换成科幻」是两件完全不同的事。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { BookDTO, CategoryDTO, ShelfDTO } from '@shared/dto'

const props = defineProps<{
  open: boolean
  x: number
  y: number
  book: BookDTO | null
  shelves: ShelfDTO[]
  categories: CategoryDTO[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'read'): void
  (e: 'detail'): void
  (e: 'favorite'): void
  (e: 'addShelf', shelfId: string): void
  (e: 'addCategory', categoryId: string): void
  (e: 'rematch'): void
  (e: 'remove'): void
}>()

const submenu = ref<'shelf' | 'category' | null>(null)

/** 菜单不能出屏幕：右下角右键时按视口夹回去，否则一半在屏幕外点不到 */
const style = computed(() => ({
  left: `${Math.min(props.x, Math.max(0, window.innerWidth - 220))}px`,
  top: `${Math.min(props.y, Math.max(0, window.innerHeight - 320))}px`
}))

watch(
  () => props.open,
  (open) => {
    if (!open) submenu.value = null
  }
)

function onPointerDown(event: PointerEvent): void {
  if (!props.open) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-book-menu]')) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) emit('close')
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
  <div
    v-if="open && book"
    class="fixed z-[60] w-[208px] rounded-lg border border-line bg-elevated p-1 shadow-[0_12px_32px_rgba(0,0,0,.55)]"
    :style="style"
    data-book-menu
  >
    <template v-if="!submenu">
      <p class="truncate px-2 pb-1 pt-0.5 text-[10.5px] text-faint" data-book-menu-title>{{ book.title }}</p>

      <button type="button" class="ct-menu-item" data-menu-read @click="emit('read')">
        <AppIcon name="book" :size="13" />阅读
      </button>
      <button type="button" class="ct-menu-item" data-menu-detail @click="emit('detail')">
        <AppIcon name="info" :size="13" />书籍详情
      </button>
      <button type="button" class="ct-menu-item" data-menu-favorite @click="emit('favorite')">
        <AppIcon name="star" :size="13" :filled="book.favorite" />
        {{ book.favorite ? '取消收藏' : '收藏' }}
      </button>

      <div class="my-1 h-px bg-line" />

      <button type="button" class="ct-menu-item" data-menu-shelf @click="submenu = 'shelf'">
        <AppIcon name="folder" :size="13" />加入书架
        <AppIcon name="chevron-right" :size="12" class="ml-auto text-faint" />
      </button>
      <button type="button" class="ct-menu-item" data-menu-category @click="submenu = 'category'">
        <AppIcon name="layers" :size="13" />打上分类
        <AppIcon name="chevron-right" :size="12" class="ml-auto text-faint" />
      </button>

      <div class="my-1 h-px bg-line" />

      <button type="button" class="ct-menu-item" data-menu-rematch @click="emit('rematch')">
        <AppIcon name="search" :size="13" />重新识别
      </button>
      <button type="button" class="ct-menu-item hover:text-rose-300" data-menu-remove @click="emit('remove')">
        <AppIcon name="close" :size="13" />从书库移除
      </button>
    </template>

    <template v-else>
      <button
        type="button"
        class="ct-menu-item text-dim"
        data-menu-back
        @click="submenu = null"
      >
        <AppIcon name="chevron-left" :size="13" />{{ submenu === 'shelf' ? '加入书架' : '打上分类' }}
      </button>
      <div class="my-1 h-px bg-line" />

      <template v-if="submenu === 'shelf'">
        <button
          v-for="shelf in shelves"
          :key="shelf.id"
          type="button"
          class="ct-menu-item"
          :data-menu-shelf-option="shelf.id"
          @click="emit('addShelf', shelf.id)"
        >
          <AppIcon name="folder" :size="12" class="text-faint" />
          <span class="min-w-0 flex-1 truncate">{{ shelf.name }}</span>
        </button>
        <p v-if="shelves.length === 0" class="px-2 py-2 text-[11.5px] text-faint">还没有书架</p>
      </template>

      <template v-else>
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="ct-menu-item"
          :data-menu-category-option="category.id"
          @click="emit('addCategory', category.id)"
        >
          <span class="h-1.5 w-1.5 rounded-full" :style="{ background: category.color ?? '#8b8f98' }" />
          <span class="min-w-0 flex-1 truncate">{{ category.name }}</span>
        </button>
        <p v-if="categories.length === 0" class="px-2 py-2 text-[11.5px] text-faint">还没有分类</p>
      </template>
    </template>
  </div>
</template>
