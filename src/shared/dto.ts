/**
 * 跨进程传输的数据结构（主进程与渲染层共用）。
 *
 * 约定：
 * - 时间戳一律 Unix ms 数字；
 * - 字段名 camelCase，下划线命名止步于 DB 层（repository 负责映射）；
 * - 布尔字段在 DTO 层一律 boolean，`0/1` 只存在于 SQLite 的 INTEGER 列。
 *
 * 本文件在 M0-04 定稿（依据 docs/产品文档.md §3.6 / §3.7）。M1 各任务落地时
 * 只允许**新增字段**或新增 DTO，不允许修改既有字段的含义——否则渲染层会静默拿到错的数据。
 */

export type BookFormat = 'txt' | 'epub' | 'pdf'
export type BookSourceType = 'local' | 'network'
export type ReadState = 'unread' | 'reading' | 'finished'
export type RootState = 'online' | 'offline'
export type CompatLevel = 'full' | 'partial' | 'unsupported'
export type BookmarkKind = 'bookmark' | 'highlight'

/** 所有列表接口的统一分页信封 */
export interface Paged<T> {
  items: T[]
  /** 符合条件的总数（用于滚动加载与「共 N 本」） */
  total: number
  offset: number
  limit: number
}

// ---------------------------------------------------------------- 书籍

