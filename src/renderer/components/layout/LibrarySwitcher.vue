<script setup lang="ts">
/**
 * 书库切换器（侧栏顶部）。
 *
 * 行为对齐产品文档 §2.2「书库 ▾ 下拉可切换书库根目录（或全部根目录），
 * 切换后主区列表随之过滤」：
 *   - 选中项打勾，离线根目录带灰点与「离线」标记（§2.3）
 *   - 点面板外 / Esc / 再次点触发器都关闭
 *   - 打开时焦点在触发器上，方向键不上，但选项是原生 button，Tab + Enter 可用
 *
 * 面板用绝对定位挂在触发器下方，不用 teleport：侧栏本身没有 overflow 裁剪
 * （滚动只发生在中间那段），所以不会被切掉。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useLibraryStore } from '@/stores/library'

const store = useLibraryStore()

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const current = computed(() => store.activeRoot)
const currentCount = computed(() => store.rootCount(store.activeRootId))

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

function select(rootId: string): void {
  store.selectRoot(rootId)
  close()
}

/** 捕获阶段监听：面板内的点击不会被误判成"点外面" */
function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (rootEl.value && target && rootEl.value.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    close()
    // Esc 关闭后把焦点还给触发器，键盘用户不会迷路
    rootEl.value?.querySelector<HTMLElement>('[data-library-switcher]')?.focus()
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
      class="flex w-full items-center gap-2.5 rounded-lg border border-line bg-elevated px-2.5 py-2 text-left transition-colors duration-120 hover:border-line-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong"
      :class="open && 'border-line-strong'"
      aria-haspopup="listbox"
      :aria-expanded="open"
      aria-label="切换书库"
      data-library-switcher
      @click="toggle"
    >
      <span class="flex h-7 w-7 items-center justify-center rounded-md bg-accent/15 text-accent">
        <AppIcon name="book" :size="14" />
      </span>
      <span class="min-w-0 flex-1 leading-tight">
        <span class="block truncate text-[13px] text-ink" data-root-label>{{ current.label }}</span>
        <span class="block truncate text-[11px] text-faint">
          <span v-if="!current.online" class="text-amber-400/90">离线 · </span>{{ currentCount }} 本
        </span>
      </span>
      <AppIcon
        name="chevron-down"
        :size="14"
        class="text-faint transition-transform duration-120"
        :class="open && 'rotate-180'"
      />
    </button>

    <div
      v-if="open"
      class="absolute inset-x-0 top-[calc(100%+4px)] z-30 rounded-lg border border-line bg-elevated p-1 shadow-[0_10px_28px_rgba(0,0,0,.5)]"
      role="listbox"
      aria-label="选择书库"
      data-root-panel
    >
      <p class="px-2 pb-1 pt-0.5 text-[10.5px] tracking-wider text-faint">书库根目录</p>

      <button
        v-for="root in store.roots"
        :key="root.id"
        type="button"
        role="option"
        :aria-selected="root.id === store.activeRootId"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-120 hover:bg-hover"
        :class="root.id === store.activeRootId && 'bg-active'"
        data-root-option
        :data-root-id="root.id"
        @click="select(root.id)"
      >
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="root.online ? 'bg-emerald-500/80' : 'bg-amber-500/70'"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[12.5px] text-ink/90">{{ root.label }}</span>
          <span class="block truncate text-[10.5px] text-faint">
            {{ root.path || '所有已登记目录' }}
          </span>
        </span>
        <span class="shrink-0 text-[11px] text-faint">{{ store.rootCount(root.id) }}</span>
        <AppIcon
          v-if="root.id === store.activeRootId"
          name="check"
          :size="12"
          class="shrink-0 text-accent"
        />
      </button>

      <div class="mt-1 border-t border-line pt-1">
        <RouterLink
          to="/settings"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-dim transition-colors duration-120 hover:bg-hover hover:text-ink"
          data-root-manage
          @click="close"
        >
          <AppIcon name="folder" :size="13" />
          管理书库根目录
        </RouterLink>
      </div>
    </div>
  </div>
</template>
