import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'

const isDev = !app.isPackaged

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
