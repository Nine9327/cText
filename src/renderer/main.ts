import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { on } from './api/client'
import { toastFromMain } from './lib/toast'
import { installRendererErrorHandlers, reportError } from './lib/report'
import { router } from './router'
import { useImportStore } from './stores/import'
import './styles/index.css'

// M0-06：先装兜底，再 mount。顺序反了的话，挂载期间抛的错就没人接
installRendererErrorHandlers()

const app = createApp(App)

// Vue 组件内部抛出的异常不会走 window.onerror（Vue 自己捕获了），必须单独接
app.config.errorHandler = (err, _instance, info) => {
  reportError(err, `vue:${info}`)
}

// 主进程推来的提示（worker 崩溃、未捕获异常等）
try {
  on('toast', (payload) => toastFromMain(payload))
} catch {
  // 浏览器直连模式没有 preload
}

app.use(createPinia()).use(router).mount('#app')

// M1-07：导入进度订阅挂在应用生命周期上，与面板是否打开无关——
// 用户可以在导入途中关掉面板去做别的事，完成时仍会收到提示。
try {
  on('import:progress', (dto) => useImportStore().applyProgress(dto))
} catch {
  // 浏览器直连模式没有 preload
}
