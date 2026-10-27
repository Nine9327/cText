import { call } from './client'

export const systemApi = {
  /** 诊断通道：验证 IPC 链路是否通（设置 → 关于 页的「自检」用） */
  echo: (message: string, opts?: { delayMs?: number; failMode?: 'none' | 'throw' }) =>
    call('system:echo', { message, ...opts }),
  info: () => call('system:info')
}
