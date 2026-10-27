import { app, BrowserWindow, screen, session, shell } from 'electron'
import { join } from 'node:path'
import { disposePythonBridge, getPythonBridge } from './bridge'
import { runBridgeSmoke } from './bridge/smoke'
import { closeDatabase, initDatabase } from './db/connection'
import { runDbSmoke } from './db/smoke'
import { installGlobalErrorHandlers, reportFatal } from './errors/install'
import { createLogger, initLogging, shutdownLogging } from './log'
import { runLogSmoke } from './log/smoke'
import { registerLogIpc } from './ipc/log'
import { installIpc } from './ipc/registry'
import { runIpcSmoke } from './ipc/smoke'
import { registerSystemIpc } from './ipc/system'
import { attachWindowStateEvents, registerWindowIpc } from './ipc/window'

const isDev = !app.isPackaged

/**
 * M0-06：日志必须最早初始化。
 * `app.getPath` 在 ready 之前就可用，所以这里放在模块顶层——
 * 之后任何一个模块的 createLogger 都能直接落盘，不会漏掉启动阶段。
 */
initLogging({ dir: join(app.getPath('userData'), 'logs') })
const log = createLogger('app')

/** 兜底要在任何业务代码之前生效，否则启动阶段的异常没人接 */
installGlobalErrorHandlers()

/**
 * 本机（含虚拟显示适配器与安全软件）环境下 Chromium 的子进程沙箱不可用：
 * - GPU 进程在 GPU 沙箱下以 0xC0000005 反复崩溃，最终 FATAL 拖死主进程（窗口一闪即退）
 * - Network service 起不来，页面永远加载不出来（表现为空窗口）
 * 开发态同时关闭两者；生产包的沙箱策略留给 M0-07 打包时定。
 */
if (isDev) {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('no-sandbox')
}

/**
 * 极端情况下的兜底：设 CTEXT_DISABLE_GPU=1 强制软件渲染。
 * 必须在 app ready 之前调用。
 */
