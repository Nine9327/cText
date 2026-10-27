/**
 * 渲染层异常上报（M0-06 的"全局异常兜底"渲染侧）。
 *
 * 两条腿：
 *   1. **落盘**：通过 `log:renderer` 单向通道交给主进程，写进同一个日志文件，
 *      用户反馈时只需要发一个文件（M5-04 的导出 zip 会把它打包）。
 *   2. **提示**：弹 toast。生产环境只给通用文案（内部的错误信息对用户没有价值，
 *      还可能带路径），开发环境直接显示原始 message，改代码时不用来回翻日志。
 *
 * 去重交给 toast 层（同文案不重复入栈），这里只负责「同一次异常不重复上报」：
 * Vue 的 errorHandler 和 window.onerror 可能同时收到同一个错误，
 * 用 message+source 做 2 秒窗口去重。
 */
import type { RendererLogDTO } from '@shared/dto'
import { send } from '@/api/client'
import { pushToast } from './toast'

const DEDUPE_MS = 2_000
const recent = new Map<string, number>()

function normalize(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || err.name, stack: err.stack }
  }
  if (typeof err === 'string') return { message: err }
  try {
    return { message: JSON.stringify(err) }
  } catch {
    return { message: String(err) }
  }
}

function shouldSkip(key: string): boolean {
  const now = Date.now()
  const last = recent.get(key)
  if (last !== undefined && now - last < DEDUPE_MS) return true
  recent.set(key, now)
  if (recent.size > 32) {
    for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k)
  }
  return false
}

/** 主进程侧会再校验一遍，这里做长度保护是因为 IPC 消息体不宜过大 */
const MAX_MESSAGE = 2_000
const MAX_STACK = 6_000

function forward(payload: RendererLogDTO): void {
  try {
    send('log:renderer', payload)
  } catch {
    // 浏览器直连模式（pnpm dev:web）没有 preload，没有可写的地方，静默即可
  }
}

/**
 * 上报一个未捕获异常。
 * @param source 产生位置，如 `vue:render` / `window.onerror` / `unhandledrejection`
 */
export function reportError(err: unknown, source: string): void {
  const { message, stack } = normalize(err)
  const key = `${source}|${message}`
  if (shouldSkip(key)) return

  forward({
    level: 'error',
    message: message.slice(0, MAX_MESSAGE),
    stack: stack?.slice(0, MAX_STACK),
    source,
    url: typeof location !== 'undefined' ? location.href.slice(0, 512) : undefined
  })

  pushToast({
    level: 'error',
    message: import.meta.env.DEV ? message : '出现未预期的错误，已记录到日志',
    code: source
  })
}

/** 普通诊断日志（不弹 toast），需要时用它把渲染层的关键节点写进统一日志 */
export function reportLog(level: RendererLogDTO['level'], message: string, source = 'manual'): void {
  forward({ level, message: message.slice(0, MAX_MESSAGE), source })
}

/** 安装 window 级兜底；由 main.ts 在 mount 之前调用 */
export function installRendererErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script）也会触发 error，但没有 error 对象，且 target 不是 window
    if (event.target && event.target !== window) return
    reportError(event.error ?? event.message, 'window.onerror')
  })

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, 'unhandledrejection')
  })
}
