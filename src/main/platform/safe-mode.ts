/**
 * Chromium 启动开关 + 「安全模式」自动回退（M0-07）。
 *
 * 背景（本项目实测）：
 * 在带虚拟显示适配器（MuMu / GameViewer 等）的机器上，Chromium 子进程沙箱不可用——
 * GPU 进程在沙箱下 `0xC0000005` 崩溃并拖死主进程，Network service 起不来导致白屏。
 * 开发态一直是硬编码关掉这两个开关，但生产包不能无脑沿用：
 * 对绝大多数机器，沙箱是重要的安全边界，不该为一个环境问题全局放弃。
 *
 * 所以这里做「默认带沙箱 + 失败后自动回退」：
 *   1. 启动时读 boot-state.json，看上一次是不是「起来了但没画完就没了」（非正常退出）；
 *   2. 非正常退出过的下一次启动直接进安全模式；
 *   3. 本次运行中若 GPU/Network 子进程崩溃，或 20s 内没画完第一帧，
 *      写标记 + `app.relaunch(--safe-mode)` 自动重启一次（只重启一次，避免死循环）。
 *
 * 触发入口（任一即可）：
 *   - `--safe-mode` 命令行参数
 *   - `CTEXT_SAFE_MODE=1` 环境变量
 *   - 上一次非正常退出（自动）
 *
 * 安全模式做什么：`disable-gpu-sandbox` + `no-sandbox`。前者解决 GPU 崩溃，
 * 后者解决 Network service 起不来。这两条只在安全模式生效，正常路径保持默认沙箱。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../log'

const log = createLogger('boot')

/** 首帧超时：超过这个时间还没 did-finish-load，就认为渲染链路有问题 */
const FIRST_PAINT_TIMEOUT_MS = 20_000

export type SafeModeSource = 'dev' | 'env' | 'argv' | 'fallback' | 'none'

interface BootState {
  /** 累计启动次数，仅用于排查 */
  boots: number
  /** 连续「未正常启动」次数；成功画完第一帧即清零 */
  crashStreak: number
  /** 上一次是否在启动过程中（已开始、未正常结束） */
  booting: boolean
  /** 是否已在安全模式，用于避免重复 relaunch */
  safeMode: boolean
  lastBootAt: string
  lastHealthyAt: string | null
  lastFailure: string | null
}

const EMPTY_STATE: BootState = {
  boots: 0,
  crashStreak: 0,
  booting: false,
  safeMode: false,
  lastBootAt: '',
  lastHealthyAt: null,
  lastFailure: null
}

let stateFile = ''
let state: BootState = { ...EMPTY_STATE }
let report: StartupSwitchReport = {
  safeMode: false,
  source: 'none',
  switches: [],
  crashStreak: 0,
  previousBootUnclean: false
}

let firstPaint = false
let relaunching = false
let quitting = false
let watchdogTimer: NodeJS.Timeout | null = null

export interface StartupSwitchReport {
  safeMode: boolean
  source: SafeModeSource
  switches: string[]
  /** 进入本次启动前的连续失败次数 */
  crashStreak: number
  /** 上一次启动是否没画完第一帧就没了 */
  previousBootUnclean: boolean
}

/**
 * 状态文件。开发态与生产包分开，避免开发期（本来就是安全模式）把
 * 「安全模式」这个粘性标记带给生产包，也避免生产包的崩溃计数污染开发态。
 */
function statePath(): string {
  if (!stateFile) {
    stateFile = join(app.getPath('userData'), app.isPackaged ? 'boot-state.json' : 'boot-state.dev.json')
  }
  return stateFile
}

function loadState(): BootState {
  const file = statePath()
  if (!existsSync(file)) return { ...EMPTY_STATE }
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return { ...EMPTY_STATE }
    const obj = raw as Partial<BootState>
    return {
      boots: typeof obj.boots === 'number' ? obj.boots : 0,
      crashStreak: typeof obj.crashStreak === 'number' ? obj.crashStreak : 0,
      booting: obj.booting === true,
      safeMode: obj.safeMode === true,
      lastBootAt: typeof obj.lastBootAt === 'string' ? obj.lastBootAt : '',
      lastHealthyAt: typeof obj.lastHealthyAt === 'string' ? obj.lastHealthyAt : null,
      lastFailure: typeof obj.lastFailure === 'string' ? obj.lastFailure : null
    }
  } catch {
    // 状态文件坏了不能挡住启动：当成全新安装处理
    return { ...EMPTY_STATE }
  }
}

