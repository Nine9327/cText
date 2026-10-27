<script setup lang="ts">
import TitleBar from '@/components/layout/TitleBar.vue'
import Sidebar from '@/components/layout/Sidebar.vue'
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-app text-ink">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <Sidebar />
      <main class="min-w-0 flex-1">
        <RouterView />
      </main>
    </div>
  </div>
</template>
