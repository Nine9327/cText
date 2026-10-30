/**
 * 跨进程传输的数据结构（主进程与渲染层共用）。
 *
 * 约定：
 * - 时间戳一律 Unix ms 数字；
 * - 字段名 camelCase，下划线命名止步于 DB 层（repository 负责映射）；
 * - 布尔字段在 DTO 层一律 boolean，`0/1` 只存在于 SQLite 的 INTEGER 列。
 *
 * 本文件在 M0-04 定稿。后续里程碑落地时
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
  /** 连续超时次数（M4-12）；>0 时界面上给一个轻提示 */
  failStreak: number
  /** 熔断提示（已临时停用时非空），读取时按当前时间算好，界面直接显示 */
  breakerNote: string | null
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
  /**
   * 同名合并掉的其它来源。合并只改**展示**：主项保留首次出现的那一条，
   * 其余源的 bookUrl 放这里，用户仍能选择从哪个源读。
   */
  alsoIn?: Array<{ sourceId: string; sourceName: string; bookUrl: string }>
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

/**
 * 加入书架（M4-09）的结果。
 *
 * `reused` 为 true 表示这本书已经在书架上，本次只把目录刷了一遍——界面据此
 * 提示「已在书架，目录已更新」，而不是假装新加了一本（会导致用户以为有重复）。
 */
export interface NetworkBookAddResultDTO {
  bookId: string
  title: string
  chapterCount: number
  reused: boolean
}

/** 单本书的缓存占用（缓存用量页只列占用最大的若干本） */
export interface SourceCacheBookDTO {
  bookId: string
  /** 书已从书架删除时为 null */
  title: string | null
  files: number
  bytes: number
}

/**
 * 正文缓存用量（M4-10）。
 *
 * `expired*` 单独报而不是直接删：过期的章节在断网时仍然可读（读失败会回退到它），
 * 所以「过期」是「下次联网会重抓」的意思，不是「已经没用了」。
 */
export interface SourceCacheStatsDTO {
  /** 缓存根目录，设置页的「打开目录」直接用它 */
  dir: string
  files: number
  bytes: number
  expiredFiles: number
  expiredBytes: number
  ttlDays: number
  /** 有缓存的书籍总数（`books` 只给占用最大的前 20 本） */
  totalBooks: number
  books: SourceCacheBookDTO[]
}

// ---------------------------------------------------------------- 规则调试（M4-11）

export type SourceDebugPhase = 'search' | 'info' | 'toc' | 'content'

/**
 * 调试面板的一步。
 *
 * `kind` 区分「发了请求」与「跑了一条规则」：请求步看 status / url / snippet，
 * 规则步看 rule / values。两者塞进同一个数组是为了保留真实先后顺序——
 * 用户排查的是「请求回来了，然后规则没取到」这类因果。
 */
export interface SourceDebugStepDTO {
  kind: 'request' | 'rule'
  /** 这一步在做什么：「详情页」「目录第 2 页」「详情字段 name」 */
  label: string
  /** 规则原文；请求步为 null */
  rule: string | null
  /** 实际请求地址（跟完重定向）；规则步为 null */
  url: string | null
  status: number | null
  /** 响应体前 2KB（超长已截断并标注） */
  snippet: string | null
  /** 提取结果（规则步才有；最多 20 条、单条 300 字） */
  values: string[]
  elapsedMs: number
  error: string | null
}

export interface SourceDebugSectionDTO {
  phase: SourceDebugPhase
  ok: boolean
  /** 缺前置输入（没填关键词/地址）时跳过：这时 `ok` 为 false，但不算失败 */
  skipped: boolean
  /** 一句话结论：「3 章 / 1 页」「1204 字 / 1 页」 */
  summary: string
  error: string | null
  elapsedMs: number
  steps: SourceDebugStepDTO[]
}

export interface SourceDebugInputDTO {
  sourceId: string
  /** 详情页地址；只跑目录时可以填目录页地址 */
  url?: string
  /** 搜索段的关键词 */
  keyword?: string
  /** 正文段用；不填则取目录的第一章 */
  chapterUrl?: string
  /** 不填 = 四段全跑 */
  phases?: SourceDebugPhase[]
}

export interface SourceDebugResultDTO {
  sourceId: string
  sourceName: string
  url: string | null
  keyword: string | null
  sections: SourceDebugSectionDTO[]
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

/**
 * 「打开目录」的目标（M5-01 设置页）。
 *
 * 用枚举而不是让渲染层传绝对路径：`shell.openPath` 能打开任意路径，
 * 若做成「传路径」的通道，等于给渲染层（以及任何注入脚本）一个
 * 「用系统默认程序打开任意文件」的能力。设置页只需要这几个固定目录。
 */
export type OpenPathTarget = 'logs' | 'data' | 'db' | 'covers' | 'chapters'

export interface StorageDirStatsDTO {
  dir: string
  files: number
  bytes: number
}

/** 设置页「存储」组的一次性汇总：两个缓存目录 + 三个路径 */
export interface SystemStorageStatsDTO {
  covers: StorageDirStatsDTO
  /** 网络书正文缓存（与 `source:cacheStats` 同源，这里只要总量） */
  chapters: StorageDirStatsDTO
  dataDir: string
  logDir: string
  /** 当前生效的封面上限（MB）；0 = 不限制 */
  coverCacheLimitMb: number
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
