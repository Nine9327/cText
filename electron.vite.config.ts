import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const alias = {
  '@': resolve(__dirname, 'src/renderer'),
  '@shared': resolve(__dirname, 'src/shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias },
    plugins: [vue()]
  }
})
