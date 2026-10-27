/**
 * 导入任务队列（M1-06）。
 *
 * 一次导入的完整生命周期：**解析目标根目录 → 扫描 → 去重 → 逐本解析 → 分批落库**。
 * 四件事必须同时成立，缺一个都会变成线上事故：
 *
 * 1. **单本失败不中断**。一本加密 EPUB 不能让 500 本导入整体失败。
 *    解析失败记进失败清单，写库失败靠「整批回滚后逐本重试」定位。
 * 2. **每本书是原子的**。书行与它的章节行必须在同一个事务里，否则取消/崩溃会留下
 *    一本没有目录的书——阅读器点进去就是空白，比导入失败更难排查。
 * 3. **事务粒度是一批 50 本**（产品文档 §3.10）。逐本提交在 WAL 下每本一次 fsync，
 *    500 本要多花十几秒；整批提交则内存与回滚代价过高。
 * 4. **取消要留干净的中间态**。取消后不再取新任务，在途的几本跑完，
 *    缓冲区一次性落库——已入库的每本都完整，且不浪费已完成的解析。
 *
 * 另外 `import:scan`（导入预览的数据源）也在这里：它和真正导入共用同一套
 * 「扫描 + 去重」逻辑，分开实现迟早会两边判定不一致。
 */
import { resolve, sep } from 'node:path'
import { AppError, isAppError, ERROR_CODES, messageOf } from '@shared/errors'
import type {
  ImportOptions,
  ImportPhase,
  ImportProgressDTO,
  ScanItemStatus,
  ScanPreviewDTO,
  ScanPreviewItemDTO
} from '@shared/dto'
import { broadcast } from '../ipc/registry'
import { getDb, type Db } from '../db/connection'
import { insertBatch, replaceBook, type BookInput } from '../db/repositories/books'
import { rootsRepo } from '../db/repositories/roots'
import { createLogger } from '../log'
import { ulid } from '../utils/id'
import { dedupeFiles, type DedupeEntry } from './dedupe'
import { prepareBook, PARSE_TIMEOUT_MS } from './importer'
import { DEFAULT_EXTENSIONS, DEFAULT_IGNORE, DEFAULT_MAX_DEPTH, scanDirectory } from './scanner'

const log = createLogger('import')

/** 一批多少本提交一次（产品文档 §3.10） */
export const BATCH_SIZE = 50

/** 解析并发。与 Python worker 的 4 线程池对齐，开更多只会让请求排队 */
export const CONCURRENCY = 4

/** 事件里最多带多少条失败明细。真实总数走 `failedTotal`，避免事件体膨胀 */
const MAX_EVENT_FAILURES = 200

/** 进度事件节流。500 本的导入若每本都发一次事件，渲染层每秒要重渲染几十次 */
const PROGRESS_INTERVAL_MS = 120

/** 已结束的任务保留多少个，供「取消一个刚结束的任务」不至于报错 */
const MAX_FINISHED_TASKS = 10

/** 预览最多列多少条。5 万本的目录不该把预览面板的内存吃光 */
const MAX_PREVIEW_ITEMS = 2000

/**
 * 预览时额外识别的「看起来是书但不支持」的扩展名。
 *
 * 只加书类格式，不加 png/pdf/doc 之类——用户把整个 D 盘拖进来时，
 * 预览列表里全是无关文件比不列更糟。
 */
const UNSUPPORTED_BOOK_EXTENSIONS = ['.mobi', '.azw', '.azw3', '.pdf', '.fb2', '.cbz', '.djvu']

interface ImportFailure {
  relPath: string
  reason: string
}

interface TaskState {
  id: string
  phase: ImportPhase
  total: number
  processed: number
  currentPath: string | null
  failures: ImportFailure[]
  failedTotal: number
  imported: number
  updated: number
  skipped: number
  controller: AbortController
  startedAt: number
  finishedAt: number | null
  lastEmitAt: number
}

export interface ImportRuntimeOptions {
  db?: Db
  /** 封面落盘目录（绝对路径）。默认由 IPC 层传 userData/covers */
  coversDir: string
  /** 解析超时 */
  timeoutMs?: number
  /** 以下三个只给自检注入，生产一律用默认值 */
  concurrency?: number
  batchSize?: number
  progressIntervalMs?: number
}

const tasks = new Map<string, TaskState>()

