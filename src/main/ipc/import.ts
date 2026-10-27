/**
 * 导入 IPC（M1-06）。
 *
 * 四个通道分别是「选目录 / 预览 / 开始 / 取消」。
 *
 * 两条职责边界：
 *   1. **commit 只负责返回 taskId**，进度全部走 `import:progress` 事件。
 *      一个 500 本的导入要几十秒，阻塞在 invoke 上会让渲染层以为界面卡死。
 *   2. **目录可访问性在进入队列前校验**。否则会先登记一个打不开的根目录，
 *      再让整批导入失败——用户看到的是一个删不掉的离线书库。
 */
import { join, resolve } from 'node:path'
import { app, dialog, BrowserWindow } from 'electron'
import { AppError, ERROR_CODES } from '@shared/errors'
import { createLogger } from '../log'
import { probePath } from '../library/roots-monitor'
import { buildScanPreview, cancelImport, startImport } from '../library/import-task'
import { registerHandler } from './registry'

const log = createLogger('import')

/** 封面缓存目录固定为 userData/covers；库里只存文件名，换盘符不会让封面失效 */
export function coversDir(): string {
  return join(app.getPath('userData'), 'covers')
}

async function assertUsableDirectory(input: string): Promise<string> {
  const target = resolve(input.trim())
  if (!(await probePath(target))) {
    throw new AppError(ERROR_CODES.notFound, '目录不存在、不是文件夹，或当前无法访问')
  }
  return target
}

export function registerImportIpc(): void {
  registerHandler('import:pickFolder', async (_input, ctx) => {
    const win = ctx.window ?? BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { title: '选择要导入的文件夹', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择要导入的文件夹', properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0] }
  })

  registerHandler('import:scan', async ({ path }) => {
    const target = await assertUsableDirectory(path)
    return buildScanPreview(target)
  })

  registerHandler('import:commit', async ({ path, options }) => {
    const target = await assertUsableDirectory(path)
    const result = startImport(target, options, { coversDir: coversDir() })
    log.info('导入任务已创建', { taskId: result.taskId, path: target })
    return result
  })

  registerHandler('import:cancel', ({ taskId }) => {
    cancelImport(taskId)
  })
}
