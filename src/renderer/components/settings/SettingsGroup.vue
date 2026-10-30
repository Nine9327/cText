<script setup lang="ts">
/**
 * 设置分组卡片（M5-01）。
 *
 * 每个分组 = 一个 `<section>` + 标题 + 一句话说明 + 若干行。不用手风琴：
 * 设置项总数不到 30 个，折叠起来反而让用户多一次点击才能找到东西。
 */
defineProps<{ title: string; desc?: string }>()
</script>

<template>
  <section class="rounded-xl border border-line bg-card">
    <header class="border-b border-line px-4 py-2.5">
      <h2 class="text-[13px] font-medium text-ink">{{ title }}</h2>
      <p v-if="desc" class="mt-0.5 text-[11.5px] leading-relaxed text-faint">{{ desc }}</p>
    </header>
    <div>
      <slot />
    </div>
    <footer v-if="$slots.footer" class="border-t border-line px-4 py-2.5">
      <slot name="footer" />
    </footer>
  </section>
</template>
