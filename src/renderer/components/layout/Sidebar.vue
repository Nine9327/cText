<script setup lang="ts">
/**
 * 侧栏骨架（产品文档 §2.2）：书库切换器 / 全部书籍 / 收藏 / 我的书架 / 网络小说。
 *
 * 四条硬约定：
 *   1. 展开态固定 240px，折叠态 64px 图标栏；宽度过渡 120ms，与全局动效一致。
 *   2. 选中态只有一个：靠 RouterLink 的 active-class 实现，别处不再写"当前项"判断。
 *   3. 分区（我的书架）的**标题是入口**，右侧箭头才是折叠键。
 *   4. 折叠态不渲染分区明细，入口退化成图标按钮（hover 有 title 提示）。
 *   5. 数据全部来自 store，M1 换成真实查询时本文件不用动。
 *
 * **「设置」入口在底部**（M5-01 交付后放开）：它不属于「浏览书」这条主线，
 * 放在书库/收藏/书架/网络小说之后、紧贴侧栏底部，符合「设置是低频入口」的定位。
 * 折叠态给一个齿轮图标，与展开态同一个路由。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import LibrarySwitcher from '@/components/layout/LibrarySwitcher.vue'
import SidebarSection from '@/components/layout/SidebarSection.vue'
import ShelfNameDialog from '@/components/library/ShelfNameDialog.vue'
import { pushToast } from '@/lib/toast'
import { BOOK_MIME, SHELF_MIME, getDragSource, setDragSource } from '@/lib/drag'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { ShelfDTO } from '@shared/dto'

const library = useLibraryStore()
const ui = useUiStore()
const router = useRouter()

const collapsed = computed(() => ui.state.sidebarCollapsed)

// ---------------------------------------------------------------- 书架（M3-02）

/** 拖拽用的自有 MIME：与文件拖放（OS 给的 Files）区分开，互不干扰 */
const creating = ref(false)
/** 当前被拖到哪个书架上方：只做视觉提示，落点由 drop 决定 */
const hoverShelfId = ref<string | null>(null)

function createShelf(): void {
  creating.value = true
}

async function confirmCreate(name: string): Promise<void> {
  creating.value = false
  try {
    await library.createShelf(name)
    pushToast({ level: 'info', message: `已创建书架「${name}」` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '创建书架失败' })
  }
}

/** 书库/收藏页的书卡拖到书架条目上 = 加入书架 */
async function onShelfDrop(event: DragEvent, shelfId: string): Promise<void> {
  hoverShelfId.value = null
  if (!event.dataTransfer) return
  const bookId = getDragSource('book')
  const movedShelf = getDragSource('shelf')

  try {
    if (bookId) {
      const shelf = library.shelves.find((item) => item.id === shelfId)
      const { added } = await library.addToShelf(shelfId, [bookId])
      pushToast(
        added > 0
          ? { level: 'info', message: `已加入书架「${shelf?.name ?? ''}」` }
          : { level: 'info', message: `这本书已经在「${shelf?.name ?? ''}」里了` }
      )
      return
    }
    if (movedShelf && movedShelf !== shelfId) {
      const ids = library.shelves.map((item) => item.id)
      const from = ids.indexOf(movedShelf)
      const to = ids.indexOf(shelfId)
      if (from >= 0 && to >= 0) {
        ids.splice(from, 1)
        ids.splice(to, 0, movedShelf)
        await library.reorderShelves(ids)
      }
    }
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '书架操作失败' })
  }
}

/** 只允许「书」与「书架」两种拖拽进入，避免文件拖放把书架条目点亮 */
function acceptDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? []
  return types.includes(BOOK_MIME) || types.includes(SHELF_MIME)
}

// ---------------------------------------------------------------- 书架菜单

/**
 * 侧栏书架条目的重命名 / 删除（M3-02 补齐）。
 *
 * 总览页的卡片只在 hover 时露出两个小图标，站到侧栏想处理一个书架时没路可走；
 * 这里是同一批操作的第二个入口，右键与「⋯」按钮都打开同一份菜单。
 *
 * 删除仍然只解分组（`shelves:remove` 只删 shelves 行，书一行不动），
 * 确认框文案照旧把「书不会被删」写在最前面。
 */
const shelfMenu = ref<{ x: number; y: number; shelf: ShelfDTO } | null>(null)
const renamingShelf = ref<ShelfDTO | null>(null)
const removingShelf = ref<ShelfDTO | null>(null)

/** 菜单不能出屏幕：靠近底部的书架右键时按视口夹回去 */
const shelfMenuStyle = computed(() => ({
  left: `${Math.min(shelfMenu.value?.x ?? 0, Math.max(0, window.innerWidth - 180))}px`,
  top: `${Math.min(shelfMenu.value?.y ?? 0, Math.max(0, window.innerHeight - 96))}px`
}))

function openShelfMenu(event: MouseEvent, shelf: ShelfDTO): void {
  event.preventDefault()
  shelfMenu.value = { x: event.clientX, y: event.clientY, shelf }
}

function closeShelfMenu(): void {
  shelfMenu.value = null
}

