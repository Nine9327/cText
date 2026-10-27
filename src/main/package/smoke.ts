/**
 * 生产包自检（M0-07）。只在 `CTEXT_PACKAGE_SMOKE=1` 时执行，由 scripts/verify-package.mjs 触发。
 *
 * 为什么必须在"打包后"跑，而不是开发态跑同样的断言：
 * 开发态 `app.isPackaged === false`，`process.resourcesPath` 指向 node_modules 里的
 * electron 目录，所有与打包相关的路径（asar、extraResources、PyInstaller 产物）
 * 全是假的。这里断言的每一条都只有真包才成立。
 *
 * 输出：控制台（unpacked 直接跑时能看到）+ JSON 报告。
 * 打包成 GUI 应用后 Windows 不会把 stdout 接到父进程的控制台，因此**脚本以 JSON 报告为准**。
 */
import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPythonBridge } from '../bridge'
import { resolveLaunch } from '../bridge/launch'
import { getLogDir, getLogFilePath } from '../log'
import { getSwitchReport } from '../platform/safe-mode'

export interface PackageSmokeCheck {
  name: string
  ok: boolean
  detail: string
}

export interface PackageSmokeReport {
  ok: boolean
  checkedAt: string
  checks: PackageSmokeCheck[]
  info: Record<string, unknown>
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function workerExePath(): string {
  return join(
    process.resourcesPath,
    'python',
    'ctext-worker',
    process.platform === 'win32' ? 'ctext-worker.exe' : 'ctext-worker'
  )
}

async function waitForWindow(win: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!win.isDestroyed() && !win.webContents.isLoading()) return true
    await wait(100)
  }
  return false
}

async function waitForWorker(timeoutMs: number): Promise<{ state: string; pid: number | null }> {
  const bridge = getPythonBridge()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = bridge.getStatus()
    if (status.state === 'ready' || status.state === 'failed') {
      return { state: status.state, pid: status.pid }
    }
    await wait(100)
  }
  const status = bridge.getStatus()
  return { state: status.state, pid: status.pid }
}

