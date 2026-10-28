<script setup lang="ts">
/**
 * 我的书架总览（/shelves）。
 *
 * 三个动作都在这里闭环：新建 / 重命名 / 删除。删除走二次确认，而且确认框
 * 明确写「书不会被删除」——那才是用户真正担心的事（产品文档 §2.5）。
 *
 * 书架顺序（侧栏拖出来的顺序）原样沿用，这里不再另排：同一个东西在两处
 * 顺序不同，用户会以为自己在看两批数据。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ShelfNameDialog from '@/components/library/ShelfNameDialog.vue'
import { pushToast } from '@/lib/toast'
import { useLibraryStore } from '@/stores/library'
import type { ShelfDTO } from '@shared/dto'

const library = useLibraryStore()
const router = useRouter()

/** 同一个对话框兼作新建与重命名：`editing` 为空即新建 */
const dialogOpen = ref(false)
const editing = ref<ShelfDTO | null>(null)
const removing = ref<ShelfDTO | null>(null)

function openCreate(): void {
  editing.value = null
  dialogOpen.value = true
}

function openRename(shelf: ShelfDTO): void {
  editing.value = shelf
  dialogOpen.value = true
}

async function confirmName(name: string): Promise<void> {
  const target = editing.value
  dialogOpen.value = false
  editing.value = null
  try {
    if (target) {
      await library.renameShelf(target.id, name)
      pushToast({ level: 'info', message: `书架已改名为「${name}」` })
    } else {
      await library.createShelf(name)
      pushToast({ level: 'info', message: `已创建书架「${name}」` })
    }
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '操作失败' })
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value
  removing.value = null
  if (!target) return
  try {
    await library.removeShelf(target.id)
    // 正停在这个书架里就退回总览（继续留在 /shelves/:id 会显示「书架不存在」）
    if (router.currentRoute.value.params['shelfId'] === target.id) void router.push('/shelves')
    pushToast({ level: 'info', message: `已删除书架「${target.name}」，书籍仍保留在书库中` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '删除书架失败' })
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-app">
    <div class="flex h-14 shrink-0 items-center gap-3 px-6">
      <h1 class="text-[15px] font-medium text-ink">我的书架</h1>
      <span class="text-[11.5px] text-faint" data-shelf-total>{{ library.shelves.length }} 个书架</span>
      <button type="button" class="ct-btn ml-auto" data-shelf-create @click="openCreate">
        <AppIcon name="plus" :size="14" />
        新建书架
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-10">
      <div v-if="library.shelves.length > 0" class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        <div
          v-for="shelf in library.shelves"
          :key="shelf.id"
          class="group relative rounded-lg border border-line bg-card transition-colors duration-120 hover:border-line-strong hover:bg-hover"
          data-shelf-card
        >
          <RouterLink :to="`/shelves/${shelf.id}`" class="block p-3.5" :data-shelf-link="shelf.id">
            <div class="flex items-center gap-2.5">
              <span class="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
                <AppIcon name="folder" :size="15" />
              </span>
              <div class="min-w-0 flex-1 pr-12">
                <p class="truncate text-[13px] text-ink" data-shelf-name>{{ shelf.name }}</p>
                <p class="mt-0.5 text-[11px] text-faint" data-shelf-count>{{ shelf.bookCount }} 本</p>
              </div>
            </div>

            <p class="mt-3 line-clamp-1 text-[11.5px] text-faint">
              {{ shelf.bookCount > 0 ? '点击查看书架内容' : '空书架：从书库把书拖到左侧书架即可加入' }}
            </p>
          </RouterLink>

          <!-- 改名 / 删除：hover 才浮现，避免每张卡上钉满图标 -->
          <div class="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition-opacity duration-120 group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              class="ct-icon-btn h-6 w-6 bg-card/80"
              title="重命名"
              aria-label="重命名书架"
              data-shelf-rename
              @click="openRename(shelf)"
            >
              <AppIcon name="settings" :size="12" />
            </button>
            <button
              type="button"
              class="ct-icon-btn h-6 w-6 bg-card/80 hover:text-rose-300"
              title="删除书架（不影响书籍）"
              aria-label="删除书架"
              data-shelf-remove-btn
              @click="removing = shelf"
            >
              <AppIcon name="close" :size="12" />
            </button>
          </div>
        </div>
      </div>

      <EmptyState
        v-else
        icon="folder"
        title="还没有书架"
        desc="书架是「我正在看的一批书」的手动分组，同一本书可以放进多个书架。"
      >
        <button type="button" class="ct-btn" data-shelf-create @click="openCreate">
          <AppIcon name="plus" :size="14" />
          新建书架
        </button>
      </EmptyState>
    </div>

    <ShelfNameDialog
      :open="dialogOpen"
      :title="editing ? '重命名书架' : '新建书架'"
      :initial="editing?.name ?? ''"
      :confirm-text="editing ? '保存' : '创建'"
      @confirm="confirmName"
      @cancel="((dialogOpen = false), (editing = null))"
    />

    <ConfirmDialog
      :open="!!removing"
      title="删除这个书架？"
      :desc="`「${removing?.name ?? ''}」会从侧栏移除。书架里的 ${removing?.bookCount ?? 0} 本书不会被删除，它们的阅读进度也不受影响。`"
      confirm-text="删除书架"
      danger
      @confirm="confirmRemove"
      @cancel="removing = null"
    />
  </div>
</template>
