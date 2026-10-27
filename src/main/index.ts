import { app, BrowserWindow, ipcMain, screen, session, shell } from 'electron'
import { join } from 'node:path'

const isDev = !app.isPackaged

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

  const pushWindowState = () => {
    if (!mainWindow) return
    mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() })
  }
  mainWindow.on('maximize', pushWindowState)
  mainWindow.on('unmaximize', pushWindowState)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerWindowIpc() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
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

  app.whenReady().then(() => {
    applyCsp()
    registerWindowIpc()
    createWindow()

    if (!app.isPackaged && process.env['CTEXT_SMOKE'] === '1' && mainWindow) {
      void runSmoke(mainWindow)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
