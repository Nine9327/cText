/**
 * 常规设置的实际生效（M5-01）。
 *
 * 设置项写进库只是「记住了」，M5-01 的验收是「每项设置重启后生效」，
 * 所以这一层负责把库里的值落到操作系统 / 窗口行为上：
 *   - `autoLaunch`      → 开机自启（登录项）
 *   - `closeAction`     → 关窗时隐藏到托盘还是退出（index.ts 的 close 拦截读它）
 *   - `minimizeToTray`  → 最小化时隐藏到托盘
 *
 * 这一层刻意**只做副作用**，不读库：调用方（IPC patch / 启动）自己 loadSettings
 * 再传进来。这样自检可以用假数据跑，不必先造一个库。
 */
import { app } from 'electron'
import type { GeneralSettingsDTO } from '@shared/dto'
import { createLogger } from '../log'

const log = createLogger('settings-apply')

export interface LoginItemPlan {
  openAtLogin: boolean
  path?: string
  args?: string[]
}

/**
 * 登录项参数。
 *
 * `--hidden` 让自启动时直接进托盘而不是弹一个窗口——开机时用户正在做别的事，
 * 一个自己跳出来的阅读器窗口是打扰。窗口侧在 ready-to-show 里读这个参数。
 *
 * dev 下返回 null：`process.execPath` 是 `node_modules/electron/dist/electron.exe`，
 * 写进注册表只会变成「开机启动一个不带参数的 Electron」——那种自启动是坏的，
 * 不如明确不写。
 */
export function loginItemPlan(
  general: Pick<GeneralSettingsDTO, 'autoLaunch'>,
  execPath: string,
  packaged: boolean
): LoginItemPlan | null {
  if (!packaged) return null
  return { openAtLogin: general.autoLaunch, path: execPath, args: ['--hidden'] }
}

export interface ApplyResult {
  /** 是否真的写到了系统（dev 下永远是 false） */
  autoLaunchApplied: boolean
  applied: boolean
}

/**
 * 应用「需要落到系统」的设置。失败只记日志：设置页已经存下了，用户下次启动
 * 还有机会生效，这里抛错会让一次滑块的拖动变成整页报错。
 */
export function applyGeneralSettings(general: GeneralSettingsDTO): ApplyResult {
  const plan = loginItemPlan(general, process.execPath, app.isPackaged)
  if (plan === null) {
    log.info('开发态跳过登录项写入', { autoLaunch: general.autoLaunch })
    return { autoLaunchApplied: false, applied: false }
  }

  try {
    app.setLoginItemSettings(plan)
    log.info('登录项已更新', { openAtLogin: plan.openAtLogin })
    return { autoLaunchApplied: true, applied: true }
  } catch (err) {
    log.warn('登录项写入失败', { message: err instanceof Error ? err.message : String(err) })
    return { autoLaunchApplied: false, applied: false }
  }
}

/** 启动时应不应该直接藏进托盘（`--hidden` 或被系统以登录项拉起） */
export function shouldStartHidden(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}
