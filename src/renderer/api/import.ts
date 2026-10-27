/**
 * 导入相关 IPC（M1-07 交互层用）。
 *
 * 与 M1-06 的主进程侧一一对应：`import:commit` 只返回 taskId，
 * 进度与结果全部走 `import:progress` 事件——一个几百本的导入要跑几十秒，
 * 阻塞在 invoke 上会让界面看起来卡死。
 */
import type { ImportOptions, ImportProgressDTO, ScanPreviewDTO } from '@shared/dto'
import { call, on } from './client'

export const importApi = {
  /** 打开系统选文件夹对话框；用户取消时返回 null */
  pickFolder(): Promise<{ path: string } | null> {
    return call('import:pickFolder')
  },

  /** 扫描预览：分类（可导入 / 重复 / 不支持 / 空文件），**不写库**，可反复调用 */
  scan(path: string): Promise<ScanPreviewDTO> {
    return call('import:scan', { path })
  },

  /** 开始导入。返回 taskId 供 cancel 使用 */
  commit(path: string, options: ImportOptions = {}): Promise<{ taskId: string }> {
    return call('import:commit', { path, options })
  },

  cancel(taskId: string): Promise<void> {
    return call('import:cancel', { taskId })
  },

  /** 订阅进度事件。返回取消订阅函数，组件卸载时务必调用 */
  onProgress(cb: (dto: ImportProgressDTO) => void): () => void {
    return on('import:progress', cb)
  }
}
