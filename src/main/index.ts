import { app, BrowserWindow, screen, session, shell } from 'electron'
import { join } from 'node:path'
import { disposePythonBridge, getPythonBridge } from './bridge'
import { runBridgeSmoke } from './bridge/smoke'
import { closeDatabase, getDb, initDatabase } from './db/connection'
import { runDbSmoke } from './db/smoke'
import { installGlobalErrorHandlers, reportFatal } from './errors/install'
import { createLogger, initLogging, shutdownLogging } from './log'
import { runLogSmoke } from './log/smoke'
import { registerLogIpc } from './ipc/log'
import { installIpc } from './ipc/registry'
import { runIpcSmoke } from './ipc/smoke'
import { registerRootsIpc } from './ipc/roots'
import { registerBooksIpc } from './ipc/books'
import { registerShelvesIpc } from './ipc/shelves'
import { registerCategoriesIpc } from './ipc/categories'
import { registerReaderIpc } from './ipc/reader'
import { registerSettingsIpc } from './ipc/settings'
import { registerBookmarksIpc } from './ipc/bookmarks'
import { installAssetProtocol, registerAssetScheme } from './protocol/assets'
import { registerImportIpc } from './ipc/import'
import { registerSystemIpc } from './ipc/system'
import { attachWindowStateEvents, registerWindowIpc } from './ipc/window'
import { installRootsMonitor, stopRootsMonitor } from './library/roots-monitor'
import { runRootsSmoke } from './library/roots-smoke'
import { runScannerSmoke } from './library/scanner-smoke'
import { runDedupeSmoke } from './library/dedupe-smoke'
import { runParseBridgeSmoke } from './library/parse-bridge-smoke'
import { runEpubSmoke } from './library/epub-smoke'
import { runImportSmoke } from './library/import-smoke'
import { runPackageSmoke } from './package/smoke'
import { runUiSmoke } from './ui/smoke'
import { seedUiFixture } from './ui/ui-fixture'
import { runListSmoke } from './ui/list-smoke'
import { runSearchSmoke } from './ui/search-smoke'
import { runFavoriteSmoke } from './ui/favorite-smoke'
import { runShelfSmoke } from './ui/shelf-smoke'
import { runCategorySmoke } from './ui/category-smoke'
import { runDetailSmoke } from './ui/detail-smoke'
import { runReaderSmoke } from './reader/smoke'
import { runReaderBigSmoke } from './reader/big-smoke'
import { runReaderUiSmoke } from './reader/ui-smoke'
import { runSettingsSmoke } from './settings/smoke'
import { runProgressSmoke } from './reader/progress-smoke'
import { runM1Smoke } from './milestone/m1-smoke'
import { runM2Smoke } from './milestone/m2-smoke'
import { runImportUiSmoke } from './ui/import-ui-smoke'
import {
  applyStartupSwitches,
  installBootWatchdog,
  markCleanExit,
  markFirstPaint,
  noteBootFailure
} from './platform/safe-mode'

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
 * M0-07：Chromium 启动开关 + 安全模式回退。
 *
 * 本机（虚拟显示适配器 / 安全软件环境）下 Chromium 子进程沙箱不可用：
 * - GPU 进程在 GPU 沙箱下以 0xC0000005 反复崩溃，最终 FATAL 拖死主进程（窗口一闪即退）
 * - Network service 起不来，页面永远加载不出来（表现为空窗口）
 *
 * 但生产包不能无脑全局关沙箱——那是安全边界。所以改成：
 * 默认带沙箱启动，上一次非正常退出 / GPU 崩溃 / 首帧超时才自动回退到安全模式
 * （关 GPU 沙箱 + 关总沙箱），并把结论持久化，之后启动直接走安全模式。
 * 详细规则见 platform/safe-mode.ts 顶部注释。
 *
 * 必须在 app ready 之前调用：Chromium 只在启动时读一次命令行。
 */
const switchReport = applyStartupSwitches(isDev)
if (switchReport.safeMode) {
  log.warn('以安全模式启动（Chromium 沙箱已关闭）', {
    source: switchReport.source,
    switches: switchReport.switches,
    crashStreak: switchReport.crashStreak
  })
}

/**
 * 极端情况下的兜底：设 CTEXT_DISABLE_GPU=1 强制软件渲染。
 * 必须在 app ready 之前调用。
 */
