/**
 * IPC 契约（docs/产品文档.md §3.6 的落地版本）。
 *
 * 相对文档的一处调整：文档把通道写成函数类型 `(q: BookQuery) => Promise<Paged<BookDTO>>`。
 * 这里改成 `{ input, output }` 结构——因为注册器与 preload 白名单需要**分别**取到入参和返回值
 * 类型，函数类型要靠 `Parameters<>[0]` 反解，遇到无入参通道（`() => void`）会取到 undefined 并使
 * 整个映射退化。信息量与文档完全一致。
 *
 * 新增通道的顺序固定为：dto.ts 加类型 → 本文件加签名 → channels.ts 加通道名 →
 * schemas.ts 加 zod schema → main/ipc 注册 handler。五处缺一，编译期就会报错。
 */
import type {
  AppInfoDTO,
  BookDTO,
  BookmarkDTO,
  BookDetailDTO,
  BookQuery,
  BookSort,
  ChapterContentDTO,
  ChapterDTO,
  EchoRequest,
  EchoResponse,
  ImportOptions,
  ImportProgressDTO,
  Paged,
  ProgressDTO,
  RendererLogDTO,
  RootDTO,
  RootsChangedDTO,
  ScanPreviewDTO,
  SearchOptions,
  SettingsDTO,
  ShelfDTO,
  SourceDTO,
  SourceImportResultDTO,
  SourceSearchResultDTO,
  ToastDTO,
  WindowStateDTO,
  WorkerHealthDTO
} from '../dto'