function saveState(patch: Partial<BootState>): void {
  state = { ...state, ...patch }
  try {
    mkdirSync(dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (err) {
    log.warn('写入 boot-state.json 失败', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * 装配启动开关。**必须在 app ready 之前调用**（Chromium 只在启动时读一次命令行）。
 */
export function applyStartupSwitches(isDev: boolean): StartupSwitchReport {
  const previous = loadState()
  const previousBootUnclean = previous.booting
  const crashStreak = previous.booting ? previous.crashStreak + 1 : 0

  const argv = process.argv
  const forceOff = process.env['CTEXT_SAFE_MODE'] === '0' || argv.includes('--no-safe-mode')

  let source: SafeModeSource = 'none'
  if (forceOff) {
    // 显式关掉：同时清掉粘性标记，否则下次启动又回到安全模式
    source = 'none'
  } else if (process.env['CTEXT_SAFE_MODE'] === '1') {
    source = 'env'
  } else if (argv.includes('--safe-mode')) {
    source = 'argv'
  } else if (crashStreak > 0) {
    source = 'fallback'
  } else if (previous.safeMode) {
    // 粘性：这台机器已经证明过沙箱不可用，不必每次启动都先崩一遍再回退。
    // 想恢复到默认沙箱：删掉 boot-state.json，或用 CTEXT_SAFE_MODE=0 / --no-safe-mode 启动一次。
    source = 'fallback'
  } else if (isDev) {
    source = 'dev'
  }

  const safeMode = source !== 'none'
  const switches: string[] = []

  if (safeMode) {
    // 顺序无所谓，但两条都要：只关 GPU 沙箱仍会让 Network service 起不来
    app.commandLine.appendSwitch('disable-gpu-sandbox')
    app.commandLine.appendSwitch('no-sandbox')
    switches.push('disable-gpu-sandbox', 'no-sandbox')
  }

  report = { safeMode, source, switches, crashStreak, previousBootUnclean }

  saveState({
    boots: previous.boots + 1,
    crashStreak,
    booting: true,
    safeMode,
    lastBootAt: new Date().toISOString()
  })

  return report
}

/** 当前启动的开关决策，供日志/自检读取 */
export function getSwitchReport(): StartupSwitchReport {
  return report
}

/**
 * 渲染层画完第一帧：标记本次启动成功，并撤掉看门狗。
 * 幂等——重复调用只生效一次。
 */
export function markFirstPaint(): void {
  if (firstPaint) return
  firstPaint = true
  stopWatchdog()
  saveState({ booting: false, crashStreak: 0, lastHealthyAt: new Date().toISOString() })
}

/**
 * 记录一次「启动过程中出的问题」，并决定是否自动回退安全模式重启。
 * 只在第一帧之前有意义的失败才会重启；已经正常起过来的崩溃交给 errors/install.ts 的通用兜底。
 */
export function noteBootFailure(reason: string, detail: Record<string, unknown> = {}): void {
  if (firstPaint || quitting) return
  if (relaunching) return

  log.error(`启动阶段故障：${reason}`, detail)

  if (report.safeMode) {
    // 已经在安全模式还起不来，说明不是沙箱问题；别再重启了，否则无限循环
    log.error('安全模式下仍然失败，放弃自动重启（请查看日志或联系支持）')
    saveState({ lastFailure: `${reason} (safe-mode)` })
    return
  }

  relaunch()
}

/** 自动重启一次并带上 --safe-mode；标记先落盘，重启后即走安全模式 */
function relaunch(): void {
  if (relaunching) return
  relaunching = true

  saveState({
    crashStreak: state.crashStreak + 1,
    booting: true,
    safeMode: true,
    lastFailure: 'relaunch into safe mode'
  })

  const args = process.argv.slice(1).filter((a) => a !== '--safe-mode')
  args.push('--safe-mode')
  log.warn('自动以安全模式重启（关闭 GPU 沙箱与总沙箱）', { args })

  // 稍等一下，让写盘与日志落地；relaunch 后当前进程立即退出
  setTimeout(() => {
    // **必须先放锁**：新实例启动时若旧进程还持有单实例锁，会静默 app.quit()，
    // 表现为「窗口闪一下就没了，日志里连启动记录都没有」。
    // 这是实测踩到的坑（M0-07），不要删。
    app.releaseSingleInstanceLock()
    app.relaunch({ args })
    app.exit(0)
  }, 150)
}

/**
 * 启动看门狗：首帧超时 + 子进程崩溃。
 * 必须在 app ready 之后调用（要监听 app 事件与子进程）。
 */
export function installBootWatchdog(): void {
  if (report.safeMode || firstPaint) return

  app.on('child-process-gone', (_event, details) => {
    const type = details.type
    const name = details.name ?? ''
    if (type === 'GPU' || (type === 'Utility' && /network/i.test(name))) {
      noteBootFailure(`${type} 子进程异常退出`, { reason: details.reason, name })
    }
  })

  watchdogTimer = setTimeout(() => {
    if (!firstPaint) noteBootFailure('首帧超时', { timeoutMs: FIRST_PAINT_TIMEOUT_MS })
  }, FIRST_PAINT_TIMEOUT_MS)
  // 看门狗不能把进程钉住：它只是辅助
  watchdogTimer.unref?.()
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

/** 正常退出：把 booting 落成 false，下次才不会误判为非正常退出 */
export function markCleanExit(): void {
  quitting = true
  stopWatchdog()
  // 正在做的"自动重启"不是正常退出：状态由 relaunch() 写好了，别在这里覆盖
  if (relaunching) return
  if (firstPaint) return
  // 没画完第一帧就退出（用户主动杀进程 / 初始化失败主动 quit）：
  // 不算崩溃，把 booting 清掉并回退 crashStreak
  saveState({ booting: false, crashStreak: Math.max(0, state.crashStreak - 1) })
}
