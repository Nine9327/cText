/**
 * 全局异常兜底（M0-06）。
 *
 * 目标不是「捕获所有错误」——那是不可能的——而是保证**任何一条漏网路径都留下证据，
 * 并且用户当场能看到一句人话**，而不是窗口莫名其妙没反应或直接消失。
 *
 * 覆盖的六条路径：
 *   1. `uncaughtException`（主进程同步异常）
 *   2. `unhandledRejection`（主进程未处理的 Promise）
 *   3. `render-process-gone`（渲染进程崩溃 / 被 OOM kill）
 *   4. `child-process-gone`（GPU、Utility 等子进程退出）
 *   5. `preload-error`（preload 脚本自身执行失败，此时页面上的 window.api 根本不存在）
 *   6. `did-fail-load` / `unresponsive`（页面加载失败、界面卡死）
 *
 * 策略：
 *   - 记录永远带原始 Error 对象，交给日志层脱敏后落盘（含堆栈）
 *   - 给用户只发**固定文案**，不带堆栈与技术细节（渲染层 toast）
 *   - 主进程不因单个异常退出：Electron 主进程退出的代价是用户丢掉整个会话；
 *     但短时间内反复炸（说明状态已坏）就主动退出，避免变成"弹窗 - 崩溃"死循环
 */
import { app, dialog, type WebContents } from 'electron'
import { createLogger } from '../log'
import { notifyError, notifyWarn } from '../utils/notify'

const log = createLogger('app')

/** 10 秒内超过这个次数的未捕获异常，说明进程状态已经不可信 */
const CRASH_WINDOW_MS = 10_000
const CRASH_LIMIT = 5

let installed = false
let crashTimes: number[] = []

/** 同一条错误在 2 秒内只提示一次，避免一次连锁故障刷出一屏 toast */
const recentToasts = new Map<string, number>()
function shouldToast(key: string, windowMs = 2_000): boolean {
  const now = Date.now()
  const last = recentToasts.get(key)
  if (last !== undefined && now - last < windowMs) return true
  recentToasts.set(key, now)
  if (recentToasts.size > 32) {
    for (const [k, t] of recentToasts) if (now - t > windowMs) recentToasts.delete(k)
  }
  return false
}

function reportMainProcessError(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  log.error(`未捕获异常（${kind}）`, { kind, error: err })

  const now = Date.now()
  crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS)
  crashTimes.push(now)

  if (crashTimes.length >= CRASH_LIMIT) {
    log.error('短时间内未捕获异常过多，判定进程状态不可信，主动退出', { kind, count: crashTimes.length })
    app.exit(1)
    return
  }

  if (!shouldToast(kind)) notifyError('程序内部出现异常，已记录到日志；如反复出现请反馈')
}

/**
 * 安装兜底。必须尽早调用（app ready 之前），否则早期异常落在空档里。
 * 重复调用是空操作。
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return
  installed = true

  process.on('uncaughtException', (err) => reportMainProcessError('uncaughtException', err))
  process.on('unhandledRejection', (reason) => reportMainProcessError('unhandledRejection', reason))

  app.on('render-process-gone', (_event, contents: WebContents, details) => {
    const url = safeUrl(contents)
    log.error('渲染进程退出', { reason: details.reason, exitCode: details.exitCode, url })
    if (details.reason === 'clean-exit') return
    if (!shouldToast('render-process-gone')) {
      notifyError('界面进程异常退出，建议重启应用')
    }
  })

  app.on('child-process-gone', (_event, details) => {
    // GPU 崩溃在虚拟显示适配器环境里很常见，且 Chromium 会自动降级，只记 warn
    const level = details.reason === 'clean-exit' ? 'debug' : 'warn'
    log[level]('子进程退出', { type: details.type, reason: details.reason, exitCode: details.exitCode })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', (_e, preloadPath, error) => {
      // 这条一旦发生，页面上所有 IPC 都会失效，必须显式提示
      log.error('preload 执行失败，IPC 将不可用', { preloadPath, error })
      notifyError('界面脚本加载失败，请重启应用')
    })

    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      log.error('页面加载失败', { code, description, url, isMainFrame })
    })

    contents.on('unresponsive', () => {
      log.warn('渲染层无响应', { url: safeUrl(contents) })
      notifyWarn('界面暂时无响应，正在等待恢复')
    })

    contents.on('responsive', () => log.info('渲染层已恢复响应', { url: safeUrl(contents) }))
  })
}

function safeUrl(contents: WebContents): string | null {
  try {
    return contents.isDestroyed() ? null : contents.getURL()
  } catch {
    return null
  }
}

/** 致命错误：此时界面已经不可用，弹系统对话框而不是 toast */
export function reportFatal(title: string, detail: string, err?: unknown): void {
  log.error(`致命错误：${title}`, { detail, error: err })
  try {
    dialog.showErrorBox(title, detail)
  } catch {
    // 极端情况（无 GUI 会话）下弹不出对话框，日志已经留下
  }
}