export interface BookDTO {
  id: string
  title: string
  author: string | null
  series: string | null
  format: BookFormat
  /** 封面地址；无封面为 null，由 UI 用「书名 + 哈希取色」生成占位 */
  coverUrl: string | null
  favorite: boolean
  readState: ReadState
  /** 0 ~ 1 */
  progress: number
  chapterCount: number
  /** 本地书所属根目录；网络书为 null */
  rootId: string | null
  sourceType: BookSourceType
  /** 所属根目录当前为 offline 时为 true（书籍记录仍保留）；网络书恒 false */
  offline: boolean
  lastReadAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CategoryDTO {
  id: string
  name: string
  color: string | null
  sort: number
  /** 该分类下的书籍数（M3-03）。侧栏筛选与统计都要它，别再单开计数通道 */
  bookCount: number
}

/**
 * 重新识别结果（M3-06）。
 *
 * `changed` 是给界面说「变了什么」用的：只说「识别完成」等于什么都没说，
 * 用户无法判断该不该保留这次结果（失败时库里一个字段都不会变）。
 */
export interface RematchResultDTO {
  changed: string[]
  before: { title: string; author: string | null; chapterCount: number }
  after: { title: string; author: string | null; chapterCount: number }
  book: BookDetailDTO | null
}

export interface ShelfRefDTO {
  id: string
  name: string
}

export interface BookDetailDTO extends BookDTO {
  intro: string | null
  publisher: string | null
  pubDate: string | null
  language: string | null
  wordCount: number | null
  sizeBytes: number
  /** 探测出的文本编码（txt 才有） */
  encoding: string | null
  /** 相对根目录的路径；网络书为 null */
  relPath: string | null
  sourceId: string | null
  sourceUrl: string | null
  categories: CategoryDTO[]
  shelves: ShelfRefDTO[]
}

/**
 * 排序字段（M1-09，M3-02 加 `shelfOrder`）。
 *
 * `shelfOrder` 只在书架域有意义：它按 `shelf_books.sort` 排，方向恒为升序
 * （「架内顺序」是一个列表位置，反转没有语义）。没有 `shelfId` 时仓储会
 * 退回「导入时间倒序」而不是报错——排序菜单是跨三入口共享的，用户从书架页
 * 回到书库页时可能刚好还选中它。
 */
export type BookSortField = 'lastReadAt' | 'title' | 'author' | 'progress' | 'createdAt' | 'shelfOrder'

export interface BookSort {
  field: BookSortField
  direction: 'asc' | 'desc'
}

export interface BookQuery {
  /** 走 FTS5 匹配 title / author / series / intro */
  keyword?: string
  rootId?: string
  shelfId?: string
  categoryId?: string
  favoriteOnly?: boolean
  readState?: ReadState
  /** 默认 true：离线书仍列出并在 UI 标「离线」角标 */
  includeOffline?: boolean
  sort?: BookSort
  offset?: number
  limit?: number
}

// ---------------------------------------------------------------- 根目录

export interface RootDTO {
  id: string
  label: string
  path: string
  volumeGuid: string | null
  state: RootState
  sort: number
  /** 该根目录下未删除的书籍数 */
  bookCount: number
  lastCheckAt: number | null
  createdAt: number
}

// ---------------------------------------------------------------- 书架 / 分类

export interface ShelfDTO {
  id: string
  name: string
  icon: string | null
  sort: number
  bookCount: number
  createdAt: number
}

// ---------------------------------------------------------------- 导入

export type ScanItemStatus = 'new' | 'duplicate' | 'unsupported' | 'empty' | 'failed'

export interface ScanPreviewItemDTO {
  /** 相对扫描根目录的路径 */
  relPath: string
  sizeBytes: number
  /** 扩展名不识别时为 null */
  format: BookFormat | null
  status: ScanItemStatus
  /** status=duplicate 时指向书库中已存在的记录 */
  duplicateOf: { bookId: string; title: string; rootPath: string } | null
  /** status=unsupported 时给出原因 */
  reason: string | null
}

export interface ScanPreviewDTO {
  path: string
  /** 扫描耗时（ms），用于告知用户大目录的代价 */
  elapsedMs: number
  /** 命中总数（可能大于 items.length，见 truncated） */
  total: number
  items: ScanPreviewItemDTO[]
  /** items 是否被截断（超大目录只为预览列前 N 条，导入仍会处理全部） */
  truncated: boolean
}

export interface ImportOptions {
  /** 不传则自动匹配已有根目录 */
  rootId?: string
  /** 扫描目录未被登记时，是否同时登记为书库根目录 */
  registerAsRoot?: boolean
  /** 递归深度，默认 8 */
  scanDepth?: number
  /** 忽略规则（正则，作用于相对路径），来自设置的默认值 */
  ignorePattern?: string
  /** 去重命中的处理：skip 跳过 / overwrite 覆盖记录（默认 skip） */
  onDuplicate?: 'skip' | 'overwrite'
}

export type ImportPhase = 'queued' | 'scan' | 'parse' | 'commit' | 'done' | 'cancelled' | 'failed'

/** 单本导入失败。`relPath` 可直接复制给用户，`reason` 不含绝对路径（脱敏） */
export interface ImportFailureDTO {
  relPath: string
  reason: string
}

export interface ImportProgressDTO {
  taskId: string
  phase: ImportPhase
  /** 已完成数（各阶段语义相同：已处理的文件数） */
  processed: number
  total: number
  /** 当前正在处理的文件（相对路径） */
  currentPath: string | null
  /** 失败清单明细。**可能被截断**，真实总数以 `failedTotal` 为准 */
  failures: ImportFailureDTO[]
  /** 失败总数（不受 failures 截断影响） */
  failedTotal: number
  /** 新增入库数 */
  imported: number
  /** 覆盖已有记录数（`onDuplicate: 'overwrite'` 时可能大于 0） */
  updated: number
  /** 跳过的重复 / 空文件数 */
  skipped: number
}

// ---------------------------------------------------------------- 阅读

export interface ChapterDTO {
  idx: number
  title: string
  /**
   * 目录树层级：**0 = 卷/部（上层），1 = 章/回，2 = 更细的层级**。
   * 数字越小越靠近根——与 `chapters.level` 的 DDL 默认值 0 一致。
   * （M1-04 澄清：早期注释写成「0 为章、1 为卷」是笔误，会让目录树层级上下颠倒）
   */
  level: number
}

export interface ChapterContentDTO {
  bookId: string
  chapterIdx: number
  title: string
  /** 已净化的 HTML 片段 */
  html: string
  hasPrev: boolean
  hasNext: boolean
  /**
   * 本章超过单次读取窗口（M2-02，4MB），`html` 只是开头一段。
   * 病态文件（整本书一章）靠它把内存关在窗口内，正常章节恒为 undefined。
   */
  truncated?: boolean
}

export interface ProgressDTO {
  bookId: string
  chapterIdx: number
  /** 章内字符偏移 */
  offset: number
  /** 0 ~ 1 全书百分比 */
  percent: number
}

export interface BookmarkDTO {
  id: string
  bookId: string
  chapterIdx: number
  /** 起点字符偏移（章内） */
  offset: number
  /** 终点字符偏移（划线专用；纯书签为 null）。右开区间 */
  endOffset: number | null
  kind: BookmarkKind
  text: string | null
  note: string | null
  color: string | null
  createdAt: number
}

// ---------------------------------------------------------------- 书源

export interface SourceDTO {
  id: string
  name: string
  /** bookSourceUrl，同时作为书源唯一标识 */
  url: string
  group: string | null
  enabled: boolean
  /** 导入时判定的兼容级别 */
  compatLevel: CompatLevel
  /** 不兼容原因，compatLevel=full 时为 null */
  compatNote: string | null
  customOrder: number
  lastUsedAt: number | null
  createdAt: number
}

export type SourceImportStatus = 'imported' | 'updated' | 'skipped' | 'failed'

export interface SourceImportItemDTO {
  name: string | null
  url: string | null
  status: SourceImportStatus
  compatLevel: CompatLevel | null
  reason: string | null
}

export interface SourceImportResultDTO {
  imported: number
  updated: number
  skipped: number
  failed: number
  items: SourceImportItemDTO[]
}

export interface SearchOptions {
  /** 不传则搜索全部启用的书源 */
  sourceIds?: string[]
  page?: number
  /** 单源超时，默认 8000ms */
  timeoutMs?: number
  /** 同名合并（书名 + 作者归一化），默认 true */
  mergeSame?: boolean
}

export interface SourceSearchItemDTO {
  sourceId: string
  sourceName: string
  title: string
  author: string | null
  coverUrl: string | null
  intro: string | null
  /** 详情页 URL，加入书架时回传 */
  bookUrl: string
  kind: string | null
  lastChapter: string | null
}

export interface SourceSearchGroupDTO {
  sourceId: string
  sourceName: string
  items: SourceSearchItemDTO[]
  elapsedMs: number
}

export interface SourceSearchFailureDTO {
  sourceId: string
  sourceName: string
  code: string
  message: string
}

export interface SourceSearchResultDTO {
  keyword: string
  groups: SourceSearchGroupDTO[]
  failures: SourceSearchFailureDTO[]
  elapsedMs: number
}

// ---------------------------------------------------------------- 设置

export type ReaderTheme = 'day' | 'night' | 'eye' | 'paper' | 'system'
export type ReaderMode = 'paged' | 'scroll'
export type CloseAction = 'tray' | 'quit'

export interface ReaderSettingsDTO {
  /** 12 ~ 32 */
  fontSize: number
  /** 1.2 ~ 2.4 */
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  margin: number
  /** 字体名；system 表示跟随内置系统字体栈 */
  fontFamily: string
  theme: ReaderTheme
  customBg: string | null
  customText: string | null
  /**
   * 阅读模式。`'auto'` = 按书籍格式取默认（EPUB 滚动 / TXT 分页）；
   * 只有用户手动切过模式才会写成 `paged` / `scroll`。
   */
  mode: ReaderMode | 'auto'
  rememberProgress: boolean
}

export interface GeneralSettingsDTO {
  autoLaunch: boolean
  minimizeToTray: boolean
  closeAction: CloseAction
  language: 'zh-CN'
}

export interface StorageSettingsDTO {
  /** 封面缓存上限（MB） */
  coverCacheLimitMb: number
}

export interface SourceSettingsDTO {
  /** 网络书源一次性合规提示是否已确认 */
  complianceAccepted: boolean
  /** 正文缓存保留天数 */
  cacheTtlDays: number
}

export interface SettingsDTO {
  general: GeneralSettingsDTO
  reader: ReaderSettingsDTO
  storage: StorageSettingsDTO
  sources: SourceSettingsDTO
  /** 动作 → 键位，如 { "reader.next": "ArrowRight" } */
  shortcuts: Record<string, string>
}

// ---------------------------------------------------------------- 系统

export interface AppInfoDTO {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  isDev: boolean
  userDataPath: string
  dbPath: string
  /** 日志目录（M0-06 起）。「关于」页与问题反馈要展示它，用户直接去这里取日志 */
  logDir: string
  /** 是否运行在安全模式（关闭了 Chromium 沙箱）。问题反馈时要带上 */
  safeMode: boolean
  /** 进入安全模式的原因：dev / env / argv / fallback / none */
  safeModeSource: string
}

export interface EchoRequest {
  message: string
  /** 人为延迟，用于验证并发与 loading 态 */
  delayMs?: number
  /** 诊断用：'throw' 让 handler 抛异常，验证错误映射链路 */
  failMode?: 'none' | 'throw'
}

export interface EchoResponse {
  message: string
  /** 主进程收到请求的时间戳 */
  receivedAt: number
  /** 主进程侧处理耗时（ms） */
  handledInMs: number
  from: 'main'
}

/** Python worker 的生命周期状态，与 main/bridge/PythonBridge.ts 的 BridgeState 一致 */
export type WorkerState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

/**
 * worker 健康状态（诊断用）。
 *
 * `worker` 是 worker 自报的握手信息，未就绪时为 null——
 * UI 上「诊断」页据此显示「解析引擎：就绪 v0.1.0 / pid 1234」。
 */
export interface WorkerHealthDTO {
  state: WorkerState
  pid: number | null
  /** 累计自动重启次数 */
  restarts: number
  lastError: string | null
  worker: {
    version: string
    protocol: number
    pid: number
    python: string
    uptimeMs: number
    methods: string[]
    /** M1 的解析依赖是否就位（find_spec 结果，不触发真实导入） */
    deps: Record<string, boolean>
  } | null
}

// ---------------------------------------------------------------- 事件载荷

export interface WindowStateDTO {
  maximized: boolean
  fullscreen: boolean
}

export interface ToastDTO {
  level: 'info' | 'warn' | 'error'
  message: string
  /** 关联的错误码，UI 可展示便于用户反馈 */
  code?: string
}

/**
 * 渲染层转交主进程落盘的一条日志（M0-06）。
 *
 * 只允许这几个字段：渲染层是唯一可能被注入的一侧，
 * 主进程侧会再做一次级别白名单与长度截断（见 main/ipc/log.ts）。
 */
export interface RendererLogDTO {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  /** 产生位置，如 'vue:render'、'window.onerror'、'unhandledrejection' */
  source?: string
  stack?: string
  url?: string
}

export interface RootsChangedDTO {
  rootId: string
  state: RootState
}
