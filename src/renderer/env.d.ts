import type { PreloadApi } from '../preload/index'

declare global {
  interface Window {
    /** Electron 下由 preload 注入；浏览器预览时为 undefined */
    api?: PreloadApi
  }
}

export {}
