/**
 * 桥接层的单例出口。业务代码（ImportService / ReaderService）只从这里拿 bridge，
 * 不自己 spawn 进程——否则崩溃重启计数会分裂成多份。
 */
import { createLogger } from '../log'
import { notifyError } from '../utils/notify'
import { PythonBridge } from './PythonBridge'
import { resolveLaunch } from './launch'

export { PythonBridge } from './PythonBridge'
export type { BridgeState, BridgeStatus } from './PythonBridge'
export type { WorkerHealthPayload, WorkerReadyData } from './protocol'

const log = createLogger('worker')

let instance: PythonBridge | null = null

export function getPythonBridge(): PythonBridge {
  if (!instance) {
    const plan = resolveLaunch()
    instance = new PythonBridge({
      ...plan,
      onEvent: (event, data) => {
        // M1 的导入进度会走这里；现在只记 debug，避免刷屏
        log.debug(`worker 事件 ${event}`, { event, data })
      },
      onFail: (message) => {
        // 完整原因（含 stderr 尾巴）已经进日志；给用户的只保留结论 + 下一步
        log.error('解析引擎不可用，已停止自动重启', { reason: message })
        notifyError('解析引擎启动失败，导入功能暂时不可用；请查看日志或重启应用', 'E_WORKER_FAILED')
      }
    })
  }
  return instance
}

export async function disposePythonBridge(): Promise<void> {
  if (!instance) return
  const bridge = instance
  instance = null
  await bridge.stop()
}
