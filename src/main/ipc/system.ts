/**
 * 系统级 IPC：诊断用通道 + 设置页需要的目录/用量查询（M5-01）。
 *
 * - system:echo 验证 请求 → zod → handler → 返回值 的完整往返（含异常分支）
 * - system:info 提供版本矩阵与路径，用于「关于」页与问题反馈
 * - system:openPath / system:storageStats 给设置页的「存储」「关于」两组用
 */
import { app, shell } from 'electron'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { OpenPathTarget, SystemStorageStatsDTO, WorkerHealthDTO } from '@shared/dto'
import { AppError, ERROR_CODES } from '@shared/errors'
import { getPythonBridge } from '../bridge'
import { loadSettings } from '../db/repositories/settings'
import { getDb } from '../db/connection'
import { getLogDir } from '../log'
import { stats as cacheStats } from '../network/cache'
import { coversDir, networkCacheDir } from '../network/service'
import { getSwitchReport } from '../platform/safe-mode'
import { dirStats } from '../settings/storage'
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

  registerHandler('system:info', () => {
    const switches = getSwitchReport()
    return {
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
      logDir: getLogDir() ?? join(app.getPath('userData'), 'logs'),
      safeMode: switches.safeMode,
      safeModeSource: switches.source
    }
  })

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

  /** 目录白名单解析。五个目标都是「设置页要打开的那个文件夹」，不接受外部路径 */
  const resolveTarget = (target: OpenPathTarget): string => {
    const userData = app.getPath('userData')
    switch (target) {
      case 'logs':
        return getLogDir() ?? join(userData, 'logs')
      case 'data':
        return userData
      case 'db':
        // 数据库是文件，但 openPath 指向文件会变成「用默认程序打开 .db」，
        // 用户想要的是「在文件夹里看到它」，所以打开所在目录
        return userData
      case 'covers':
        return coversDir()
      case 'chapters':
        return networkCacheDir()
    }
  }

  registerHandler('system:openPath', async ({ target }) => {
    const dir = resolveTarget(target)
    // 目录可能还没被创建（从没下载过封面/正文），先建出来——
    // shell.openPath 对不存在的路径只返回一句错误字符串，不会替我们建
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      throw new AppError(ERROR_CODES.io, '目录不可用，可能没有写入权限')
    }
    const error = await shell.openPath(dir)
    if (error !== '') throw new AppError(ERROR_CODES.io, `打开目录失败：${error}`)
  })

  registerHandler('system:storageStats', async (): Promise<SystemStorageStatsDTO> => {
    const settings = loadSettings(getDb())
    const covers = await dirStats(coversDir())
    const chapters = await cacheStats({ root: networkCacheDir() }, settings.sources.cacheTtlDays)
    return {
      covers,
      chapters: { dir: networkCacheDir(), files: chapters.files, bytes: chapters.bytes },
      dataDir: app.getPath('userData'),
      logDir: getLogDir() ?? join(app.getPath('userData'), 'logs'),
      coverCacheLimitMb: settings.storage.coverCacheLimitMb
    }
  })

  registerHandler('system:clearCovers', async () => {
    const dir = coversDir()
    const before = await dirStats(dir)
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      throw new AppError(ERROR_CODES.io, '清理封面缓存失败，可能有文件正被占用')
    }
    // 不清 cover_path 的话，每张书卡都会先请求一个已经不存在的文件再回退占位图，
    // 表现为「清理成功但每次打开书库都有几十个 404」
    getDb().prepare('UPDATE books SET cover_path = NULL WHERE cover_path IS NOT NULL').run()
    return { files: before.files, bytes: before.bytes }
  })
}
