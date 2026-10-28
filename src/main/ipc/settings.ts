/**
 * 设置 IPC（M2-07）。
 *
 * 两个通道：
 *   - `settings:get`   读全量（永远带默认值，不会给渲染层 undefined）
 *   - `settings:patch` 局部更新，返回合并后的全量
 *
 * 返回全量而不是 patch 结果：渲染层把「设置」当成一颗树用一个 store 持有，
 * 让每次写入都回传完整快照，可以省掉「本地乐观更新 + 服务端纠正」的分叉。
 * 设置项数量很少（< 20），多传几百字节换掉一整类状态不同步的问题。
 */
import type { SettingsDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { loadSettings, patchSettings } from '../db/repositories/settings'
import { registerHandler } from './registry'

export function registerSettingsIpc(): void {
  registerHandler('settings:get', (): SettingsDTO => loadSettings(getDb()))
  registerHandler('settings:patch', ({ patch }): SettingsDTO =>
    patchSettings(getDb(), patch as unknown as Record<string, unknown>)
  )
}
