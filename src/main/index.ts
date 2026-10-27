import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'

const isDev = !app.isPackaged

/**
 * 本机同时存在 MuMu / GameViewer 等虚拟显示适配器，Chromium 的 GPU 进程在
 * GPU 沙箱下会以 0xC0000005 反复崩溃，最终 FATAL 拖死主进程（表现为窗口一闪即退）。
 * 开发态关闭 GPU 沙箱规避；生产包的策略留给 M0-07 打包时定。
 */
if (isDev) app.commandLine.appendSwitch('disable-gpu-sandbox')

/**
 * 极端情况下的兜底：设 CTEXT_DISABLE_GPU=1 强制软件渲染。
 * 必须在 app ready 之前调用。
 */
if (process.env['CTEXT_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
}

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
    minWidth: 1024,
    minHeight: 680,
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

  // 外链交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    applyCsp()
    registerWindowIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
