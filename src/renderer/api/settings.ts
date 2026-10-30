/**
 * 设置 IPC 封装（M5-01）。
 *
 * 三个方法对应三个通道。`patch` 的入参是 DeepPartial：分区内只写要改的字段，
 * 主进程负责与库里的现值合并——渲染层不需要先读全量再回写，否则两个设置项
 * 同时改会互相覆盖。
 */
import type { SettingsDTO } from '@shared/dto'
import type { DeepPartial } from '@shared/ipc/contract'
import { call } from './client'

export const settingsApi = {
  get(): Promise<SettingsDTO> {
    return call('settings:get')
  },

  patch(patch: DeepPartial<SettingsDTO>): Promise<SettingsDTO> {
    return call('settings:patch', { patch })
  },

  /** 恢复全部默认值。主进程会同时把登录项、托盘这些副作用重新落一遍 */
  reset(): Promise<SettingsDTO> {
    return call('settings:reset')
  }
}
