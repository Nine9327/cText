<script setup lang="ts">
/**
 * 设置行（M5-01）：左标题+说明，右控件。
 *
 * 「说明」不是装饰：设置项的名字往往有歧义（「最小化到托盘」对不常用托盘的人
 * 等于没说），一句话写清「打开之后会发生什么」，能省掉大量来回试。
 * 说明可以为空，空时不占高度。
 */
defineProps<{
  label: string
  desc?: string
  /** 纵向排列：右控件会换到下一行（路径、长的说明表格用） */
  stacked?: boolean
}>()
</script>

<template>
  <div
    class="flex gap-4 border-b border-line/60 px-4 py-3 last:border-b-0"
    :class="stacked ? 'flex-col gap-2' : 'items-start'"
    data-settings-row
  >
    <div class="min-w-0 flex-1">
      <p class="text-[12.5px] text-ink">{{ label }}</p>
      <p v-if="desc" class="mt-0.5 text-[11.5px] leading-relaxed text-faint">{{ desc }}</p>
    </div>
    <div :class="stacked ? '' : 'shrink-0 pt-0.5'">
      <slot />
    </div>
  </div>
</template>
