/**
 * 根目录 IPC（M1-01）。
 *
 * 五个通道对应产品文档 §2.3 的「根目录管理」四件事 + 列表：
 *   list / add / check / relocate / remove
 *
 * 三条业务规则集中在这里（不下沉到仓储，也不上浮到渲染层）：
 *   1. **路径必须规范化后再比对**：`D:\books\` 与 `d:\books` 在 Windows 上是同一个目录，
 *      不规范化就会登记出两条记录，然后同一批书被导入两次（靠 file_hash 去重兜住，
 *      但用户会看到莫名其妙的「已在书库中」）。
 *   2. **登记前必须探测可读**：把不可访问的路径写进库，只会让用户下次启动看到一个
 *      永远离线、删也删不掉的根目录。
 *   3. **移除不删书**：解绑 `root_id`，书籍降级为「未归属根目录 + 离线」，仍可见。
 */
import { basename, isAbsolute, resolve } from 'node:path'
import { AppError, ERROR_CODES } from '@shared/errors'
import type { RootDTO } from '@shared/dto'
import type { RootWithCount } from '../db/repositories/roots'
import { rootsRepo } from '../db/repositories/roots'
import { checkAllRoots, matchRelocated, probePath } from '../library/roots-monitor'
import { startImport } from '../library/import-task'
import { createLogger } from '../log'
import { sanitizeInputPath } from '../utils/path'
import { coversDir } from './import'
import { registerHandler } from './registry'

const log = createLogger('roots')

/** RootWithCount 与 RootDTO 同形，直接透出；保留 helper 是为了将来加派生字段时只改一处 */
function toDTO(root: RootWithCount): RootDTO {
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    volumeGuid: root.volumeGuid,
    state: root.state,
    sort: root.sort,
    bookCount: root.bookCount,
    lastCheckAt: root.lastCheckAt,
    createdAt: root.createdAt
  }
}

/**
 * 规范化用户给的路径。
 *
 * `resolve` 会消掉尾部分隔符、`.`、`..` 与混用的正斜杠，但**不改大小写**——
 * 大小写只在查重时折叠（SQLite 的 lower()），存储仍保留用户原样，便于展示。
 */
function normalizePath(input: string): string {
  // 「复制文件地址」粘贴的路径带引号，不剥掉会被 resolve 当相对路径拼到应用目录
  const trimmed = sanitizeInputPath(input)
  if (!trimmed) throw new AppError(ERROR_CODES.invalidArgument, '路径不能为空')
  const full = resolve(trimmed)
  if (!isAbsolute(full)) {
    // resolve 在 Windows 上总会给出绝对路径，这里只是防御（比如将来支持 Linux 时不至于静默出错）
    throw new AppError(ERROR_CODES.invalidArgument, '请提供绝对路径')
  }
  return full
}

/** 目录名作为默认显示名；`D:\` 这类 basename 为空的路径直接拿路径本身 */
function defaultLabel(path: string): string {
  return basename(path) || path
}

async function assertUsableDirectory(path: string): Promise<void> {
  if (await probePath(path)) return
  throw new AppError(ERROR_CODES.notFound, '目录不存在、不是文件夹，或当前无法访问')
}

export function registerRootsIpc(): void {
  // 列表：只读库，不做探测。状态以启动检测/focus 检测/手动检测的结果为准
  registerHandler('roots:list', () => rootsRepo().list().map(toDTO))

  registerHandler('roots:add', async ({ path, scanNow }) => {
    const full = normalizePath(path)
    await assertUsableDirectory(full)

    const repo = rootsRepo()
    const existing = repo.findByPath(full)
    if (existing) {
      throw new AppError(ERROR_CODES.conflict, `该目录已登记为「${existing.label}」`)
    }

    const created = repo.create({ label: defaultLabel(full), path: full })
    log.info('登记根目录', { rootId: created.id, path: created.path, scanNow })

    // 「同时立即扫描导入」：登记完直接把导入任务投进队列（M1-06 的调度会串行化）。
    // 进度走 import:progress 事件，登记接口本身不等扫描结果——
    // 一个几千本的目录要跑几分钟，阻塞在这里 UI 会以为卡死。
    if (scanNow) {
      const { taskId } = startImport(created.path, {}, { coversDir: coversDir() })
      log.info('登记后立即开始导入', { rootId: created.id, taskId })
    }

    return toDTO(created)
  })

  // 手动检测：强制刷新 last_check_at，并且让状态变化立刻广播出去
  registerHandler('roots:check', async () => {
    const roots = await checkAllRoots({ reason: 'manual', forceTouch: true })
    return roots.map(toDTO)
  })

  registerHandler('roots:relocate', async ({ rootId, newPath }) => {
    const repo = rootsRepo()
    const root = repo.get(rootId)
    if (!root) throw new AppError(ERROR_CODES.notFound, '根目录不存在，可能已被移除')

    const full = normalizePath(newPath)
    if (full.toLowerCase() !== root.path.toLowerCase()) {
      await assertUsableDirectory(full)
      const clash = repo.findByPath(full)
      if (clash && clash.id !== rootId) {
        throw new AppError(ERROR_CODES.conflict, `该目录已被「${clash.label}」占用`)
      }
    }

    // 先用旧的 rel_path 列表去新路径下探一遍，让 UI 能提示「42 本里 3 本没找到」
    const relPaths = repo.relPathsOf(rootId)
    const match = await matchRelocated(relPaths, full)

    repo.updatePath(rootId, full)
    // 刚探测过，状态可以直接认定；走 setState 而不是留着旧值，避免改完路径仍显示离线
    repo.setState(rootId, 'online', Date.now())

    log.info('根目录重定位', {
      rootId,
      from: root.path,
      to: full,
      matched: match.matched,
      missing: match.missing
    })

    return match
  })

  registerHandler('roots:remove', ({ rootId }) => {
    const repo = rootsRepo()
    const root = repo.get(rootId)
    if (!root) throw new AppError(ERROR_CODES.notFound, '根目录不存在，可能已被移除')

    const { detachedBooks } = repo.remove(rootId)
    log.info('移除根目录', { rootId, path: root.path, detachedBooks })
    // 契约返回 void：书籍未归属后的列表刷新由渲染层基于成功回调自行触发
  })
}
