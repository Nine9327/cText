/**
 * 文件内容指纹（M1-03）。
 *
 * 产品文档 §2.4：「跨根目录按 `file_hash`（内容指纹）判重」。
 * 算法按开发计划定的是 **size + 首末 4KB sha1**，不是全文哈希——理由是成本：
 * 一个 200MB 的 TXT 全文 sha1 要读满 200MB，而首末各 4KB 只读 8KB，恒定耗时。
 *
 * 盲区与兜底：
 *   - size ≤ 8KB 时首末块重叠，等价于全文哈希，没有盲区；
 *   - size > 8KB 时理论上存在「size 相同、首末相同、中间不同」的碰撞。实际要发生，
 *     得替换中间等长字节且不改变文件长度——同一本书的不同版本几乎不可能。
 *   - 万一需要人工确认，用 `fullSha1()` 算全文摘要（贵，只在用户点「仍要导入」时调）。
 *
 * 指纹串把 size 一起喂进 sha1，是因为 DB 的 `file_hash` 只有一列：
 * 把 size 混进去能让「同内容不同长度」的碰撞也带上长度语义，几乎零成本。
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/** 首末块大小。4KB 是「足够代表一个文件的头尾」与「读得足够快」的平衡点 */
export const CHUNK_SIZE = 4096

export interface Fingerprint {
  /** 40 位小写 hex，直接写入 books.file_hash */
  hash: string
  /** 文件字节数（顺带返回，省得上层再 stat 一次） */
  size: number
  /** 算法标记，写日志与排障用；将来换算法时靠它区分老数据 */
  algorithm: 'size+head4k+tail4k'
}

/**
 * 从 `position` 起读满 `length` 字节。
 *
 * `FileHandle.read` 不保证一次读满（虽然本地文件几乎总是一次到位），
 * 这里循环补齐，避免把「少读几个字节」变成静默的指纹错误。
 */
async function readExact(
  fh: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number
): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buf : buf.subarray(0, filled)
}

/** 计算单个文件的指纹。文件不存在 / 无权限会抛出原始 errno，由上层映射错误码 */
export async function fingerprintFile(absPath: string): Promise<Fingerprint> {
  const fh = await open(absPath, 'r')
  try {
    const { size } = await fh.stat()

    const headLength = Math.min(CHUNK_SIZE, size)
    const tailStart = Math.max(0, size - CHUNK_SIZE)
    const tailLength = size - tailStart

    const head = headLength > 0 ? await readExact(fh, headLength, 0) : Buffer.alloc(0)
    // 小文件时首末块完全重叠，复用 head，少一次系统调用
    const tail = tailStart === 0 ? head : await readExact(fh, tailLength, tailStart)

    const digest = createHash('sha1')
    digest.update(String(size))
    digest.update('\0')
    digest.update(head)
    digest.update('\0')
    digest.update(tail)

    return { hash: digest.digest('hex'), size, algorithm: 'size+head4k+tail4k' }
  } finally {
    await fh.close()
  }
}

/**
 * 全文 sha1。只在「疑似重复但用户要确认」时调用，别放进常规导入路径。
 * 返回 `sha1:<hex>` 前缀形式，与 quick 指纹在日志里一眼能区分。
 */
export async function fullSha1(absPath: string): Promise<string> {
  const fh = await open(absPath, 'r')
  try {
    const digest = createHash('sha1')
    const buf = Buffer.alloc(256 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position)
      if (bytesRead === 0) break
      digest.update(buf.subarray(0, bytesRead))
      position += bytesRead
    }
    return `sha1:${digest.digest('hex')}`
  } finally {
    await fh.close()
  }
}

/**
 * 批量计算指纹，限流并发。
 *
 * 默认并发 4：SSD 上再高收益很小，而机械硬盘/移动盘上并发读反而会因为寻道抖动变慢。
 * 单个文件失败不中断整批——失败项进 `failed`，由调用方决定怎么提示。
 */
export async function fingerprintFiles(
  absPaths: readonly string[],
  options: { concurrency?: number; signal?: AbortSignal } = {}
): Promise<{
  results: { absPath: string; fingerprint: Fingerprint | null; error: string | null }[]
  cancelled: boolean
}> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const signal = options.signal
  const queue = [...absPaths]
  const results: { absPath: string; fingerprint: Fingerprint | null; error: string | null }[] = []
  let cancelled = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) {
        cancelled = true
        return
      }
      const path = queue.shift()
      if (path === undefined) return
      try {
        results.push({ absPath: path, fingerprint: await fingerprintFile(path), error: null })
      } catch (err) {
        results.push({
          absPath: path,
          fingerprint: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, absPaths.length) }, worker))

  // 顺序与输入对齐，避免并发完成顺序影响后续判定
  const index = new Map(results.map((r) => [r.absPath, r]))
  return {
    results: absPaths.map((p) => index.get(p) ?? { absPath: p, fingerprint: null, error: '未计算' }),
    cancelled
  }
}