type ProgressListener = (dto: ImportProgressDTO) => void
const progressListeners = new Set<ProgressListener>()

/**
 * 主进程内的进度订阅。
 *
 * 渲染层走 `import:progress` 事件；这个钩子是给**主进程自己**用的
 * （自检需要观测事件，将来托盘角标 / 完成通知也在这里接，不必绕道渲染层）。
 */
export function subscribeImportProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

function emitProgress(task: TaskState, intervalMs: number, force = false): void {
  const now = Date.now()
  if (!force && now - task.lastEmitAt < intervalMs) return
  task.lastEmitAt = now

  const dto: ImportProgressDTO = {
    taskId: task.id,
    phase: task.phase,
    processed: task.processed,
    total: task.total,
    currentPath: task.currentPath,
    // 失败明细只带最后若干条：列表要的是「最近出的问题」，全量由 failedTotal 表达
    failures: task.failures.slice(-MAX_EVENT_FAILURES),
    failedTotal: task.failedTotal,
    imported: task.imported,
    updated: task.updated,
    skipped: task.skipped
  }

  for (const listener of progressListeners) {
    try {
      listener(dto)
    } catch (err) {
      // 订阅者自己的异常不该打断导入
      log.warn('进度订阅者抛错', { detail: err instanceof Error ? err.message : String(err) })
    }
  }
  broadcast('import:progress', dto)
}

/** 失败原因一律走用户可读文案；内部细节只进日志，不落到 UI */
function failureReason(err: unknown): string {
  if (isAppError(err)) return err.message
  return messageOf(ERROR_CODES.internal)
}

function recordFailure(task: TaskState, relPath: string, err: unknown): void {
  task.failures.push({ relPath, reason: failureReason(err) })
  task.failedTotal++
  log.debug('导入失败', { taskId: task.id, relPath, reason: failureReason(err), detail: String(err) })
}

function pruneFinished(): void {
  const finished = [...tasks.values()].filter((task) => task.finishedAt !== null)
  if (finished.length <= MAX_FINISHED_TASKS) return
  finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  for (const task of finished.slice(0, finished.length - MAX_FINISHED_TASKS)) tasks.delete(task.id)
}

// ---------------------------------------------------------------- 目标解析

export interface ImportTarget {
  /**
   * 所属根目录。**空串表示「还没登记」**——只有预览会走到这个值。
   *
   * 用空串而不是 null 是为了让调用方不必到处判空：`dedupeFiles('')` 查不到任何
   * 同路径记录，语义正好是「这个目录从没导入过，不可能有同路径的书」。
   */
  rootId: string
  rootPath: string
  /** 实际开始扫描的目录（通常是 rootPath，也可能是 root 下的子目录） */
  scanRoot: string
  /** rel_path 的基准目录，恒为 rootPath */
  relBase: string
}

export interface ResolveMode {
  /**
   * 允许「不属于任何根目录」的目录，此时 rootId 返回空串。
   *
   * 预览必须开这个开关：产品文档 §2.4 的「是否同时登记为根目录」是在**导入时**
   * 才问的，而预览发生在导入之前。不开的话用户拖进来一个没登记过的目录，
   * 连「里面有几本书」都看不到——而那恰恰是最需要预览的场景。
   */
  allowUnregistered?: boolean
}

/**
 * 确定「这次导入属于哪个根目录」。
 *
 * 四条规则，顺序不能乱：
 *   1. 与已登记根目录路径完全一致 → 直接用
 *   2. 是某个已登记根目录的**子目录** → 用它，并把 rel_path 相对根目录计算
 *      （否则同一个文件会以两种 rel_path 入库两次）
 *   3. 都不是，且 `registerAsRoot: false` → 报错，让调用方去提示用户
 *   4. 都不是 → 登记成新根目录（导入），或返回空 rootId（预览）
 */