export type IpcMap = {
  // 系统（诊断用，产品界面不直接调用；M0-04 的验收依赖它）
  'system:echo': { input: EchoRequest; output: EchoResponse }
  'system:info': { input: void; output: AppInfoDTO }
  // Python worker 健康状态：返回握手信息 + 进程状态，未就绪时 worker 为 null
  'system:worker-health': { input: void; output: WorkerHealthDTO }

  // 窗口（文档 §3.6 只定义了 window:state 事件，这里补一个读取型通道：
  // 渲染层挂载时先用它取初始状态，避免「先订阅后加载」与「先加载后订阅」的竞态）
  'window:get-state': { input: void; output: WindowStateDTO }

  // 书库
  'library:list': { input: BookQuery; output: Paged<BookDTO> }
  'library:get': { input: { id: string }; output: BookDetailDTO | null }
  'library:toggleFavorite': { input: { id: string; value: boolean }; output: void }
  'library:setCategories': { input: { id: string; categoryIds: string[] }; output: void }
  'library:remove': { input: { id: string; deleteFile: boolean }; output: void }

  // 根目录
  'roots:list': { input: void; output: RootDTO[] }
  'roots:add': { input: { path: string; scanNow: boolean }; output: RootDTO }
  'roots:check': { input: void; output: RootDTO[] }
  'roots:relocate': {
    input: { rootId: string; newPath: string }
    output: { matched: number; missing: number }
  }
  'roots:remove': { input: { rootId: string }; output: void }

  // 书架
  'shelves:list': { input: void; output: ShelfDTO[] }
  'shelves:create': { input: { name: string }; output: ShelfDTO }
  'shelves:addBooks': { input: { shelfId: string; bookIds: string[] }; output: void }
  'shelves:get': { input: { shelfId: string }; output: ShelfDTO | null }

  // 书籍列表（M1-08，排序由 M1-09 扩展）
  'books:list': {
    input: {
      rootId?: string
      favoritesOnly?: boolean
      shelfId?: string
      /** 标题/作者/简介的 FTS5 前缀匹配（M1-10） */
      keyword?: string
      /** 缺省 = 导入时间倒序 */
      sort?: BookSort
      offset: number
      limit: number
    }
    output: Paged<BookDTO>
  }
  'books:count': { input: { rootId?: string; favoritesOnly?: boolean }; output: { total: number } }
  'books:recent': { input: { rootId?: string; limit?: number }; output: BookDTO[] }
  /**
   * 文件重定位（M2-11）：在 `searchDir` 下按文件名找唯一匹配，改写 rel_path。
   * `relPath` 为 null 表示没找到或不唯一（`candidates` 说明找到了几个）。
   */
  'books:relocateFile': {
    input: { bookId: string; searchDir: string }
    output: { relPath: string | null; candidates: number }
  }

  // 导入
  'import:pickFolder': { input: void; output: { path: string } | null }
  'import:scan': { input: { path: string }; output: ScanPreviewDTO }
  'import:commit': { input: { path: string; options: ImportOptions }; output: { taskId: string } }
  'import:cancel': { input: { taskId: string }; output: void }

  // 阅读
  'reader:content': { input: { bookId: string; chapterIdx: number }; output: ChapterContentDTO }
  /** 整本目录（M2-06）。一次全给：千章也就几十 KB，分页反而让抽屉要处理「加载中」 */
  'reader:chapters': { input: { bookId: string }; output: ChapterDTO[] }
  'reader:saveProgress': { input: ProgressDTO; output: void }
  /** 读进度（M2-08）。没读过返回 null，由渲染层决定从第 0 章开始 */
  'reader:progress': { input: { bookId: string }; output: ProgressDTO | null }

  // 书签与划线（M2-09）
  'bookmarks:list': { input: { bookId: string }; output: BookmarkDTO[] }
  'bookmarks:add': {
    input: {
      bookId: string
      chapterIdx: number
      offset: number
      endOffset: number | null
      kind: 'bookmark' | 'highlight'
      text: string | null
      note?: string | null
    }
    output: BookmarkDTO
  }
  'bookmarks:updateNote': { input: { id: string; note: string | null }; output: void }
  'bookmarks:remove': { input: { id: string }; output: void }
  /** 导出为 Markdown。`path` 为空时由主进程弹保存框（自动化验收会直接给路径） */
  'bookmarks:export': { input: { bookId: string; path: string | null }; output: { path: string } | null }

  // 书源
  'source:import': { input: { json: string } | { filePath: string }; output: SourceImportResultDTO }
  'source:list': { input: void; output: SourceDTO[] }
  'source:toggle': { input: { id: string; enabled: boolean }; output: void }
  'source:search': { input: { keyword: string; opts: SearchOptions }; output: SourceSearchResultDTO }
  'source:refreshToc': { input: { bookId: string }; output: { total: number } }

  // 设置
  'settings:get': { input: void; output: SettingsDTO }
  'settings:patch': { input: { patch: DeepPartial<SettingsDTO> }; output: SettingsDTO }
}

/** Main → Renderer 的单向事件（webContents.send） */
export type IpcEvents = {
  'import:progress': ImportProgressDTO
  /** 根目录上线/掉线，用于刷新离线角标 */
  'roots:changed': RootsChangedDTO
  'window:state': WindowStateDTO
  toast: ToastDTO
}

/** Renderer → Main 的单向消息（ipcRenderer.send），无返回值 */
export type IpcSends = {
  'window:minimize': void
  'window:toggle-maximize': void
  'window:close': void
  /** 全屏切换（F11，M2-10）。用单向通道：调用方不需要等结果，
   *  真实状态由 window:state 事件回推 */
  'window:toggle-fullscreen': void
  /** 渲染层把未捕获异常 / 诊断信息转交主进程写进同一个日志文件（M0-06） */
  'log:renderer': RendererLogDTO
}

export type IpcChannel = keyof IpcMap
export type IpcEventChannel = keyof IpcEvents
export type IpcSendChannel = keyof IpcSends

export type IpcInput<K extends IpcChannel> = IpcMap[K]['input']
export type IpcOutput<K extends IpcChannel> = IpcMap[K]['output']

/** 递归可选，用于 settings:patch 这类局部更新 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T
