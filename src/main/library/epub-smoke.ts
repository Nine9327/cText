/**
 * M1-05 链路自检：经 Python bridge 调 EPUB 解析。
 *
 * 算法准确性由 `python/smoke_epub.py` 覆盖（那边能按结构生成 26 种样本）。
 * 这里验的是**另一半**：Electron 主进程 → NDJSON → worker → 返回，以及
 * 封面这种「Python 写盘、主进程读回」的跨进程副作用。
 *
 * 样本由 `verify-epub.mjs` 用 `smoke_epub.py --emit <dir>` 先铺到临时目录，
 * 通过 `CTEXT_EPUB_SAMPLES` 传进来——两个阶段共用同一批文件，
 * 不会出现「Python 侧过了但链路跑的是另一份数据」。
 *
 * 只在 `!app.isPackaged && CTEXT_EPUB_SMOKE=1` 时执行。
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getPythonBridge } from '../bridge'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(40)
  }
  return predicate()
}

interface TocResult {
  chapters: { idx: number; title: string; level: number; href: string }[]
  chapterCount: number
  source: string
  spineCount: number
  version: string | null
  empty: boolean
}

interface MetaResult {
  title: string | null
  author: string | null
  lang: string | null
  intro: string | null
  publisher: string | null
  coverPath: string | null
  coverHref: string | null
  coverSource: string | null
  epubVersion: string | null
}

interface CoverResult {
  coverPath: string | null
  reason: string | null
  width: number | null
  height: number | null
  source?: string
}

export async function runEpubSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const samples = process.env['CTEXT_EPUB_SAMPLES']
  if (!samples || !existsSync(samples)) {
    check('样本目录可用', false, `CTEXT_EPUB_SAMPLES=${samples ?? '未设置'}`)
    return checks
  }

  const coversDir = join(app.getPath('temp'), `ctext-epub-covers-${Date.now()}`)

  try {
    const bridge = getPythonBridge()
    bridge.start()

    // worker 冷启动要拉起 Python 进程并握手，15s 是给杀软扫描留的余量
    const ready = await waitFor(() => bridge.getStatus().state === 'ready', 15_000)
    check('worker 就绪', ready, bridge.getStatus().state)
    if (!ready) return checks

    const health = await bridge.ping(5_000)
    check(
      'EPUB 方法已注册',
      health.methods.includes('parse.epub.toc') && health.methods.includes('cover.extract'),
      health.methods.filter((m) => m.startsWith('parse') || m.startsWith('cover')).join(',')
    )
    check(
      '解析依赖就位（lxml / PIL）',
      ['lxml', 'charset_normalizer', 'PIL'].every((name) => health.deps[name] === true),
      JSON.stringify(health.deps)
    )
    // ebooklib 已移除：EPUB 改用标准库 zipfile + lxml 直接解析
    check('ebooklib 已从依赖清单移除', health.deps['ebooklib'] === undefined, JSON.stringify(Object.keys(health.deps)))

    // 分卷目录：层级与中文标题必须原样过桥
    const volumeToc = await bridge.request<TocResult>('parse.epub.toc', {
      path: join(samples, 'toc_volume.epub')
    })
    check('bridge 调用 parse.epub.toc 得到 6 条', volumeToc.chapterCount === 6, String(volumeToc.chapterCount))
    check(
      '卷章层级 0/1/1/0/1/1 过桥后不变',
      volumeToc.chapters.map((c) => c.level).join(',') === '0,1,1,0,1,1',
      volumeToc.chapters.map((c) => c.level).join(',')
    )
    check('分卷标题中文无损', volumeToc.chapters[0]?.title === '第一卷 风起', volumeToc.chapters[0]?.title ?? '无')
    check('目录来源为 nav', volumeToc.source === 'nav', volumeToc.source)
    check(
      'href 为 zip 内完整路径',
      volumeToc.chapters[0]?.href === 'OEBPS/Text/1.xhtml',
      volumeToc.chapters[0]?.href ?? '无'
    )

    // OPF 元数据
    const meta = await bridge.request<MetaResult>('parse.meta', {
      path: join(samples, 'meta_full.epub'),
      format: 'epub'
    })
    check('OPF 书名过桥', meta.title === '斗破苍穹', String(meta.title))
    check('OPF 作者过桥', meta.author === '天蚕土豆', String(meta.author))
    check('parse.meta 不落封面文件', meta.coverPath === null, String(meta.coverPath))
    // meta_full.epub 本身没有封面图，这里应当明确是 null 而不是空串
    check('无封面书回传 coverHref 为 null', meta.coverHref === null, String(meta.coverHref))

    const withCover = await bridge.request<MetaResult>('parse.meta', {
      path: join(samples, 'cover_meta.epub'),
      format: 'epub'
    })
    check('有封面书回传 coverHref', withCover.coverHref === 'OEBPS/images/cover.jpg', String(withCover.coverHref))
    check('回传封面来源', withCover.coverSource === 'meta-cover', String(withCover.coverSource))

    // 封面：Python 写盘 → 主进程读得回来
    mkdirSync(coversDir, { recursive: true })
    const cover = await bridge.request<CoverResult>('cover.extract', {
      path: join(samples, 'cover_meta.epub'),
      destDir: coversDir
    })
    check('封面被提取', typeof cover.coverPath === 'string' && cover.coverPath.length > 0, String(cover.coverPath))
    if (cover.coverPath) {
      check('封面文件在主进程可见', existsSync(cover.coverPath) && statSync(cover.coverPath).size > 0, cover.coverPath)
      check('封面落在指定 destDir', cover.coverPath.startsWith(coversDir), cover.coverPath)
      check('封面尺寸过桥', cover.width === 12 && cover.height === 16, `${cover.width}x${cover.height}`)
    }
    check('封面来源为 meta-cover', cover.source === 'meta-cover', String(cover.source))

    const noCover = await bridge.request<CoverResult>('cover.extract', {
      path: join(samples, 'cover_none.epub'),
      destDir: coversDir
    })
    check('无封面不报错', noCover.coverPath === null && noCover.reason === 'no-cover', String(noCover.reason))

    // 错误码透传：DRM 与损坏必须能被导入面板区分开
    try {
      await bridge.request('parse.epub.toc', { path: join(samples, 'drm_content.epub') })
      check('DRM 书透传 E_PARSE_FAILED', false, '未抛错')
    } catch (err) {
      const code = (err as { code?: string }).code
      check('DRM 书透传 E_PARSE_FAILED', code === 'E_PARSE_FAILED', String(code))
      check('DRM 文案可读', /DRM/.test((err as Error).message), (err as Error).message)
    }

    try {
      await bridge.request('parse.epub.toc', { path: join(samples, 'bad_corrupt.epub') })
      check('损坏文件透传 E_PARSE_FAILED', false, '未抛错')
    } catch (err) {
      const code = (err as { code?: string }).code
      check('损坏文件透传 E_PARSE_FAILED', code === 'E_PARSE_FAILED', String(code))
    }

    try {
      await bridge.request('cover.extract', { path: join(samples, 'cover_meta.epub'), destDir: 'relative/dir' })
      check('相对 destDir 透传 E_INVALID_ARGUMENT', false, '未抛错')
    } catch (err) {
      const code = (err as { code?: string }).code
      check('相对 destDir 透传 E_INVALID_ARGUMENT', code === 'E_INVALID_ARGUMENT', String(code))
    }
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    try {
      rmSync(coversDir, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响结论
    }
  }

  return checks
}
