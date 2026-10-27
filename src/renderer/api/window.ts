import { call, on, send } from './client'

export const windowApi = {
  minimize: (): void => send('window:minimize'),
  toggleMaximize: (): void => send('window:toggle-maximize'),
  close: (): void => send('window:close'),
  getState: () => call('window:get-state'),
  /** 返回取消订阅函数 */
  onState: (cb: (state: { maximized: boolean; fullscreen: boolean }) => void) => on('window:state', cb)
}