function onMenuPointerDown(event: PointerEvent): void {
  if (shelfMenu.value === null) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-shelf-menu]')) return
  closeShelfMenu()
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && shelfMenu.value !== null) closeShelfMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onMenuPointerDown, true)
  document.addEventListener('keydown', onMenuKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onMenuPointerDown, true)
  document.removeEventListener('keydown', onMenuKeydown)
})

function startRename(shelf: ShelfDTO): void {
  closeShelfMenu()
  renamingShelf.value = shelf
}

async function confirmRename(name: string): Promise<void> {
  const target = renamingShelf.value
  renamingShelf.value = null
  if (!target) return
  try {
    await library.renameShelf(target.id, name)
    pushToast({ level: 'info', message: `书架已改名为「${name}」` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '重命名书架失败' })
  }
}

function startRemove(shelf: ShelfDTO): void {
  closeShelfMenu()
  removingShelf.value = shelf
}

async function confirmRemove(): Promise<void> {
  const target = removingShelf.value
  removingShelf.value = null
  if (!target) return
  try {
    // 正在看的这个书架被删掉：路由还指着它就会显示「书架不存在」
    const viewing = router.currentRoute.value.params['shelfId'] === target.id
    await library.removeShelf(target.id)
    if (viewing) void router.push('/shelves')
    pushToast({ level: 'info', message: `已删除书架「${target.name}」，书籍仍保留在书库中` })
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : '删除书架失败' })
  }
}
</script>