export function resolveImportTarget(
  input: string,
  options: ImportOptions,
  db: Db,
  mode: ResolveMode = {}
): ImportTarget {
  const target = resolve(input.trim())
  const repo = rootsRepo(db)
  const lowered = target.toLowerCase()

  // 显式指定了根目录：必须真的包含这个路径，否则 rel_path 会算出一个带 ../ 的怪值
  if (options.rootId) {
    const forced = repo.get(options.rootId)
    if (!forced) throw new AppError(ERROR_CODES.notFound, '指定的书库根目录不存在')
    const prefix = forced.path.toLowerCase().endsWith(sep) ? forced.path.toLowerCase() : `${forced.path.toLowerCase()}${sep}`
    if (lowered !== forced.path.toLowerCase() && !lowered.startsWith(prefix)) {
      throw new AppError(ERROR_CODES.invalidArgument, '所选目录不在指定的书库根目录下')
    }
    return { rootId: forced.id, rootPath: forced.path, scanRoot: target, relBase: forced.path }
  }

  const exact = repo.findByPath(target)
  if (exact) return { rootId: exact.id, rootPath: exact.path, scanRoot: target, relBase: exact.path }

  // 取最长前缀匹配：`D:\books\科幻` 同时是 `D:\` 与 `D:\books` 的子目录时，后者更具体
  let best: { id: string; path: string } | null = null
  for (const root of repo.list()) {
    const prefix = root.path.toLowerCase().endsWith(sep) ? root.path.toLowerCase() : `${root.path.toLowerCase()}${sep}`
    if (!lowered.startsWith(prefix)) continue
    if (!best || root.path.length > best.path.length) best = { id: root.id, path: root.path }
  }
  if (best) return { rootId: best.id, rootPath: best.path, scanRoot: target, relBase: best.path }

  if (mode.allowUnregistered) {
    return { rootId: '', rootPath: target, scanRoot: target, relBase: target }
  }

  if (options.registerAsRoot === false) {
    throw new AppError(ERROR_CODES.invalidArgument, '该目录不属于任何书库，请先添加为书库根目录')
  }

  const created = repo.create({ label: target.split(sep).filter(Boolean).pop() || target, path: target })
  log.info('导入时登记新根目录', { rootId: created.id, path: created.path })
  return { rootId: created.id, rootPath: created.path, scanRoot: target, relBase: created.path }
}

function ignorePatterns(extra: string | undefined): readonly string[] {
  if (!extra) return DEFAULT_IGNORE
  try {
    // 先编译一次：正则写错要立刻告诉用户，而不是静默不生效
    new RegExp(extra)
  } catch {
    throw new AppError(ERROR_CODES.invalidArgument, '忽略规则不是合法的正则表达式')
  }
  return [...DEFAULT_IGNORE, extra]
}

// ---------------------------------------------------------------- 预览

function formatOfExt(relPath: string): string {
  const dot = relPath.lastIndexOf('.')
  return dot < 0 ? '' : relPath.slice(dot).toLowerCase()
}

/**
 * 导入预览：扫一遍目录，按「可导入 / 重复 / 不支持」分类，**不写任何库数据**。
 *
 * 去重只对支持的格式做——给 .pdf 算指纹既贵又没意义。
 */
export async function buildScanPreview(
  input: string,
  options: ImportOptions = {},
  db: Db = getDb()
): Promise<ScanPreviewDTO> {
  const target = resolveImportTarget(input, options, db, { allowUnregistered: true })
  const started = performance.now()

  const scan = await scanDirectory(target.scanRoot, {
    maxDepth: options.scanDepth ?? DEFAULT_MAX_DEPTH,
    ignore: ignorePatterns(options.ignorePattern),
    extensions: [...DEFAULT_EXTENSIONS, ...UNSUPPORTED_BOOK_EXTENSIONS],
    relBase: target.relBase
  })

  const supported = scan.files.filter((file) => (DEFAULT_EXTENSIONS as readonly string[]).includes(formatOfExt(file.relPath)))
  const unsupported = scan.files.filter(
    (file) => !(DEFAULT_EXTENSIONS as readonly string[]).includes(formatOfExt(file.relPath))
  )

  const dedupe = await dedupeFiles(target.rootId, supported, { db })
  const rootPaths = new Map(rootsRepo(db).list().map((root) => [root.id, root.path]))

  const items: ScanPreviewItemDTO[] = []
  for (const entry of dedupe.entries) {
    const status: ScanItemStatus =
      entry.kind === 'new'
        ? 'new'
        : entry.kind === 'empty'
          ? 'empty'
          : entry.kind === 'failed'
            ? 'failed'
            : 'duplicate'
    items.push({
      relPath: entry.file.relPath,
      sizeBytes: entry.file.size,
      format: formatOfExt(entry.file.relPath) === '.epub' ? 'epub' : 'txt',
      status,
      duplicateOf: entry.existing
        ? {
            bookId: entry.existing.id,
            title: entry.existing.title,
            rootPath: entry.existing.rootId ? (rootPaths.get(entry.existing.rootId) ?? '') : ''
          }
        : null,
      reason: entry.kind === 'empty' ? '空文件，已跳过' : entry.kind === 'failed' ? '无法读取文件内容' : null
    })
  }

  for (const file of unsupported) {
    items.push({
      relPath: file.relPath,
      sizeBytes: file.size,
      format: null,
      status: 'unsupported',
      duplicateOf: null,
      reason: `暂不支持 ${formatOfExt(file.relPath)} 格式`
    })
  }

  items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))

  log.info('导入预览', {
    rootId: target.rootId,
    scanRoot: target.scanRoot,
    files: items.length,
    new: items.filter((item) => item.status === 'new').length,
    duplicate: items.filter((item) => item.status === 'duplicate').length,
    unsupported: unsupported.length
  })

  return {
    path: target.scanRoot,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    total: items.length,
    items: items.slice(0, MAX_PREVIEW_ITEMS),
    truncated: items.length > MAX_PREVIEW_ITEMS
  }
}

