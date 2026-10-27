/**
 * 目录扫描器（M1-02）。
 *
 * 职责单一：**从根目录递归找出所有可导入的文件，不读内容、不碰数据库**。
 * 指纹计算（M1-03）、解析（M1-04/05）、入库（M1-06）都在下游，这样扫描能跑得很快，
 * 也便于单独验收「1000 个文件 ≤3s」这条指标。
 *
 * 四条必须守住的约束：
 *   1. **rel_path 统一用 `/` 分隔**。DB 里只存相对路径，若随平台变成 `\`，
 *      将来换平台或与 EPUB 内部路径风格对照时会一团乱。拼绝对路径时再换回系统分隔符。
 *   2. **符号链接一律不跟随**。跟随就需要 realpath 去环，每个条目多一次 IO；
 *      而「防环」最彻底的实现就是根本不进去。跳过的数量记进 stats，需要时能解释给用户。
 *   3. **深度与数量都要有上限**。用户误把 `C:\` 当根目录时，没有上限就是灾难。
 *   4. **不可读目录只记录不中断**。Windows 上 `System Volume Information`、
 *      被占用的目录都会 EACCES/EPERM，一个目录读不了不该让整次扫描失败。
 */
import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

/** 产品决策 D1：只收 TXT / EPUB，不含 MOBI/AZW3/PDF */
export const DEFAULT_EXTENSIONS = ['.txt', '.epub'] as const

/** 默认扫描深度。产品文档 §2.4「默认深度 ≤ 8 层，可调」 */
export const DEFAULT_MAX_DEPTH = 8

/** 单次扫描的文件数上限。50000 本已远超真实书库规模，超过视为选错了目录 */
export const DEFAULT_MAX_FILES = 50_000

/** 并发目录数。8 在本地 SSD 上是吞吐与句柄占用的平衡点 */
const DEFAULT_CONCURRENCY = 8

/**
 * 默认忽略规则（正则源码，对 rel_path 匹配）。
 *
 * 只放「几乎不可能是书」的目录：回收站、系统卷信息、版本库元数据、依赖目录。
 * 不排除所有 `.` 开头的目录——用户完全可能用 `.novels` 这种名字存书。
 */
export const DEFAULT_IGNORE = [
  '^\\$RECYCLE\\.BIN(/|$)',
  '^System Volume Information(/|$)',
  '(^|/)node_modules(/|$)',
  '(^|/)\\.git(/|$)',
  '(^|/)\\.svn(/|$)',
  '(^|/)\\.hg(/|$)'
] as const

export interface ScanOptions {
  /** 最大子目录层级，root 自身为第 0 层 */
  maxDepth?: number
  /** 扩展名白名单，大小写不敏感，需带点 */
  extensions?: readonly string[]
  /** 忽略正则（源码字符串），对 `/` 分隔的 rel_path 匹配 */
  ignore?: readonly string[]
  /** 文件数上限，超过则标记 truncated 并停止入队 */
  maxFiles?: number
  /** 并发目录数 */
  concurrency?: number
  /** 取消信号（M1-06 的任务取消要用） */
  signal?: AbortSignal
  /** 每发现一个文件回调一次，用于进度展示 */
  onFile?: (file: ScannedFile) => void
}

export interface ScannedFile {
  /** 相对根目录的路径，`/` 分隔 */
  relPath: string
  /** 绝对路径，仅本次扫描内有效（不入库） */
  absPath: string
  size: number
  mtimeMs: number
}

export interface ScanStats {
  /** 实际读取的目录数 */
  dirs: number
  /** 命中的文件数（= files.length） */
  files: number
  skippedIgnored: number
  skippedDepth: number
  skippedExtension: number
  skippedSymlink: number
  /** 读不了的目录，按 rel_path 记录；不影响其余结果 */
  unreadable: { relPath: string; message: string }[]
  /** 是否因 maxFiles 提前停止 */
  truncated: boolean
  /** 是否被 signal 取消 */
  cancelled: boolean
  elapsedMs: number
}

export interface ScanResult {
  root: string
  files: ScannedFile[]
  stats: ScanStats
}

