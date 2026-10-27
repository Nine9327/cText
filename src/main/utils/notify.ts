/**
 * 主进程 → 渲染层的轻量提示通道。
 *
 * 用它在**主进程侧**告诉用户「出事了」：worker 连续崩溃、渲染进程重启、未捕获异常等。
 * 渲染层侧的 `lib/toast.ts` 负责显示；这里只负责把事件推到窗口。
 *
 * 为什么要单独一层：`broadcast` 需要 import registry，而 registry 又会 import 日志，
 * 如果各处直接调 broadcast，很容易绕成环。小模块隔离一下，依赖方向永远是从上到下。
 */
import type { ToastDTO } from '@shared/dto'
import { broadcast } from '../ipc/registry'

/** 窗口可能还没建好（比如 DB 初始化阶段），此时只记日志，不抛错 */
export function notify(payload: ToastDTO): void {
  try {
    broadcast('toast', payload)
  } catch {
    // 没有窗口 / 通道未安装，忽略；对应的错误本来就已经写进日志了
  }
}

export function notifyInfo(message: string): void {
  notify({ level: 'info', message })
}

export function notifyWarn(message: string, code?: string): void {
  notify({ level: 'warn', message, code })
}

export function notifyError(message: string, code?: string): void {
  notify({ level: 'error', message, code })
}
