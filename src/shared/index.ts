/**
 * 主进程、preload、渲染层共享的公开出口。
 *
 * 注意：这里 **不要** re-export `./ipc/schemas`——它会把 zod 打进 preload 与渲染层包，
 * 而 preload 在 sandbox 下拿不到 node_modules。schema 只允许主进程按路径深引用。
 */

export const APP_NAME = 'cText'
export const APP_ID = 'cn.ctext.app'

export * from './dto'
export * from './errors'
export * from './ipc/contract'
export { INVOKE_CHANNELS, EVENT_CHANNELS, SEND_CHANNELS } from './ipc/channels'
