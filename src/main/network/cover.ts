/**
 * 网络书封面下载（M4-10）。
 *
 * M4-09 留下的坑：`books.cover_path` 只指本地文件，网络书的远端封面 URL 没有列可存，
 * 详情页与书架一律走「按书名取色」的占位封面。这一层把远端封面下载到
 * `userData/covers`，文件名沿用封面缓存既有约定 `cover_<16位哈希>.<ext>`——
 * `ctext-asset` 协议正是按这个前缀分辨「书内插图」和「封面」的。
 *
 * 四条边界：
 *   1. **失败即放弃，不重试**。封面是装饰，为它拖慢「加入书架」或者报错都不值。
 *   2. **只收位图**。`image/svg+xml` 明确拒绝：SVG 能内嵌脚本，虽然走 `<img>` 不会执行，
 *      但没有理由为一本书的封面引入这个面。
 *   3. **内容哈希命名**。同一张图重复下载只落一份；换站点换了图也只是多一个文件，
 *      不会覆盖掉另一本书正在用的封面。
 *   4. **上限 2MB**。封面超过这个尺寸基本是站点把原图直出了，存下来对磁盘没有意义。
 */
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HttpClient } from '../engine/http/client'

const MAX_COVER_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 10_000

/** Content-Type → 扩展名。故意不含 svg（见文件头第 2 条） */
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp'
}

export interface SavedCover {
  /** 落盘文件名（库里存的就是它） */
  name: string
  bytes: number
  /** true = 这张图之前已经存在，没有重写 */
  reused: boolean
}

/**
 * 下载封面并落盘。任何一步不满足都返回 `null`，由调用方决定「没有封面」怎么展示。
 *
 * 返回文件名而不是绝对路径：`covers` 目录是固定的，库里存文件名换机器也不会失效
 * （与本地书导入时的做法一致）。
 */
export async function downloadCover(
  http: HttpClient,
  url: string,
  dir: string
): Promise<SavedCover | null> {
  let response
  try {
    response = await http.fetch(url, {
      raw: true,
      timeoutMs: TIMEOUT_MS,
      maxBodyBytes: MAX_COVER_BYTES,
      headers: { accept: 'image/*' }
    })
  } catch {
    return null
  }

  if (response.status >= 400) return null
  const contentType = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const ext = EXT_BY_TYPE[contentType]
  if (ext === undefined) return null

  const bytes = response.raw
  if (bytes === undefined || bytes.length === 0) return null

  const name = `cover_${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`
  const file = join(dir, name)

  try {
    const info = await stat(file)
    if (info.isFile() && info.size === bytes.length) return { name, bytes: bytes.length, reused: true }
  } catch {
    // 没下载过，继续写
  }

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, bytes)
  } catch {
    return null
  }
  return { name, bytes: bytes.length, reused: false }
}
