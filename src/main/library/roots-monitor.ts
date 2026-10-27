/**
 * 根目录状态监测（M1-01）。
 *
 * 产品口径（`产品文档.md` §2.3）：
 *   - 检测时机 = **启动时** + **主窗口重新获得焦点时（节流 30s）** + **用户手动点「检测」**
 *   - 掉线书籍「不删除、不改状态、不丢进度」，只由 `library_roots.state` 派生离线角标
 *   - 重新可用即自动恢复，无需重新导入
 *
 * 所以这里**不做秒级轮询**：盘拔掉后用户切回窗口就会触发一次检测，已经够用；
 * 常驻轮询只会在移动硬盘休眠时反复唤醒它（「硬盘咔咔响」是同类软件的经典投诉）。
 *
 * 状态变化才广播 `roots:changed`——焦点事件很频繁，每次都发事件会让渲染层不停重渲染。
 */
import { stat } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import type { RootsChangedDTO, RootState } from '@shared/dto'
import type { RootWithCount } from '../db/repositories/roots'
import { rootsRepo } from '../db/repositories/roots'
import { broadcast } from '../ipc/registry'
import { createLogger } from '../log'

const log = createLogger('roots')

/** 焦点触发的检测最短间隔。产品文档 §2.3 明确写了 30s */
const FOCUS_THROTTLE_MS = 30_000
/** 状态没变时，last_check_at 的最短写入间隔（避免每次 focus 都写一次库） */
const TOUCH_THROTTLE_MS = 60_000
/** 单次探测超时。本地盘符不存在会立刻 ENOENT；只有 SMB 失联才会卡住，1.5s 足够 */
const PROBE_TIMEOUT_MS = 1_500

export type RootsChangedHandler = (payload: RootsChangedDTO) => void

/** 默认走 IPC 广播；smoke 里替换成收集器，就能在不起窗口的情况下断言事件 */
let emitChanged: RootsChangedHandler = (payload) => broadcast('roots:changed', payload)

export function setRootsChangedHandler(handler: RootsChangedHandler | null): void {
  emitChanged = handler ?? ((payload) => broadcast('roots:changed', payload))
}

/**
 * 探测目录是否可访问。
 *
 * 用 stat 而不是 access：access 只报权限，stat 还能确认「这是个目录」——
 * 用户把根目录指到一个文件上也算不可用。
 *
 * 超时用 Promise.race 兜底。被 race 甩下的 stat 调用无法取消（Node 的
 * fs.promises.stat 不接受 AbortSignal），它会在线程池里跑完并丢弃结果；
 * 单个根目录最多泄漏一个 pending 请求，不值得为此引入额外抽象。
 */
export async function probePath(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })

  try {
    return await Promise.race([
      stat(path).then(
        (s) => s.isDirectory(),
        () => false
      ),
      timeout
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface CheckOptions {
  /** 写日志用：startup | focus | manual */
  reason: 'startup' | 'focus' | 'manual'
  /** 强制写入 last_check_at，忽略节流（手动检测时用） */
  forceTouch?: boolean
}

let running: Promise<RootWithCount[]> | null = null

/**
 * 检测全部根目录，把状态落库，并对**状态发生变化**的根目录广播事件。
 *
 * 并发执行时后来的调用直接复用当前这轮（不排队、不重复探测）：
 * 用户在设置页连点「检测」不该产生 N 轮磁盘访问。
 */
export async function checkAllRoots(options: CheckOptions): Promise<RootWithCount[]> {
  if (running) return running
  running = doCheckAll(options).finally(() => {
    running = null
  })
  return running
}

async function doCheckAll({ reason, forceTouch }: CheckOptions): Promise<RootWithCount[]> {
  const repo = rootsRepo()
  const roots = repo.list()
  if (roots.length === 0) return []

  const now = Date.now()
  const changed: RootsChangedDTO[] = []

  // 并发探测：根目录通常个位数，全部并发即可；不设限是因为每个都有独立超时
  await Promise.all(
    roots.map(async (root) => {
      const online = await probePath(root.path)
      const next: RootState = online ? 'online' : 'offline'

      if (root.state !== next) {
        repo.setState(root.id, next, now)
        changed.push({ rootId: root.id, state: next })
        log.info(next === 'offline' ? '根目录离线' : '根目录恢复在线', {
          rootId: root.id,
          label: root.label,
          reason
        })
        return
      }

      // 状态没变：只在超过节流窗口或强制时更新检测时间，减少无谓写入
      if (forceTouch || root.lastCheckAt === null || now - root.lastCheckAt > TOUCH_THROTTLE_MS) {
        repo.touchCheck(root.id, now)
      }
    })
  )

  const latest = repo.list()

  // 事件放在全部落库之后再发：订阅方收到事件立刻回查 roots:list 时能读到新状态
  for (const payload of changed) emitChanged(payload)

  log.debug('根目录检测完成', {
    reason,
    total: roots.length,
    offline: latest.filter((r) => r.state === 'offline').length,
    changed: changed.length
  })

  return latest
}

let focusHandler: (() => void) | null = null
let lastFocusCheckAt = 0

/**
 * 装启动检测与焦点检测。幂等。
 *
 * 启动检测不 await：窗口该多快出来就多快出来，掉线状态晚几百毫秒渲染层自己会刷新。
 */
export function installRootsMonitor(): void {
  if (focusHandler) return

  const run = (reason: 'startup' | 'focus') => {
    void checkAllRoots({ reason }).catch((err) => {
      log.warn('根目录检测失败', { reason, error: err })
    })
  }

  focusHandler = () => {
    // 没有任何窗口时（比如全部关闭又没退出）不做检测
    if (BrowserWindow.getAllWindows().length === 0) return
    const now = Date.now()
    if (now - lastFocusCheckAt < FOCUS_THROTTLE_MS) return
    lastFocusCheckAt = now
    run('focus')
  }

  app.on('browser-window-focus', focusHandler)
  run('startup')
}

export function stopRootsMonitor(): void {
  if (!focusHandler) return
  app.off('browser-window-focus', focusHandler)
  focusHandler = null
}

/**
 * 统计某根目录下的书籍在新路径下的命中情况（`roots:relocate` 用）。
 *
 * 只做「文件在不在」的判定，不做内容指纹比对——指纹重绑定是 M1-03 的事，
 * 这里返回 matched/missing 是为了让 UI 能提示「42 本里 3 本没找到，确定要改吗」。
 */
export async function matchRelocated(
  relPaths: readonly string[],
  newPath: string
): Promise<{ matched: number; missing: number }> {
  if (relPaths.length === 0) return { matched: 0, missing: 0 }

  const { join } = await import('node:path')
  let matched = 0

  // 限流 16 并发：上万本书时一次性开满会打爆 libuv 线程池（默认 4 线程），
  // 反而让单个 stat 排队更久
  const queue = [...relPaths]
  const worker = async (): Promise<void> => {
    for (;;) {
      const rel = queue.shift()
      if (rel === undefined) return
      if (await probePath(join(newPath, rel), PROBE_TIMEOUT_MS)) matched++
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, relPaths.length) }, worker))

  return { matched, missing: relPaths.length - matched }
}
