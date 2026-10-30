/**
 * 设置 IPC（M2-07 起，M5-01 补 reset 与副作用）。
 *
 * 三个通道：
 *   - `settings:get`   读全量（永远带默认值，不会给渲染层 undefined）
 *   - `settings:patch` 局部更新，返回合并后的全量
 *   - `settings:reset` 恢复全部默认值（M5-01）
 *
 * 返回全量而不是 patch 结果：渲染层把「设置」当成一颗树用一个 store 持有，
 * 让每次写入都回传完整快照，可以省掉「本地乐观更新 + 服务端纠正」的分叉。
 * 设置项数量很少（< 20），多传几百字节换掉一整类状态不同步的问题。
 *
 * **写入后要做副作用**（M5-01）：常规设置里有两项不落在库里——开机自启写在系统登录项，
 * 关闭行为决定托盘要不要存在。所以每次写入都调一次 `syncSideEffects`，
 * 而不是等下次启动。否则用户勾了「开机自启」，重启前先在别处验证会发现根本没生效。
 */
import type { SettingsDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { loadSettings, patchSettings, resetSettings } from '../db/repositories/settings'
import { coversDir } from '../network/service'
import { syncTray } from '../platform/tray'
import { applyGeneralSettings } from '../settings/apply'
import { pruneCovers } from '../settings/storage'
import { createLogger } from '../log'
import { registerHandler } from './registry'

const log = createLogger('settings-ipc')

/**
 * 把「库里记住了」的东西落到系统上。
 *
 * **按变更的分区筛**：阅读器拖一次字号就会发一次 `settings:patch`（节流后仍有
 * 每秒一次的量级），如果每次都写一遍登录项、扫一遍封面目录，纯属浪费——
 * 而且会盖在用户正在做的事上。只有真的改了对应分区才动作。
 *
 * 托盘只要**有一个**理由存在就创建：关闭时藏进托盘，或者最小化时藏进托盘。
 * 两者都不需要时立刻销毁——留着一个点了没反应的托盘图标比没有更糟。
 */
function syncSideEffects(settings: SettingsDTO, changed: readonly string[]): void {
  if (changed.includes('general')) {
    applyGeneralSettings(settings.general)
    const needed = settings.general.closeAction === 'tray' || settings.general.minimizeToTray
    const active = syncTray(needed)
    if (needed && !active) {
      // 托盘建不起来时关闭行为会退化成退出（见 index.ts 的 close 拦截），
      // 这里记一条，用户反馈「设了不生效」时能直接看到原因
      log.warn('常规设置要求托盘，但托盘不可用', {
        closeAction: settings.general.closeAction,
        minimizeToTray: settings.general.minimizeToTray
      })
    }
  }

  if (!changed.includes('storage')) return

  /*
   * 封面上限改了要**立刻裁一次**。
   *
   * 只在下次下载封面时裁的话，用户把上限从 512MB 调到 64MB 之后，磁盘上那 512MB
   * 会一直留着——设置页刚显示完「上限 64MB」，存储用量还是 512MB，看起来就是没生效。
   * 裁剪是 best-effort（删不掉的文件跳过），所以不 await、失败只记日志。
   */
  const limitBytes = settings.storage.coverCacheLimitMb * 1024 * 1024
  void pruneCovers(coversDir(), limitBytes).catch((err: unknown) => {
    log.warn('封面缓存裁剪失败', { message: err instanceof Error ? err.message : String(err) })
  })
}

export function registerSettingsIpc(): void {
  registerHandler('settings:get', (): SettingsDTO => loadSettings(getDb()))

  registerHandler('settings:patch', ({ patch }): SettingsDTO => {
    const next = patchSettings(getDb(), patch as unknown as Record<string, unknown>)
    syncSideEffects(next, Object.keys(patch))
    return next
  })

  registerHandler('settings:reset', (): SettingsDTO => {
    const next = resetSettings(getDb())
    // 恢复默认同样要落到系统：不清登录项的话，用户点了「恢复默认」，
    // 下次开机自启还在——而界面上那个开关已经是关的
    syncSideEffects(next, ['general', 'storage'])
    log.info('设置已恢复默认')
    return next
  })
}
