import type { OpenPathTarget } from '@shared/dto'
import { call } from './client'

export const systemApi = {
  /** 诊断通道：验证 IPC 链路是否通（设置 → 关于 页的「自检」用） */
  echo: (message: string, opts?: { delayMs?: number; failMode?: 'none' | 'throw' }) =>
    call('system:echo', { message, ...opts }),
  info: () => call('system:info'),
  /** Python 解析引擎健康状态（未就绪时 worker 为 null，不抛错） */
  workerHealth: () => call('system:worker-health'),

  /** 用系统文件管理器打开固定目录（M5-01）。只收枚举，不收任意路径 */
  openPath: (target: OpenPathTarget) => call('system:openPath', { target }),
  /** 封面 + 正文缓存用量与三个路径 */
  storageStats: () => call('system:storageStats'),
  /** 清空封面缓存，并清掉库里的 cover_path（返回清掉的文件数与字节数） */
  clearCovers: () => call('system:clearCovers')
}
