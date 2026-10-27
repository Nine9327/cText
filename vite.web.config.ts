/**
 * 仅用于在浏览器里预览渲染层 UI 骨架（不需要启动 Electron）。
 * Electron 下请用 `pnpm dev`。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5210,
    strictPort: true
  }
})