// ---------------------------------------------------------------- 任务

/** 并发执行，`shouldStop` 为真时不再取新项（在途的会跑完） */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (shouldStop()) return
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

export function startImport(
  input: string,
  options: ImportOptions,
  runtime: ImportRuntimeOptions
): { taskId: string } {
  const db = runtime.db ?? getDb()
  const target = resolveImportTarget(input, options, db)
  // 忽略规则在这里先校验一次：正则写错要在**创建任务前**就抛，
  // 否则会先返回一个 taskId 再异步失败，UI 拿到的就是一个永远不动的任务
  ignorePatterns(options.ignorePattern)

  const task: TaskState = {
    id: ulid(),
    phase: 'scan',
    total: 0,
    processed: 0,
    currentPath: null,
    failures: [],
    failedTotal: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    controller: new AbortController(),
    startedAt: Date.now(),
    finishedAt: null,
    lastEmitAt: 0
  }
  tasks.set(task.id, task)
  pruneFinished()

  // 不 await：IPC 立刻返回 taskId，进度全部走 import:progress 事件。
  // 任何异常都在 runTask 内部收敛成 failed 阶段，不会变成未处理的 rejection
  void runTask(task, target, options, runtime, db)

  return { taskId: task.id }
}

export function cancelImport(taskId: string): void {
  const task = tasks.get(taskId)
  if (!task) {
    // 取消一个已结束/不存在的任务是正常操作（UI 关闭面板时可能连点），不该报错
    log.debug('取消不存在的导入任务', { taskId })
    return
  }
  if (task.finishedAt !== null) return
  log.info('取消导入', { taskId, processed: task.processed, total: task.total })
  task.controller.abort()
}

