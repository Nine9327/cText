<script setup lang="ts">
/**
 * 侧栏骨架（产品文档 §2.2）：书库切换器 / 全部书籍 / 收藏 / 我的书架 / 网络小说。
 *
 * 五条硬约定：
 *   1. 展开态固定 240px，折叠态 64px 图标栏；宽度过渡 120ms，与全局动效一致。
 *   2. 选中态只有一个：靠 RouterLink 的 active-class 实现，别处不再写"当前项"判断。
 *   3. 分区（我的书架 / 网络小说）的**标题是入口**，右侧箭头才是折叠键。
 *   4. 折叠态不渲染分区明细，五个入口退化成图标按钮（hover 有 title 提示）。
 *   5. 数据全部来自 store，M1 换成真实查询时本文件不用动。
 */
import { computed, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import LibrarySwitcher from '@/components/layout/LibrarySwitcher.vue'
import SidebarSection from '@/components/layout/SidebarSection.vue'
import ShelfNameDialog from '@/components/library/ShelfNameDialog.vue'
import { pushToast } from '@/lib/toast'
import { BOOK_MIME, SHELF_MIME, getDragSource, setDragSource } from '@/lib/drag'
import { useLibraryStore } from '@/stores/library'
import { fixtureSources } from '@/fixture/sources'
import { useUiStore } from '@/stores/ui'

const library = useLibraryStore()
const ui = useUiStore()

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
          <span class="text-[11px] text-faint" data-nav-count>{{ library.books.length }}</span>
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

          <RouterLink
            v-for="shelf in library.shelves"
            :key="shelf.id"
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
            <span class="text-[11px] text-faint">{{ shelf.bookCount }}</span>
          </RouterLink>

          <p v-if="library.shelves.length === 0" class="px-2 py-1 text-[11.5px] text-faint">
            还没有书架
          </p>
        </SidebarSection>

        <SidebarSection
          title="网络小说"
          to="/sources"
          nav="sources"
          :open="ui.isSectionOpen('sources')"
          @toggle="ui.toggleSection('sources')"
        >
          <RouterLink
            v-for="source in fixtureSources"
            :key="source.id"
            :to="`/sources/${source.id}`"
            class="ct-nav-item"
            active-class="ct-nav-item-active"
            data-source-item
          >
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="source.enabled ? 'bg-emerald-500/80' : 'bg-faint/50'"
            />
            <span class="flex-1 truncate">{{ source.name }}</span>
          </RouterLink>

          <p v-if="fixtureSources.length === 0" class="px-2 py-1 text-[11.5px] text-faint">
            还没有导入书源
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
  </aside>
</template>
