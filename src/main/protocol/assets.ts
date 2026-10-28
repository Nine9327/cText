/**
 * EPUB 图片资源协议（M2-03）。
 *
 * EPUB 里的图片藏在 zip 里，渲染层拿不到 `file://`（CSP 拦，且 zip 不是目录）。
 * 方案是 **Python 抽字节 → 落盘到 `userData/epub-assets` → 自定义协议提供**：
 *
 *   - 抽取侧不在这里：`parse.epub.chapter` 已经把 `<img src>` 换成了
 *     `ctext-asset://asset/<sha1-16>.<ext>`（内容哈希命名，同一张图只落一份）。
 *   - 这一侧只做**白名单校验 + 读文件**。文件名必须严格匹配「16 位十六进制哈希 +
 *     白名单后缀」，任何 `..`、绝对路径、编码后的分隔符都会在正则这一关被拒——
 *     否则渲染层里一段被注入的 HTML 就能用 `<img src="ctext-asset://...">` 读任意文件。
 *   - 协议只用于**图片**：不做目录列举、不给 `text/html`，避免变成通用的本地文件通道。
 *
 * `registerSchemesAsPrivileged` 必须在 app ready 之前调用，所以它单独成一个函数，
 * 由 index.ts 在模块顶部（也就是 ready 之前）执行。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, protocol } from 'electron'

export const ASSET_SCHEME = 'ctext-asset'
const ASSET_HOST = 'asset'

/** 名字必须是我们自己写出去的形状：内容哈希 + 图片后缀 */
const NAME_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp|bmp|svg)$/

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

/** 图片缓存目录（与 covers 同级，但分开：书内插图可能很多） */
export function assetsDir(): string {
  return join(app.getPath('userData'), 'epub-assets')
}

/** 必须在 app ready 之前调用 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

/**
 * 从 URL 里取出安全的资源名；任何一个条件不满足都返回 null。
 *
 * 单独导出是为了能被自检直接断言「穿越形 URL 会被拒」，
 * 不必为了测一条正则去起一个协议请求。
 */
export function assetNameOf(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${ASSET_SCHEME}:`) return null
  if (url.hostname !== ASSET_HOST) return null
  let name: string
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    return null
  }
  return NAME_RE.test(name) ? name : null
}

/** 在 app ready 之后调用 */
export function installAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const name = assetNameOf(request.url)
    if (!name) return new Response('', { status: 400 })

    try {
      const bytes = await readFile(join(assetsDir(), name))
      const ext = name.split('.').pop() ?? ''
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          // 图片按内容哈希命名，内容不可变，可以放心长缓存
          'cache-control': 'max-age=86400',
          'access-control-allow-origin': '*'
        }
      })
    } catch {
      return new Response('', { status: 404 })
    }
  })
}
