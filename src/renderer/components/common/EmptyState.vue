<script setup lang="ts">
/**
 * 统一空状态。
 *
 * 三种场景共用：列表为空（收藏里一本书都没有）、对象不存在（书架 id 失效）、
 * 功能未接入（网络小说还没导书源）。根节点带 `data-empty` 供验收脚本断言。
 */
import AppIcon from '@/components/common/AppIcon.vue'
import type { IconName } from '@/components/common/icons'

withDefaults(
  defineProps<{
    icon?: IconName
    title: string
    desc?: string
  }>(),
  { icon: 'book', desc: '' }
)
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center" data-empty>
    <div
      class="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-elevated text-faint"
    >
      <AppIcon :name="icon" :size="22" :stroke="1.4" />
    </div>
    <p class="text-[13px] text-dim" data-empty-title>{{ title }}</p>
    <p v-if="desc" class="max-w-[380px] text-[12px] leading-relaxed text-faint">{{ desc }}</p>
    <slot />
  </div>
</template>
