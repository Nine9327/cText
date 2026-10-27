/**
 * 定位 worker 的启动命令。
 *
 * 三种运行形态：
 *   1. 打包后：resources/python/ctext-worker/ctext-worker.exe（PyInstaller --onedir，M0-07 产出）
 *   2. 开发态：仓库内 .venv 的解释器 + python/ctext_worker/main.py
 *   3. 两者都不适用：环境变量 CTEXT_WORKER_CMD / CTEXT_WORKER_ARGS 覆盖（自检与特殊环境用）
 *
 * 开发态必须用 .venv 而不是 PATH 上的 python——系统 Python 可能没有依赖，
 * 也可能被别的项目改过版本（项目约定见 docs/开发计划.md §3.1）。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../log'
import type { BridgeLaunch } from './PythonBridge'

const log = createLogger('worker')

export interface WorkerLaunchPlan extends BridgeLaunch {
  /** 回退到备用解释器时的说明，仅用于日志 */
  warning?: string
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed
  } catch {
    log.warn('CTEXT_WORKER_ARGS 不是合法的 JSON 数组，已忽略')
  }
  return []
}

export function resolveLaunch(): WorkerLaunchPlan {
  // 1. 显式覆盖（优先级最高）
  const overrideCmd = process.env['CTEXT_WORKER_CMD']
  if (overrideCmd) {
    return {
      command: overrideCmd,
      args: parseArgs(process.env['CTEXT_WORKER_ARGS']),
      cwd: process.env['CTEXT_WORKER_CWD'] ?? app.getAppPath()
    }
  }

  // 2. 打包后：PyInstaller 的 onedir 产物
  if (app.isPackaged) {
    const exeDir = join(process.resourcesPath, 'python', 'ctext-worker')
    return {
      command: join(exeDir, process.platform === 'win32' ? 'ctext-worker.exe' : 'ctext-worker'),
      args: [],
      cwd: exeDir
    }
  }

  // 3. 开发态：仓库内 venv
  const repoRoot = app.getAppPath()
  const workerDir = join(repoRoot, 'python', 'ctext_worker')
  const mainPy = join(workerDir, 'main.py')
  const venvPy =
    process.platform === 'win32'
      ? join(repoRoot, '.venv', 'Scripts', 'python.exe')
      : join(repoRoot, '.venv', 'bin', 'python')

  const env: Record<string, string> = {
    // 诊断方法（debug.*）只在开发态注册，生产包里不存在
    CTEXT_WORKER_DEBUG: '1'
  }

  if (!existsSync(venvPy)) {
    log.error(`未找到 ${venvPy}，回退到 PATH 上的 python。请执行 pnpm setup:python`)
    return {
      command: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-u', mainPy],
      cwd: workerDir,
      env,
      warning: '使用 PATH 上的 python，依赖可能缺失'
    }
  }

  return {
    command: venvPy,
    args: ['-u', mainPy],
    cwd: workerDir,
    env
  }
}

/** worker 源码目录（自检脚本要判断它是否存在） */
export function workerDirPath(): string {
  return join(app.getAppPath(), 'python', 'ctext_worker')
}

/** 便于日志与排查：当前形态下真正的启动目录 */
export function launchSummary(plan: WorkerLaunchPlan): string {
  return `${plan.command} ${plan.args.join(' ')}`.trim() || dirname(plan.command)
}