async function runTask(
  task: TaskState,
  target: ImportTarget,
  options: ImportOptions,
  runtime: ImportRuntimeOptions,
  db: Db
): Promise<void> {
  const interval = runtime.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  const concurrency = runtime.concurrency ?? CONCURRENCY
  const batchSize = runtime.batchSize ?? BATCH_SIZE
  const overwrite = options.onDuplicate === 'overwrite'
  const signal = task.controller.signal
  const startedAt = performance.now()

  try {
    emitProgress(task, interval, true)

    const scan = await scanDirectory(target.scanRoot, {
      maxDepth: options.scanDepth ?? DEFAULT_MAX_DEPTH,
      ignore: ignorePatterns(options.ignorePattern),
      signal,
      relBase: target.relBase
    })

    const dedupe = await dedupeFiles(target.rootId, scan.files, { db, signal })

    // 分类：只有「新书」与「需要覆盖的原地书」进入解析队列，其余直接计入 skipped
    const queue: DedupeEntry[] = []
    for (const entry of dedupe.entries) {
      if (entry.kind === 'new') {
        queue.push(entry)
      } else if (entry.kind === 'existing-path') {
        // 同路径 + 内容没变 = 没有可更新的东西，直接跳过。
        // 否则「重新导入」会把整库 500 本重新解析一遍，白白多花几十秒，
        // 而用户真正的意图只是把新增的那几本补进来。
        const changed = entry.hash !== null && entry.hash !== entry.existing?.fileHash
        if (overwrite && changed) queue.push(entry)
        else task.skipped++
      } else if (entry.kind === 'failed') {
        // 指纹阶段就失败的（读不了），本来就是失败，不能算「跳过」
        task.failures.push({ relPath: entry.file.relPath, reason: '无法读取文件内容' })
        task.failedTotal++
      } else {
        task.skipped++
      }
    }

    task.total = queue.length
    task.phase = 'parse'
    emitProgress(task, interval, true)

    // 缓冲区：攒够 batchSize 就落库。better-sqlite3 是同步 API，
    // 所以 flush 不会与其它 flush 交错，不需要额外加锁
    let buffer: { book: BookInput; entry: DedupeEntry }[] = []

    const flush = (): void => {
      if (buffer.length === 0) return
      const batch = buffer
      buffer = []

      const inserts = batch.filter((item) => item.entry.kind === 'new')
      const replaces = batch.filter((item) => item.entry.kind !== 'new')

      if (inserts.length > 0) {
        try {
          const results = insertBatch(db, inserts.map((item) => item.book))
          task.imported += results.length
        } catch (err) {
          // 整批回滚后逐本重试：只有这样才能既保住其余 49 本，又定位到坏的那一本
          log.warn('批量写入失败，退化为逐本写入', {
            taskId: task.id,
            batch: inserts.length,
            detail: err instanceof Error ? err.message : String(err)
          })
          for (const item of inserts) {
            try {
              insertBatch(db, [item.book])
              task.imported++
            } catch (itemErr) {
              recordFailure(task, item.entry.file.relPath, itemErr)
            }
          }
        }
      }

      for (const item of replaces) {
        const bookId = item.entry.existing?.id
        if (!bookId) {
          recordFailure(task, item.entry.file.relPath, new AppError(ERROR_CODES.internal, '缺少待覆盖的记录 ID'))
          continue
        }
        try {
          const result = replaceBook(db, bookId, item.book)
          if (result) task.updated++
          else recordFailure(task, item.entry.file.relPath, new AppError(ERROR_CODES.notFound, '记录已被删除，未覆盖'))
        } catch (err) {
          recordFailure(task, item.entry.file.relPath, err)
        }
      }
    }

    await runPool(
      queue,
      concurrency,
      () => signal.aborted,
      async (entry) => {
        task.currentPath = entry.file.relPath
        try {
          buffer.push({
            book: await prepareBook(entry, {
              rootId: target.rootId,
              coversDir: runtime.coversDir,
              timeoutMs: runtime.timeoutMs ?? PARSE_TIMEOUT_MS
            }),
            entry
          })
          if (buffer.length >= batchSize) flush()
        } catch (err) {
          recordFailure(task, entry.file.relPath, err)
        } finally {
          task.processed++
          emitProgress(task, interval)
        }
      }
    )

    // 收尾批次。取消时也要落：这些书已经解析完，丢掉纯属浪费，
    // 而每本书本身是原子的，落进去不会出现「半本书」
    task.phase = 'commit'
    emitProgress(task, interval, true)
    flush()

    task.phase = signal.aborted ? 'cancelled' : 'done'
  } catch (err) {
    log.error('导入任务异常终止', { taskId: task.id, detail: err instanceof Error ? err.message : String(err) })
    task.phase = 'failed'
    if (task.failedTotal === 0) {
      task.failures.push({ relPath: '.', reason: failureReason(err) })
      task.failedTotal++
    }
  } finally {
    task.finishedAt = Date.now()
    task.currentPath = null
    emitProgress(task, interval, true)
    log.info('导入结束', {
      taskId: task.id,
      phase: task.phase,
      rootId: target.rootId,
      imported: task.imported,
      updated: task.updated,
      skipped: task.skipped,
      failed: task.failedTotal,
      elapsedMs: Number((performance.now() - startedAt).toFixed(0))
    })
  }
}

/** 仅供自检：读取任务最终状态 */
export function getTaskSnapshot(taskId: string): {
  phase: ImportPhase
  processed: number
  total: number
  imported: number
  updated: number
  skipped: number
  failures: ImportFailure[]
  failedTotal: number
} | null {
  const task = tasks.get(taskId)
  if (!task) return null
  return {
    phase: task.phase,
    processed: task.processed,
    total: task.total,
    imported: task.imported,
    updated: task.updated,
    skipped: task.skipped,
    failures: [...task.failures],
    failedTotal: task.failedTotal
  }
}