<template>
  <aside
    class="flex shrink-0 flex-col border-r border-line bg-sidebar transition-[width] duration-120"
    :class="collapsed ? 'w-16' : 'w-[240px]'"
    data-sidebar
    :data-collapsed="collapsed ? '1' : '0'"
  >
    <!-- ---------------------------------------------------------------- 展开态 -->
    <template v-if="!collapsed">
      <div class="p-2.5">
        <LibrarySwitcher />
      </div>

      <nav class="space-y-0.5 px-2.5" aria-label="书库视图">
        <RouterLink to="/library" class="ct-nav-item" active-class="ct-nav-item-active" data-nav="library">
          <AppIcon name="book" :size="15" />
          <span class="flex-1 truncate">全部书籍</span>
          <span class="text-[11px] text-faint" data-nav-count>{{ library.allCount }}</span>
        </RouterLink>
        <RouterLink
          to="/favorites"
          class="ct-nav-item"
          active-class="ct-nav-item-active"
          data-nav="favorites"
        >
          <AppIcon name="star" :size="15" />
          <span class="flex-1 truncate">收藏的书籍</span>
          <span class="text-[11px] text-faint" data-fav-count>{{ library.favCount }}</span>
        </RouterLink>
        <RouterLink to="/sources" class="ct-nav-item" active-class="ct-nav-item-active" data-nav="sources">
          <AppIcon name="globe" :size="15" />
          <span class="flex-1 truncate">网络小说</span>
        </RouterLink>
      </nav>

      <!-- 可滚动的分区区：书架与书源数量都可能很长，底部操作区固定 -->
      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        <SidebarSection
          title="我的书架"
          to="/shelves"
          nav="shelves"
          :open="ui.isSectionOpen('shelves')"
          @toggle="ui.toggleSection('shelves')"
        >
          <template #actions>
            <button
              type="button"
              class="ct-icon-btn h-5 w-5"
              title="新建书架"
              data-shelf-create
              @click="createShelf"
            >
              <AppIcon name="plus" :size="13" />
            </button>
          </template>

          <!-- 条目本身可点、可拖；右侧「⋯」与右键都能打开同一份书架菜单 -->
          <div
            v-for="shelf in library.shelves"
            :key="shelf.id"
            class="group relative"
            data-shelf-row
            @contextmenu="openShelfMenu($event, shelf)"
          >
            <RouterLink
              :to="`/shelves/${shelf.id}`"
              class="ct-nav-item"
              :class="hoverShelfId === shelf.id && 'ring-1 ring-inset ring-accent/60'"
              active-class="ct-nav-item-active"
              draggable="true"
              data-shelf-item
              @dragstart="
                (event) => {
                  setDragSource({ kind: 'shelf', id: shelf.id })
                  event.dataTransfer?.setData(SHELF_MIME, shelf.id)
                  hoverShelfId = null
                }
              "
              @dragover.prevent="acceptDrag($event) && (hoverShelfId = shelf.id)"
              @dragleave="hoverShelfId === shelf.id && (hoverShelfId = null)"
              @drop.prevent="onShelfDrop($event, shelf.id)"
            >
              <AppIcon name="folder" :size="14" class="text-faint" />
              <span class="flex-1 truncate">{{ shelf.name }}</span>
              <span class="text-[11px] text-faint transition-opacity duration-120 group-hover:opacity-0">
                {{ shelf.bookCount }}
              </span>
            </RouterLink>

            <!-- 计数在 hover 时让位给这个按钮：两者都要占右边缘，叠着会互相盖住 -->
            <button
              type="button"
              class="ct-icon-btn absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity duration-120 focus-visible:opacity-100 group-hover:opacity-100"
              title="书架操作"
              aria-label="书架操作"
              data-shelf-more
              @click.stop="openShelfMenu($event, shelf)"
            >
              <AppIcon name="drag" :size="12" />
            </button>
          </div>

          <p v-if="library.shelves.length === 0" class="px-2 py-1 text-[11.5px] text-faint">
            还没有书架
          </p>
        </SidebarSection>
      </div>

      <div class="flex items-center gap-1 border-t border-line p-2.5">
        <RouterLink
          to="/settings"
          class="ct-nav-item min-w-0 flex-1"
          active-class="ct-nav-item-active"
          data-nav="settings"
        >
          <AppIcon name="settings" :size="15" />
          <span class="flex-1 truncate">设置</span>
        </RouterLink>
        <button
          type="button"
          class="ct-icon-btn"
          title="收起侧栏"
          aria-label="收起侧栏"
          data-sidebar-toggle
          @click="ui.toggleSidebar()"
        >
          <AppIcon name="chevron-left" :size="14" />
        </button>
      </div>
    </template>

    <!-- ---------------------------------------------------------------- 折叠态 -->
    <template v-else>
      <div class="flex flex-col items-center gap-1 py-2.5">
        <button
          type="button"
          class="ct-rail-item text-accent"
          title="展开侧栏以切换书库"
          aria-label="展开侧栏以切换书库"
          data-rail-switcher
          @click="ui.setSidebarCollapsed(false)"
        >
          <AppIcon name="book" :size="16" />
        </button>
      </div>

      <nav class="flex flex-col items-center gap-1 px-2" aria-label="书库视图">
        <RouterLink
          to="/library"
          class="ct-rail-item"
          active-class="ct-rail-item-active"
          title="全部书籍"
          aria-label="全部书籍"
          data-nav="library"
        >
          <AppIcon name="book" :size="16" />
        </RouterLink>
        <RouterLink
          to="/favorites"
          class="ct-rail-item"
          active-class="ct-rail-item-active"
          title="收藏的书籍"
          aria-label="收藏的书籍"
          data-nav="favorites"
        >
          <AppIcon name="star" :size="16" />
        </RouterLink>
        <RouterLink
          to="/shelves"
          class="ct-rail-item"
          active-class="ct-rail-item-active"
          title="我的书架"
          aria-label="我的书架"
          data-nav="shelves"
        >
          <AppIcon name="folder" :size="16" />
        </RouterLink>
        <RouterLink
          to="/sources"
          class="ct-rail-item"
          active-class="ct-rail-item-active"
          title="网络小说"
          aria-label="网络小说"
          data-nav="sources"
        >
          <AppIcon name="globe" :size="16" />
        </RouterLink>
      </nav>

      <div class="mt-auto flex flex-col items-center gap-1 border-t border-line px-2 py-2.5">
        <RouterLink
          to="/settings"
          class="ct-rail-item"
          active-class="ct-rail-item-active"
          title="设置"
          aria-label="设置"
          data-nav="settings"
        >
          <AppIcon name="settings" :size="16" />
        </RouterLink>
        <button
          type="button"
          class="ct-rail-item"
          title="展开侧栏"
          aria-label="展开侧栏"
          data-sidebar-toggle
          @click="ui.toggleSidebar()"
        >
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </div>
    </template>

    <ShelfNameDialog
      :open="creating"
      title="新建书架"
      confirm-text="创建"
      @confirm="confirmCreate"
      @cancel="creating = false"
    />

    <!-- 书架菜单：右键与「⋯」共用，位置跟随鼠标并夹在视口内 -->
    <div
      v-if="shelfMenu !== null"
      class="fixed z-[60] w-[172px] rounded-lg border border-line bg-elevated p-1 shadow-[0_12px_32px_rgba(0,0,0,.55)]"
      :style="shelfMenuStyle"
      data-shelf-menu
    >
      <p class="truncate px-2 pb-1 pt-0.5 text-[10.5px] text-faint" data-shelf-menu-title>
        {{ shelfMenu.shelf.name }}
      </p>
      <button type="button" class="ct-menu-item" data-shelf-menu-rename @click="startRename(shelfMenu.shelf)">
        <AppIcon name="settings" :size="13" />重命名
      </button>
      <button
        type="button"
        class="ct-menu-item hover:text-rose-300"
        data-shelf-menu-remove
        @click="startRemove(shelfMenu.shelf)"
      >
        <AppIcon name="close" :size="13" />删除书架
      </button>
    </div>

    <ShelfNameDialog
      :open="renamingShelf !== null"
      title="重命名书架"
      :initial="renamingShelf?.name ?? ''"
      confirm-text="保存"
      @confirm="confirmRename"
      @cancel="renamingShelf = null"
    />

    <ConfirmDialog
      :open="removingShelf !== null"
      title="删除这个书架？"
      :desc="`「${removingShelf?.name ?? ''}」会从侧栏移除。书架里的 ${removingShelf?.bookCount ?? 0} 本书不会被删除，它们仍留在书库中，阅读进度也不受影响。`"
      confirm-text="删除书架"
      danger
      @confirm="confirmRemove"
      @cancel="removingShelf = null"
    />
  </aside>
</template>
