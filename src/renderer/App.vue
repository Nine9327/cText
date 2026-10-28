<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ToastHost from '@/components/common/ToastHost.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import Sidebar from '@/components/layout/Sidebar.vue'
import DropOverlay from '@/components/import/DropOverlay.vue'
import ImportDialog from '@/components/import/ImportDialog.vue'

const route = useRoute()
/** 阅读器等页面按「沉浸」处理：收起侧栏，把宽度全部让给正文 */
const immersive = computed(() => route.meta['immersive'] === true)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-app text-ink">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <Sidebar v-if="!immersive" />
      <main class="min-w-0 flex-1">
        <RouterView />
      </main>
    </div>
    <!-- 两者都在最外层：拖放要覆盖整个窗口（含标题栏），面板要盖在所有内容之上 -->
    <DropOverlay />
    <ImportDialog />
    <ToastHost />
  </div>
</template>