if (process.env['CTEXT_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
}

/** 最小窗口尺寸（产品文档 §2.2 布局规则） */
const MIN_WIDTH = 1024
const MIN_HEIGHT = 680

/**
 * 生产环境 CSP：渲染层不允许联网，外网请求一律走主进程。
 * 开发环境不加，否则 Vite HMR 的 ws 与内联样式会被拦。
 */
function applyCsp() {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'"
        ]
      }
    })
  })
}

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,
    show: false,
    frame: false,
    backgroundColor: '#17181a',
    title: 'cText',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 外链交给系统浏览器，不在应用内开新窗口，且只放行 http/https
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染层被导航到外部地址时同样拦截
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (rendererUrl && url.startsWith(rendererUrl)) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (isDev && rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  attachWindowStateEvents(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * M0-02 冒烟自检：仅开发态且 CTEXT_SMOKE=1 时执行，
 * 验证最小尺寸夹紧、最大化状态回推、拖拽区样式与窗口居中后退出。
 * 生产包（app.isPackaged）永远进不了这个分支。
 */
async function runSmoke(win: BrowserWindow) {
  const results: { name: string; ok: boolean; detail: string }[] = []
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const js = (code: string) => win.webContents.executeJavaScript(code) as Promise<string>

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.log(`[smoke] 渲染层 did-fail-load ${code} ${desc}`)
      resolve()
    })
  })

  await wait(800)

  // 居中要在改动窗口尺寸之前测：setSize 与 maximize/unmaximize 都会改变 bounds
  const bounds = win.getBounds()
  const work = screen.getDisplayMatching(bounds).workArea
  const dx = bounds.x + bounds.width / 2 - (work.x + work.width / 2)
  const dy = bounds.y + bounds.height / 2 - (work.y + work.height / 2)
  check('窗口居中', Math.abs(dx) < 40 && Math.abs(dy) < 40, `偏移 ${Math.round(dx)},${Math.round(dy)}`)

  win.setSize(800, 600)
  await wait(150)
  const [w, h] = win.getSize()
  check('最小尺寸夹紧 1024x680', w === MIN_WIDTH && h === MIN_HEIGHT, `实际 ${w}x${h}`)

  win.maximize()
  await wait(350)
  const maxBtn = await js(`document.querySelector('header [title="还原"]') ? '还原' : '最大化'`)
  check(
    '最大化后渲染层收到 window:state',
    win.isMaximized() && maxBtn === '还原',
    `isMaximized=${win.isMaximized()} 按钮=${maxBtn}`
  )

  win.unmaximize()
  await wait(350)
  const normalBtn = await js(`document.querySelector('header [title="最大化"]') ? '最大化' : '还原'`)
  check('还原后状态回落', !win.isMaximized() && normalBtn === '最大化', `按钮=${normalBtn}`)

  const drag = await js(`getComputedStyle(document.querySelector('header.app-drag')).webkitAppRegion`)
  check('标题栏为拖拽区', drag === 'drag', `app-region=${drag}`)

  const noDrag = await js(`getComputedStyle(document.querySelector('header .app-no-drag')).webkitAppRegion`)
  check('按钮区为 no-drag', noDrag === 'no-drag', `app-region=${noDrag}`)

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`SMOKE ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
  }
  console.log(`SMOKE SUMMARY ${results.length - failed.length}/${results.length}`)
  win.destroy()
  app.exit(failed.length === 0 ? 0 : 1)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 窗口若已被销毁，第二实例负责重建；否则还原并聚焦
    if (!mainWindow) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    applyCsp()

    log.info('cText 启动', {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isDev,
      userData: app.getPath('userData')
    })

    // M0-04：先登记各域 handler，再由 registry 统一安装（未实现的通道装占位）
    registerWindowIpc()
    registerSystemIpc()
    registerLogIpc()
    installIpc()

    // M0-03：数据库在窗口创建之前初始化，失败则不进入界面
    const dbFile = join(app.getPath('userData'), 'ctext.db')
    try {
      const { migration } = initDatabase(dbFile)
      if (migration.applied.length > 0) {
        log.info('数据库已迁移', { file: dbFile, from: migration.from, to: migration.to })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 库建不起来等于什么都做不了，仍然用系统对话框（此时界面还不存在，toast 无处可弹）
      reportFatal('数据库初始化失败', `${dbFile}\n\n${message}`, err)
      app.quit()
      return
    }

    if (!app.isPackaged && process.env['CTEXT_DB_SMOKE'] === '1') {
      console.log(`SMOKE DB INFO dbfile=${dbFile}`)
      const checks = runDbSmoke()
      for (const c of checks) {
        console.log(`SMOKE DB ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE DB SUMMARY ${checks.length - failed}/${checks.length}`)
      app.exit(failed === 0 ? 0 : 1)
      return
    }

    createWindow()

    // M0-06 自检：日志落盘 / 脱敏 / 级别 / 耗时 / 错误码映射 / 全局兜底
    if (!app.isPackaged && mainWindow && process.env['CTEXT_LOG_SMOKE'] === '1') {
      await runLogSmoke(mainWindow)
      return
    }

    // M0-05：worker 在后台拉起，不阻塞窗口（冷启动 ≤2s 的要求）。失败只影响解析，
    // 不影响浏览已有数据，所以这里不等它、也不因它退出应用。
    if (!app.isPackaged && process.env['CTEXT_BRIDGE_SMOKE'] === '1') {
      const code = await runBridgeSmoke(mainWindow)
      await disposePythonBridge()
      app.exit(code)
      return
    }

    getPythonBridge().start()

    if (!app.isPackaged && mainWindow) {
      if (process.env['CTEXT_IPC_SMOKE'] === '1') {
        void runIpcSmoke(mainWindow)
        return
      }
      if (process.env['CTEXT_SMOKE'] === '1') void runSmoke(mainWindow)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 正常退出时关闭连接，让 WAL 落盘并清掉 -wal / -shm；
  // 同时停掉 Python worker（关 stdin 让它自己退，避免留下孤儿进程）
  app.on('will-quit', () => {
    closeDatabase()
    void disposePythonBridge()
    // 最后一步：关掉日志句柄。写是同步的，所以这之前的所有行都已在磁盘上
    log.info('cText 退出')
    shutdownLogging()
  })
}
