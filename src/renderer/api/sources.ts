/**
 * 书源 IPC 封装（M4-07）。
 *
 * 三种导入入口在这里收敛成三个函数，而不是一个带 union 参数的 `import(input)`：
 * 组件里点的是「选文件」「粘贴」「填 URL」三个不同按钮，各自的错误处理也不一样
 * （选文件被取消是正常路径，不该弹 toast），分开写调用点更干净。
 */
import type {
  NetworkBookAddResultDTO,
  SearchOptions,
  SourceCacheStatsDTO,
  SourceDebugInputDTO,
  SourceDebugResultDTO,
  SourceDTO,
  SourceImportResultDTO,
  SourceSearchResultDTO
} from '@shared/dto'
import { call } from './client'

export const sourcesApi = {
  list(): Promise<SourceDTO[]> {
    return call('source:list')
  },

  /** 粘贴 JSON 文本导入 */
  importText(json: string): Promise<SourceImportResultDTO> {
    return call('source:import', { json })
  },

  /** 本地 .json 文件导入 */
  importFile(filePath: string): Promise<SourceImportResultDTO> {
    return call('source:import', { filePath })
  },

  /** URL 直链导入（只收 http(s) 的 JSON/纯文本） */
  importUrl(url: string): Promise<SourceImportResultDTO> {
    return call('source:import', { url })
  },

  /** 打开文件选择框；用户取消时返回 null（不是错误） */
  pickFile(): Promise<{ path: string } | null> {
    return call('source:pickFile')
  },

  toggle(id: string, enabled: boolean): Promise<void> {
    return call('source:toggle', { id, enabled })
  },

  /** 手动解除熔断（M4-12）：只清超时连击与冷却，不改启停 */
  resetBreaker(id: string): Promise<SourceDTO> {
    return call('source:resetBreaker', { sourceId: id })
  },

  remove(id: string): Promise<void> {
    return call('source:remove', { id })
  },

  /** 一次性提交完整顺序（拖动排序后调用） */
  reorder(ids: string[]): Promise<void> {
    return call('source:reorder', { ids })
  },

  /** 导出；`path` 为空时由主进程弹保存框，用户取消返回 null */
  exportTo(path: string | null = null, ids?: string[]): Promise<{ path: string; count: number } | null> {
    return call('source:export', ids === undefined ? { path } : { path, ids })
  },

  /** 聚合搜索（M4-08）：一次请求跑完所有启用书源，失败源单独返回 */
  search(keyword: string, opts: SearchOptions = {}): Promise<SourceSearchResultDTO> {
    return call('source:search', { keyword, opts })
  },

  /** 加入书架（M4-09）：抓详情 + 目录后写库；重复加入只刷目录 */
  addBook(input: { sourceId: string; bookUrl: string; title?: string }): Promise<NetworkBookAddResultDTO> {
    return call('source:addBook', input)
  },

  /** 手动刷新目录（M4-09） */
  refreshToc(bookId: string): Promise<{ total: number }> {
    return call('source:refreshToc', { bookId })
  },

  /** 正文缓存用量（M4-10）：现扫缓存目录，不做增量索引 */
  cacheStats(): Promise<SourceCacheStatsDTO> {
    return call('source:cacheStats')
  },

  /** 清理正文缓存；`bookId` 缺省表示全部。不动书架与阅读进度 */
  clearCache(bookId?: string): Promise<{ files: number; bytes: number }> {
    return call('source:clearCache', bookId === undefined ? {} : { bookId })
  },

  /** 在系统文件管理器里打开缓存目录 */
  openCacheDir(): Promise<void> {
    return call('source:openCacheDir')
  },

  /** 规则调试（M4-11）：只读，不写书架、目录与缓存 */
  debug(input: SourceDebugInputDTO): Promise<SourceDebugResultDTO> {
    return call('source:debug', input)
  }
}