interface QueueItem {
  absPath: string
  relPath: string
  /** 当前目录的层级，root 为 0 */
  depth: number
}

function toPOSIX(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/')
}

function compileIgnore(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = []
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source))
    } catch {
      // 用户给的正则写错了不该让扫描失败；调用方负责提示格式问题
    }
  }
  return compiled
}

/**
 * 递归扫描。返回按 relPath 升序排好的文件列表，保证同一目录树每次结果一致
 * （导入流程依赖稳定的顺序做断点续传与进度估算）。
 */
export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now()

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const extensions = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()))
  const ignore = compileIgnore(options.ignore ?? DEFAULT_IGNORE)
  const signal = options.signal

  const files: ScannedFile[] = []
  const stats: ScanStats = {
    dirs: 0,
    files: 0,
    skippedIgnored: 0,
    skippedDepth: 0,
    skippedExtension: 0,
    skippedSymlink: 0,
    unreadable: [],
    truncated: false,
    cancelled: false,
    elapsedMs: 0
  }

  const queue: QueueItem[] = [{ absPath: root, relPath: '', depth: 0 }]
  let stopped = false

  const shouldStop = (): boolean => {
    if (signal?.aborted) {
      stats.cancelled = true
      return true
    }
    if (files.length >= maxFiles) {
      stats.truncated = true
      return true
    }
    return false
  }

  const consume = async (): Promise<void> => {
    for (;;) {
      if (stopped || shouldStop()) {
        stopped = true
        return
      }
      const item = queue.shift()
      if (!item) return

      stats.dirs++
      let entries
      try {
        entries = await readdir(item.absPath, { withFileTypes: true })
      } catch (err) {
        stats.unreadable.push({
          relPath: item.relPath || '.',
          message: err instanceof Error ? err.message : String(err)
        })
        continue
      }

      for (const entry of entries) {
        if (stopped || shouldStop()) {
          stopped = true
          return
        }

        const relPath = item.relPath ? `${item.relPath}/${entry.name}` : entry.name

        if (entry.isSymbolicLink()) {
          stats.skippedSymlink++
          continue
        }

        if (ignore.some((re) => re.test(relPath))) {
          stats.skippedIgnored++
          continue
        }

        if (entry.isDirectory()) {
          if (item.depth + 1 > maxDepth) {
            stats.skippedDepth++
            continue
          }
          queue.push({ absPath: join(item.absPath, entry.name), relPath, depth: item.depth + 1 })
          continue
        }

        if (!entry.isFile()) continue

        const ext = extname(entry.name).toLowerCase()
        if (!extensions.has(ext)) {
          stats.skippedExtension++
          continue
        }

        // 用 Dirent 拿不到 size/mtime，必须额外 stat。这一步是扫描里最贵的部分，
        // 但 M1-03 的指纹要用 size 做前置判断，省不掉。
        try {
          const info = await stat(join(item.absPath, entry.name))
          const file: ScannedFile = {
            relPath,
            absPath: join(item.absPath, entry.name),
            size: info.size,
            mtimeMs: info.mtimeMs
          }
          files.push(file)
          stats.files++
          options.onFile?.(file)
        } catch (err) {
          stats.unreadable.push({
            relPath,
            message: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, consume))

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  stats.elapsedMs = Number((performance.now() - started).toFixed(1))

  return { root, files, stats }
}

/**
 * 把 rel_path 还原成绝对路径。
 * 库里只存 `/` 分隔的相对路径，落盘操作前必须经过这里，
 * 否则 Windows 上 `join(root, 'a/b.txt')` 虽然也能work，但混用分隔符容易在
 * 「父目录判断」「字符串前缀比较」这类地方出问题。
 */
export function resolveRelPath(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'))
}

/** rel_path 的父目录（用于列表分组 / 显示）；顶层文件返回空串 */
export function parentOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx < 0 ? '' : relPath.slice(0, idx)
}

/** 相对路径去掉目录部分后的文件名 */
export function baseNameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx < 0 ? relPath : relPath.slice(idx + 1)
}

/** 供外部（如「添加根目录」提示）复用的相对路径计算 */
export function relativeTo(root: string, absPath: string): string {
  return toPOSIX(relative(root, absPath))
}
