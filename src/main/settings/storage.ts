/**
 * 存储管理（M5-01）：目录用量统计与封面缓存裁剪。
 *
 * 两个函数都**不读设置**：上限由调用方传入，这样自检可以直接给一个 1KB 的上限
 * 在临时目录里跑，不必去改库。
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../log'

const log = createLogger('storage')

export interface DirStats {
  dir: string
  files: number
  bytes: number
}

export interface PruneResult {
  files: number
  bytes: number
}

/**
 * 递归统计一个目录。目录不存在算 0（用户从没下载过封面是常态，不是错误）。
 *
 * 用 `withFileTypes` 而不是 `stat` 判断类型：前者走一次 readdir 就带上了类型，
 * 后者每个条目都要多发一次系统调用，几万张封面时差别很明显。
 */
export async function dirStats(dir: string): Promise<DirStats> {
  const out: DirStats = { dir, files: 0, bytes: 0 }

  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        out.files += 1
        out.bytes += info.size
      } catch {
        // 统计过程中被删掉：跳过，不要因为一个文件让整页数字出错
      }
    }
  }

  await walk(dir)
  return out
}

/**
 * 按总大小上限裁剪目录，**最旧的先删**。
 *
 * `coverCacheLimitMb <= 0` 表示不限制（设置页的「不限制」）。
 * 只用于封面：正文缓存有 TTL 与「按书清理」，不按大小删——删掉用户正在读的那本
 * 的正文，下次翻页要重新联网，比占几十 MB 更难受。
 *
 * 删除顺序按 mtime 而不是文件名：内容哈希命名看不出新老，而 mtime 就是
 * 「这张封面最后一次被写入的时间」，最贴近「还有没有人在用」。
 */
export async function pruneCovers(dir: string, limitBytes: number): Promise<PruneResult> {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return { files: 0, bytes: 0 }

  let entries: {
    name: string
    size: number
    mtimeMs: number
  }[]
  try {
    const names = await readdir(dir)
    entries = []
    for (const name of names) {
      const full = join(dir, name)
      try {
        const info = await stat(full)
        if (info.isFile()) entries.push({ name, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // 并发删除，忽略
      }
    }
  } catch {
    return { files: 0, bytes: 0 }
  }

  const total = entries.reduce((sum, item) => sum + item.size, 0)
  if (total <= limitBytes) return { files: 0, bytes: 0 }

  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let remaining = total
  const removed: PruneResult = { files: 0, bytes: 0 }
  for (const entry of entries) {
    if (remaining <= limitBytes) break
    try {
      await unlink(join(dir, entry.name))
      remaining -= entry.size
      removed.files += 1
      removed.bytes += entry.size
    } catch {
      // 删不掉就跳过：可能是正在被某个渲染进程读取，下次启动还会再裁一次
    }
  }

  if (removed.files > 0) {
    log.info('封面缓存裁剪完成', { dir, limitBytes, ...removed, remaining })
  }
  return removed
}
