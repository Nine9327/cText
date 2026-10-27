<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/components/common/AppIcon.vue'
import type { IconName } from '@/components/common/icons'

const route = useRoute()

const icon = computed<IconName>(() => (route.meta.icon as IconName) ?? 'detail')
const title = computed(() => (route.meta.title as string) ?? '未命名页面')
const desc = computed(() => (route.meta.desc as string) ?? '')
const task = computed(() => (route.meta.task as string) ?? '')
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-app px-8 text-center">
    <div class="flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-elevated text-faint">
      <AppIcon :name="icon" :size="24" :stroke="1.4" />
    </div>

    <div class="space-y-1.5">
      <h1 class="text-[15px] font-medium text-ink">{{ title }}</h1>
      <p v-if="desc" class="max-w-[420px] text-[12.5px] leading-relaxed text-faint">{{ desc }}</p>
    </div>

    <span v-if="task" class="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11px] text-dim">
      计划任务 {{ task }}
    </span>

    <p class="text-[11px] text-faint/70">UI 骨架阶段：布局与入口已就位，业务逻辑未接入</p>
  </div>
</template>
