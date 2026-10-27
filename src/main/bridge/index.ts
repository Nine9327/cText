/**
 * 桥接层的单例出口。业务代码（ImportService / ReaderService）只从这里拿 bridge，
 * 不自己 spawn 进程——否则崩溃重启计数会分裂成多份。
 */
import { PythonBridge } from './PythonBridge'
import { resolveLaunch } from './launch'

export { PythonBridge } from './PythonBridge'
export type { BridgeState, BridgeStatus } from './PythonBridge'
export type { WorkerHealthPayload, WorkerReadyData } from './protocol'

let instance: PythonBridge | null = null

export function getPythonBridge(): PythonBridge {
  if (!instance) {
    const plan = resolveLaunch()
    instance = new PythonBridge({
      ...plan,
      onEvent: (event, data) => {
        // M1 的导入进度会走这里；现在只记 debug，避免刷屏
        if (process.env['CTEXT_LOG_LEVEL'] === 'debug') {
          console.log(`[worker] 事件 ${event}`, data)
        }
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
