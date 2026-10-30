/**
 * 系统托盘（M5-01）。
 *
 * 「关闭窗口不退出」必须有托盘，否则窗口一关就再也找不回来——用户只能去任务管理器
 * 结束进程。所以 `closeAction='tray'` 与托盘的存在性是绑定的：托盘建不起来时，
 * 窗口的 close 事件必须放行（见 index.ts），宁可退出也不能留一个无窗口的进程。
 *
 * 三种失败都要吞掉：
 *   1. 图标读不出来（打包漏了 resources）→ 返回 false，调用方退化为「正常关闭」
 *   2. 系统托盘不可用（少数 Linux 桌面环境）→ 同上
 *   3. 重复创建 → 复用已有实例，不重建（重建会短暂出现两个图标）
 */
import { app, Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { createLogger } from '../log'

const log = createLogger('tray')

export interface TrayHandlers {
  /** 点击图标 / 菜单「显示主窗口」 */
  onShow: () => void
  /** 菜单「退出」：走真正的 quit，不再被 close 拦截 */
  onQuit: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

/**
 * 图标位置。
 *
 * dev 下在项目根 `resources/icons`，打包后靠 electron-builder 的 extraResources
 * 落在 `resourcesPath/icons`——**不能直接读项目内的路径**，asar 里的 png
 * 用 `nativeImage.createFromPath` 读不出来（它只认真实文件系统路径）。
 */
export function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', 'icon.png')
    : join(app.getAppPath(), 'resources', 'icons', 'icon.png')
}

function loadIcon(): NativeImage | null {
  try {
    const image = nativeImage.createFromPath(trayIconPath())
    if (image.isEmpty()) return null
    // 托盘图标按 16px 显示：原图 512px 直接塞进托盘会被缩成糊状
    return image.resize({ width: 16, height: 16 })
  } catch {
    return null
  }
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => handlers?.onShow()
    },
    { type: 'separator' },
    {
      label: '退出 cText',
      click: () => handlers?.onQuit()
    }
  ])
}

/** 注册回调；窗口重建时会被再调一次，直接覆盖旧值 */
export function installTrayHandlers(next: TrayHandlers): void {
  handlers = next
}

/**
 * 按需创建 / 销毁托盘。返回**当前是否存在可用托盘**。
 *
 * 调用点是「设置变了」与「窗口关闭前」，所以必须是幂等的：
 * 要的时候没有就建，不要的时候有就拆。
 */
export function syncTray(needed: boolean): boolean {
  if (!needed) {
    destroyTray()
    return false
  }
  if (tray !== null) return true

  const icon = loadIcon()
  if (icon === null) {
    log.warn('托盘图标不可用，关闭行为退化为退出', { path: trayIconPath() })
    return false
  }

  try {
    tray = new Tray(icon)
    tray.setToolTip('cText')
    tray.setContextMenu(buildMenu())
    // 单击即回到窗口：Windows 上这是最自然的动作，双击等于点两次
    tray.on('click', () => handlers?.onShow())
    log.info('托盘已创建')
    return true
  } catch (err) {
    log.warn('托盘创建失败', { message: err instanceof Error ? err.message : String(err) })
    tray = null
    return false
  }
}

export function destroyTray(): void {
  if (tray === null) return
  try {
    tray.destroy()
  } catch {
    // 退出阶段托盘可能已随系统销毁，这里不需要处理
  }
  tray = null
  log.info('托盘已销毁')
}

export function hasTray(): boolean {
  return tray !== null
}
