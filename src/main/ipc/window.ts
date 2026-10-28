/**
 * 窗口相关 IPC：标题栏的三个按钮 + 状态读取 + 状态回推。
 *
 * 所有操作都以「发起调用的那个窗口」为准（ctx.window），不依赖模块级单例，
 * 将来开多窗口（如独立阅读窗）时不需要改这里。
 */
import type { BrowserWindow } from 'electron'
import { ERROR_CODES, AppError } from '@shared/errors'
import type { WindowStateDTO } from '@shared/dto'
import { emitTo, registerHandler, registerSend } from './registry'

export function windowStateOf(win: BrowserWindow): WindowStateDTO {
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
}

export function registerWindowIpc(): void {
  registerSend('window:minimize', ({ window }) => window?.minimize())

  registerSend('window:toggle-maximize', ({ window }) => {
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  registerSend('window:close', ({ window }) => window?.close())

  // 全屏用 setFullScreen 而不是最大化：阅读器要的是「没有标题栏、铺满屏幕」，
  // 最大化仍然保留窗口边框。状态变化由 attachWindowStateEvents 里的
  // enter-full-screen / leave-full-screen 回推。
  registerSend('window:toggle-fullscreen', ({ window }) => {
    if (!window) return
    window.setFullScreen(!window.isFullScreen())
  })

  registerHandler('window:get-state', (_input, ctx) => {
    if (!ctx.window) throw new AppError(ERROR_CODES.internal, '调用窗口已销毁')
    return windowStateOf(ctx.window)
  })
}

/**
 * 把窗口状态变化回推给渲染层。
 * `did-finish-load` 时补推一次——渲染层可能在首帧之后才挂载监听。
 */
export function attachWindowStateEvents(win: BrowserWindow): void {
  const push = () => emitTo(win, 'window:state', windowStateOf(win))
  win.on('maximize', push)
  win.on('unmaximize', push)
  win.on('enter-full-screen', push)
  win.on('leave-full-screen', push)
  win.webContents.on('did-finish-load', push)
}
