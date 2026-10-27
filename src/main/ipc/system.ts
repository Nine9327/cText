/**
 * 系统级 IPC：诊断用通道。
 *
 * 这两个通道产品界面不会调用，但它们是整个 IPC 链路的「体温计」：
 * - system:echo 验证 请求 → zod → handler → 返回值 的完整往返（含异常分支）
 * - system:info 提供版本矩阵与路径，用于「关于」页与问题反馈
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { WorkerHealthDTO } from '@shared/dto'
import { getPythonBridge } from '../bridge'
import { getLogDir } from '../log'
import { registerHandler } from './registry'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function registerSystemIpc(): void {
  registerHandler('system:echo', async (input, ctx) => {
    if (input.delayMs && input.delayMs > 0) await sleep(input.delayMs)

    if (input.failMode === 'throw') {
      throw new Error('system:echo 诊断：按请求主动抛出异常')
    }

    return {
      message: input.message,
      receivedAt: Date.now(),
      handledInMs: Number((performance.now() - ctx.startedAt).toFixed(2)),
      from: 'main' as const
    }
  })

  registerHandler('system:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    isDev: !app.isPackaged,
    userDataPath: app.getPath('userData'),
    dbPath: join(app.getPath('userData'), 'ctext.db'),
    logDir: getLogDir() ?? join(app.getPath('userData'), 'logs')
  }))

  /**
   * worker 健康状态。**这个通道永不抛错**——诊断通道自身的价值在于「能报告坏消息」，
   * 如果 worker 挂了它还返回错误，界面上就只剩一个空白而不是「未就绪 + 原因」。
   */
  registerHandler('system:worker-health', async (): Promise<WorkerHealthDTO> => {
    const bridge = getPythonBridge()
    const status = bridge.getStatus()
    const base: WorkerHealthDTO = {
      state: status.state,
      pid: status.pid,
      restarts: status.restarts,
      lastError: status.lastError,
      worker: null
    }

    if (status.state !== 'ready') return base

    try {
      const health = await bridge.ping(5_000)
      return {
        ...base,
        worker: {
          version: health.version,
          protocol: health.protocol,
          pid: health.pid,
          python: health.python,
          uptimeMs: health.uptimeMs,
          methods: health.methods,
          deps: health.deps
        }
      }
    } catch (err) {
      return {
        ...base,
        lastError: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
