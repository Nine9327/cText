<script setup lang="ts">
/**
 * 侧栏的可折叠分区（我的书架 / 网络小说）。
 *
 * 标题是链接（点标题进分区首页），右侧小箭头单独负责折叠——
 * 这是桌面端常见做法：想进去点名字，想收起点箭头，两者不打架。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'

const props = defineProps<{
  title: string
  /** 分区首页路由；不传则标题不可点 */
  to?: string
  /** 供验收脚本定位入口用（标题链接上的 data-nav） */
  nav?: string
  open: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const route = useRoute()
/** 在这一分区里（含子页面） */
const inSection = computed(() => !!props.to && route.path.startsWith(props.to))
/** 正在分区首页本身 */
const onIndex = computed(() => !!props.to && route.path === props.to)
</script>

<template>
  <section class="mt-4" data-sidebar-section :data-section="nav">
    <div class="flex items-center gap-1 px-2.5">
      <!--
        选中态：分区首页本身 → ct-section-active（text-ink）；
        在子页面（某个书架 / 某个书源）→ 只是 title 变 dim，真正的选中项是那个子项。
        不用 RouterLink 的 exact-active-class，因为它和下面的 text-dim 工具类会打架
        （utilities 层优先级高于 components 层，会把首个选中态的提亮吃掉）。
      -->
      <RouterLink
        v-if="to"
        :to="to"
        class="ct-section-title min-w-0 flex-1 truncate transition-colors duration-120 hover:text-dim"
        :class="onIndex ? 'ct-section-active' : inSection && 'text-dim'"
        :data-nav="nav"
        data-section-link
      >
        {{ title }}
      </RouterLink>
      <span v-else class="ct-section-title min-w-0 flex-1 truncate">{{ title }}</span>

      <slot name="actions" />

      <button
        type="button"
        class="ct-icon-btn h-5 w-5"
        :aria-expanded="open"
        :title="open ? `收起${title}` : `展开${title}`"
        :data-section-toggle="nav"
        @click="emit('toggle')"
      >
        <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="11" />
      </button>
    </div>

    <div v-show="open" class="mt-1 space-y-0.5 px-2.5" data-section-body>
      <slot />
    </div>
  </section>
</template>