export async function runPackageSmoke(win: BrowserWindow): Promise<number> {
  const checks: PackageSmokeCheck[] = []
  const check = (name: string, ok: boolean, detail: string | number | boolean = '') => {
    checks.push({ name, ok, detail: String(detail) })
  }

  const appPath = app.getAppPath()
  const exe = workerExePath()
  const switches = getSwitchReport()

  // ---------------------------------------------------------------- 1. 包形态
  check('app.isPackaged', app.isPackaged, app.isPackaged)
  check('代码在 asar 内', appPath.endsWith('app.asar'), appPath)
  check('resourcesPath 指向 install 目录', process.resourcesPath.includes('resources'), process.resourcesPath)

  // ---------------------------------------------------------------- 2. Python 产物
  // 最关键的一条：worker 必须落在 app.asar **外面**，asar 里的 exe 根本执行不了
  check('worker 可执行文件存在于 resources/python 下', existsSync(exe), exe)
  check('worker 不在 asar 内', !exe.includes('app.asar'), exe)
  const onedir = join(process.resourcesPath, 'python', 'ctext-worker')
  check('PyInstaller _internal 目录齐全', existsSync(join(onedir, '_internal')), onedir)

  const plan = resolveLaunch()
  check('启动命令解析到同一路径', plan.command === exe, plan.command)
  check('启动目录存在', existsSync(plan.cwd), plan.cwd)

  // ---------------------------------------------------------------- 3. worker 真实可用
  const worker = await waitForWorker(12_000)
  check('worker 进入 ready', worker.state === 'ready', `${worker.state} pid=${worker.pid}`)

  if (worker.state === 'ready') {
    try {
      const health = await getPythonBridge().ping(8_000)
      check('health.ping 有响应', typeof health.pid === 'number', `pid=${health.pid}`)
      check('协议版本为 1', health.protocol === 1, health.protocol)
      check('worker pid 与进程状态一致', health.pid === worker.pid, `${health.pid}/${worker.pid}`)
      const deps = Object.entries(health.deps)
      const missing = deps.filter(([, ok]) => !ok).map(([n]) => n)
      check('解析依赖全部就位', missing.length === 0, missing.length === 0 ? `${deps.length} 个` : missing.join(','))
    } catch (err) {
      check('health.ping 有响应', false, err instanceof Error ? err.message : String(err))
    }
  }

  // ---------------------------------------------------------------- 4. 数据与日志
  const dbFile = join(app.getPath('userData'), 'ctext.db')
  check('数据库已创建', existsSync(dbFile), dbFile)

  const logDir = getLogDir()
  const logFile = getLogFilePath()
  check('日志目录存在', !!logDir && existsSync(logDir), logDir ?? 'null')
  check(
    '当前日志文件已写入',
    !!logFile && existsSync(logFile) && statSync(logFile).size > 0,
    logFile ? `${statSync(logFile).size}B` : 'null'
  )

  // ---------------------------------------------------------------- 5. 渲染层
  const painted = await waitForWindow(win, 12_000)
  check('渲染层加载完成', painted, win.webContents.isLoading() ? '仍在加载' : 'ok')
  if (painted) {
    const url = win.webContents.getURL()
    check('渲染层来自本地文件', url.startsWith('file://'), url.slice(0, 60))
    try {
      const nodes = (await win.webContents.executeJavaScript(
        `document.querySelector('#app')?.childElementCount ?? 0`
      )) as number
      check('Vue 已挂载', nodes > 0, `#app 子节点 ${nodes}`)
    } catch (err) {
      check('Vue 已挂载', false, err instanceof Error ? err.message : String(err))
    }
    // 用户数据目录不能落在安装目录里（Program Files 无写权限）
    check(
      'userData 不在安装目录内',
      !app.getPath('userData').startsWith(appPath.replace(/app\.asar$/, '')),
      app.getPath('userData')
    )
  }

  // ---------------------------------------------------------------- 6. 安全模式决策
  // 不断言"必须是安全模式"（取决于机器），只断言决策自洽：
  // 开了安全模式就必须真的把两个开关都下发了，没开就一个都没有
  const expected = switches.safeMode ? ['disable-gpu-sandbox', 'no-sandbox'] : []
  check(
    '安全模式开关与决策一致',
    JSON.stringify(switches.switches) === JSON.stringify(expected),
    `${switches.source}: ${switches.switches.join(',') || '(无)'}`
  )

  // ---------------------------------------------------------------- 汇总
  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) {
    console.log(`PACKAGE SMOKE ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  }
  console.log(`PACKAGE SMOKE SUMMARY ${checks.length - failed.length}/${checks.length}`)

  const report: PackageSmokeReport = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    info: {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      appPath,
      resourcesPath: process.resourcesPath,
      workerExe: exe,
      workerPid: worker.pid,
      userData: app.getPath('userData'),
      logFile,
      safeMode: switches.safeMode,
      safeModeSource: switches.source,
      switches: switches.switches,
      crashStreak: switches.crashStreak,
      previousBootUnclean: switches.previousBootUnclean,
      argv: process.argv,
      bootState: (() => {
        // 启动状态文件：脚本据此判断"是不是自动回退过一次"
        try {
          const raw = readFileSync(join(app.getPath('userData'), 'boot-state.json'), 'utf8')
          return JSON.parse(raw) as unknown
        } catch {
          return null
        }
      })(),
      installedFiles: (() => {
        // 安装目录下顶层条目数，用来确认是"安装"而不是就地跑
        try {
          return readdirSync(join(process.resourcesPath, '..')).length
        } catch {
          return 0
        }
      })()
    }
  }

  const out = process.env['CTEXT_SMOKE_OUT']
  if (out) {
    try {
      mkdirSync(join(out, '..'), { recursive: true })
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.log(`PACKAGE SMOKE REPORT ${out}`)
    } catch (err) {
      console.error(`写报告失败 ${out}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return report.ok ? 0 : 1
}
