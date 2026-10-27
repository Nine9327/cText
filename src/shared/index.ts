/**
 * 主进程与渲染层共享的类型与常量。
 * M0-04 起这里会长出完整的 IpcMap / IpcEvents 与 zod schema。
 */

export const APP_NAME = 'cText'

export const IPC = {
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    state: 'window:state'
  }
} as const

export type ReadState = 'unread' | 'reading' | 'finished'

export interface BookSummary {
  id: string
  title: string
  author: string | null
  format: 'txt' | 'epub' | 'pdf'
  /** 0 ~ 1 */
  progress: number
  readState: ReadState
  /** 本地书所属根目录；网络书为 null */
  rootId: string | null
  /** 根目录离线时为 true（书籍记录仍保留） */
  offline: boolean
}