if (process.env['CTEXT_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
}

// 自定义协议必须在 app ready 之前登记特权（标准/安全/可 fetch），
// 之后再调用会被 Electron 忽略，表现为图片一律加载失败。
registerAssetScheme()

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
          "default-src 'self'; img-src 'self' data: ctext-asset:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'"
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

  // 首帧到达 = 本次启动成功：撤看门狗、清崩溃计数
  mainWindow.webContents.on('did-finish-load', () => markFirstPaint())

  // 主框架加载失败通常是渲染链路整体不可用（沙箱/GPU 的典型症状），
  // 交给启动看门狗决定要不要回退安全模式重启
  mainWindow.webContents.once('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) noteBootFailure('渲染层加载失败', { code, description })
  })

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

    // M0-07：看门狗要在窗口出现之前装好，否则 GPU 一启动就崩的话没人记账
    installBootWatchdog()

    log.info('cText 启动', {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isDev,
      packaged: app.isPackaged,
      secureMode: switchReport.safeMode ? 'safe' : 'default',
      secureModeSource: switchReport.source,
      userData: app.getPath('userData')
    })

    // M0-04：先登记各域 handler，再由 registry 统一安装（未实现的通道装占位）
    registerWindowIpc()
    registerSystemIpc()
    registerLogIpc()
    registerRootsIpc()
    registerBooksIpc()
    registerShelvesIpc()
    registerCategoriesIpc()
    registerImportIpc()
    registerReaderIpc()
    registerSettingsIpc()
    registerBookmarksIpc()
    installAssetProtocol()
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

    // M1-02 自检：目录扫描器。纯主进程，不需要窗口，改扫描逻辑时能高频跑
    if (!app.isPackaged && process.env['CTEXT_SCAN_SMOKE'] === '1') {
      const checks = await runScannerSmoke()
      for (const c of checks) {
        console.log(`SMOKE SCAN ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE SCAN SUMMARY ${checks.length - failed}/${checks.length}`)
      app.exit(failed === 0 ? 0 : 1)
      return
    }

    // M1-03 自检：内容指纹与去重。用独立临时库，不碰真实书库
    if (!app.isPackaged && process.env['CTEXT_DEDUPE_SMOKE'] === '1') {
      const checks = await runDedupeSmoke()
      for (const c of checks) {
        console.log(`SMOKE DEDUPE ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE DEDUPE SUMMARY ${checks.length - failed}/${checks.length}`)
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

    // M0-08 自检：侧栏五个入口、选中态唯一性、书库根目录过滤、两个折叠、空页面。
    // M1-08 起列表是真实数据，先往临时库里 seed 确定性 fixture（断言数字与其对齐）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_UI_SMOKE'] === '1') {
      seedUiFixture(getDb())
      await runUiSmoke(mainWindow)
      return
    }

    // M1-08 自检：1 万本压测（接口 P95 / 虚拟 DOM 有界 / 滚动帧率 / 触底分页）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_LIST_SMOKE'] === '1') {
      await runListSmoke(mainWindow)
      return
    }

    // M1-10 自检：搜索（FTS 前缀命中 / 索引同步 / 200ms 防抖 / 离线标注）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_SEARCH_SMOKE'] === '1') {
      await runSearchSmoke(mainWindow)
      return
    }

    // M3-01 自检：收藏（纯标记不改缓存版本号 / 星标 / 侧栏计数 / 收藏页移除）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_FAVORITE_SMOKE'] === '1') {
      await runFavoriteSmoke(mainWindow)
      return
    }

    // M3-02 自检：书架（CRUD / 架内顺序 / 拖书入架 / 删除不删书）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_SHELF_SMOKE'] === '1') {
      await runShelfSmoke(mainWindow)
      return
    }

    // M3-03 自检：分类（多对多 / 筛选 OR / 与排序叠加 / CRUD）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_CATEGORY_SMOKE'] === '1') {
      await runCategorySmoke(mainWindow)
      return
    }

    // M3-04 自检：书籍详情（元信息编辑 + 搜索同步 / 章节虚拟滚动 / 书签跳转）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_DETAIL_SMOKE'] === '1') {
      await runDetailSmoke(mainWindow)
      return
    }

    // M2 出口验收：20MB 首屏 / 五套主题对比度 / 拔插硬盘后进度与书签无损
    if (!app.isPackaged && mainWindow && process.env['CTEXT_M2_SMOKE'] === '1') {
      await runM2Smoke(mainWindow, process.env['CTEXT_M2_DIR'] ?? '')
      return
    }

    // M2-08 自检：进度（写 → 强杀 → 重开恢复，由 verify-progress.mjs 分两段进程驱动）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_PROGRESS_SMOKE'] === '1') {
      await runProgressSmoke(
        mainWindow,
        process.env['CTEXT_PROGRESS_DIR'] ?? '',
        process.env['CTEXT_PROGRESS_PHASE'] === 'read' ? 'read' : 'write'
      )
      return
    }

    // M2-07 自检：设置读写（默认值 / 合并语义 / 分区隔离 / 坏数据容错 / 入参校验）
    if (!app.isPackaged && process.env['CTEXT_SETTINGS_SMOKE'] === '1') {
      runSettingsSmoke()
      return
    }

    // M2-04 自检：分页引擎（真实排版 / 翻页 / 改字号 / 缩放后位置不跳 / 重排耗时）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_READER_UI_SMOKE'] === '1') {
      await runReaderUiSmoke(mainWindow, process.env['CTEXT_READER_UI_DIR'] ?? '')
      return
    }

    // M2-02 自检：大文件（200MB 不 OOM / 翻页不卡 / 单章超窗）
    if (!app.isPackaged && process.env['CTEXT_READER_BIG_SMOKE'] === '1') {
      await runReaderBigSmoke()
      return
    }

    // M2-01 自检：内容通路（TXT 字节区间读 / 编码 / 转义 / LRU / 预取 / 五类失败）
    if (!app.isPackaged && mainWindow && process.env['CTEXT_READER_SMOKE'] === '1') {
      await runReaderSmoke(mainWindow)
      return
    }

    // M1 出口验收：500 本一键导入 / 拔盘保留 / 插回恢复（万级列表由 verify:list 覆盖）
    if (!app.isPackaged && process.env['CTEXT_M1_SMOKE'] === '1') {
      await runM1Smoke()
      return
    }

    // M1-07 自检：导入交互（真实拖放 → 预览分类 → 导入 → 结果 → 重复不脏 → 取消）。
    // 必须用 --user-data-dir=<临时目录>；样本目录由 verify-import-ui.mjs 建好传入
    if (!app.isPackaged && mainWindow && process.env['CTEXT_IMPORT_UI_SMOKE'] === '1') {
      const booksDir = process.env['CTEXT_IMPORT_UI_DIR']
      const cancelDir = process.env['CTEXT_IMPORT_UI_CANCEL_DIR']
      const clipDir = process.env['CTEXT_IMPORT_UI_CLIP_DIR']
      if (!booksDir || !cancelDir || !clipDir) {
        console.log('SMOKE IMPORTUI FAIL 缺少 CTEXT_IMPORT_UI_DIR / CTEXT_IMPORT_UI_CANCEL_DIR / CTEXT_IMPORT_UI_CLIP_DIR')
        await disposePythonBridge()
        app.exit(1)
        return
      }
      await runImportUiSmoke(mainWindow, { booksDir, cancelDir, clipDir })
      return
    }

    // M1-01 自检：根目录登记 / 掉线恢复 / 重定位 / 移除 + roots:changed 广播。
    // 必须用 --user-data-dir=<临时目录> 启动，否则会往真实书库里写测试根目录。
    if (!app.isPackaged && mainWindow && process.env['CTEXT_ROOTS_SMOKE'] === '1') {
      const code = await runRootsSmoke(mainWindow)
      await disposePythonBridge()
      app.exit(code)
      return
    }

    getPythonBridge().start()

    // M1-01：根目录状态监测。启动检测不阻塞窗口，焦点检测按 30s 节流
    installRootsMonitor()

    // M1-04 自检：TXT 解析经 Python bridge 的完整链路（算法准确性在 python/smoke_parse.py）
    if (!app.isPackaged && process.env['CTEXT_PARSE_SMOKE'] === '1') {
      const checks = await runParseBridgeSmoke()
      for (const c of checks) {
        console.log(`SMOKE PARSE ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE PARSE SUMMARY ${checks.length - failed}/${checks.length}`)
      await disposePythonBridge()
      app.exit(failed === 0 ? 0 : 1)
      return
    }

    // M1-05 自检：EPUB 解析经 Python bridge 的完整链路。
    // 样本由 verify-epub.mjs 用 python/smoke_epub.py --emit 先铺好，两边共用同一批文件
    if (!app.isPackaged && process.env['CTEXT_EPUB_SMOKE'] === '1') {
      const checks = await runEpubSmoke()
      for (const c of checks) {
        console.log(`SMOKE EPUBCHAIN ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE EPUBCHAIN SUMMARY ${checks.length - failed}/${checks.length}`)
      await disposePythonBridge()
      app.exit(failed === 0 ? 0 : 1)
      return
    }

    // M1-06 自检：导入任务队列（预览分类 / 首次导入 / 重复 / 覆盖 / 失败隔离 / 取消一致性）。
    // 用独立临时库 + 临时目录，不碰真实书库；EPUB 样本由 verify-import.mjs 预先铺好
    if (!app.isPackaged && process.env['CTEXT_IMPORT_SMOKE'] === '1') {
      const checks = await runImportSmoke()
      for (const c of checks) {
        console.log(`SMOKE IMPORT ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
      }
      const failed = checks.filter((c) => !c.ok).length
      console.log(`SMOKE IMPORT SUMMARY ${checks.length - failed}/${checks.length}`)
      await disposePythonBridge()
      app.exit(failed === 0 ? 0 : 1)
      return
    }

    // M0-07：生产包自检（scripts/verify-package.mjs 触发）。
    // 与上面的开发态自检相反——这里**只在** isPackaged 为真时才有意义。
    if (mainWindow && process.env['CTEXT_PACKAGE_SMOKE'] === '1') {
      const code = await runPackageSmoke(mainWindow)
      await disposePythonBridge()
      app.exit(code)
      return
    }

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
    stopRootsMonitor()
    closeDatabase()
    void disposePythonBridge()
    // 启动状态落干净：正常退出不该在下次启动时被当成崩溃
    markCleanExit()
    // 最后一步：关掉日志句柄。写是同步的，所以这之前的所有行都已在磁盘上
    log.info('cText 退出')
    shutdownLogging()
  })
}
