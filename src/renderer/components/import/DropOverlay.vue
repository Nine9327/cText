<script setup lang="ts">
/**
 * 全窗拖放高亮（M1-07）。
 *
 * 三个容易被做错的点：
 *
 * 1. **监听器挂在 window 而不是某个元素上**。拖放要覆盖整个窗口（含标题栏），
 *    挂在路由容器里会出现「拖到标题栏上没反应」。
 * 2. **`dragover` 必须 preventDefault**，否则 Chromium 会判定「此处不接受放下」，
 *    根本不会派发 drop——表现为拖进来松手没反应。
 * 3. **覆盖层是 `pointer-events-none`**。它只负责看得见；真正的事件命中交给下层
 *    元素，冒泡到 window 再由这里处理。若让它吃掉指针事件，
 *    dragleave/dragenter 会在覆盖层自己的子元素之间反复触发。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { hasFiles, targetFromDataTransfer } from '@/lib/dnd'
import { useImportStore } from '@/stores/import'

const store = useImportStore()
const active = ref(false)
/** 进入计数：拖过子元素时 leave 与 enter 成对出现，归零才算真的离开窗口 */
let depth = 0

function onEnter(event: DragEvent): void {
  if (!hasFiles(event.dataTransfer)) return
  depth += 1
  active.value = true
}

function onOver(event: DragEvent): void {
  if (!hasFiles(event.dataTransfer)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onLeave(): void {
  // 这里**不能**再判断「是否拖的是文件」：dragleave 事件的 dataTransfer 常常是空的
  // （浏览器不保证把数据带到 leave 上），加了判断就永远退不出高亮态。
  // 反正没在文件拖拽时 depth 本来就是 0，提前返回即可。
  if (!active.value) return
  depth = Math.max(0, depth - 1)
  if (depth === 0) active.value = false
}

function reset(): void {
  depth = 0
  active.value = false
}

function onDrop(event: DragEvent): void {
  if (!hasFiles(event.dataTransfer)) return
  event.preventDefault()
  reset()
  const target = targetFromDataTransfer(event.dataTransfer)
  if (!target) return
  store.open(target.path, target.hint)
}

onMounted(() => {
  window.addEventListener('dragenter', onEnter)
  window.addEventListener('dragover', onOver)
  window.addEventListener('dragleave', onLeave)
  // 拖拽会话被系统取消（按了 Esc、拖到别的应用）时不一定有 dragleave，
  // 兜一层 dragend，否则高亮会一直糊在窗口上
  window.addEventListener('dragend', reset)
  window.addEventListener('drop', onDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onEnter)
  window.removeEventListener('dragover', onOver)
  window.removeEventListener('dragleave', onLeave)
  window.removeEventListener('dragend', reset)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <div
    v-if="active"
    class="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-accent/[0.06] backdrop-blur-[1px]"
    data-drop-overlay
  >
    <div
      class="rounded-xl border-2 border-dashed border-accent/70 bg-app/85 px-8 py-6 text-center shadow-2xl"
      data-drop-hint
    >
      <AppIcon name="import" :size="26" class="mx-auto text-accent" />
      <p class="mt-2.5 text-[13.5px] text-ink">把文件夹拖到这里导入</p>
      <p class="mt-1 text-[11.5px] text-dim">支持 TXT / EPUB，会递归扫描子目录</p>
    </div>
  </div>
</template>
