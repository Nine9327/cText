/**
 * 单本书的导入准备（M1-06）。
 *
 * 职责：把一个**已通过去重**的文件，变成一条可以直接落库的 `BookInput`：
 * 探测编码 → 解析元数据 → 解析目录 → 抽封面。
 *
 * 三个刻意的设计：
 *
 * 1. **编码只探测一次**。M1-04 的遗留是「parse.detect / parse.meta /
 *    parse.txt.outline 各探测一次」，500 本书就是 1500 次 16KB 读取 + 统计模型。
 *    这里先 `parse.detect` 拿结果，后面两个调用都传 `encoding` 复用。
 * 2. **解析失败必须抛出可读原因**，由调度层记进失败清单。文案来自 worker 的错误码，
 *    不含绝对路径（脱敏要求），用户能直接看懂「文件已损坏」还是「受 DRM 保护」。
 * 3. **不碰数据库**。准备阶段纯计算，写库由 `db/repositories/books.ts` 在批事务里完成，
 *    这样「解析成功但写库失败」和「解析失败」是两类可以分开归因的错误。
 */
import { basename, extname } from 'node:path'
import { AppError, ERROR_CODES } from '@shared/errors'
import type { BookFormat } from '@shared/dto'
import type { BookInput, ChapterInput } from '../db/repositories/books'
import { getPythonBridge } from '../bridge'
import type { DedupeEntry } from './dedupe'

/** 单本解析的超时。200MB 的 TXT 做全量章节扫描也就几秒，60s 是给杀软/慢盘留的余量 */
export const PARSE_TIMEOUT_MS = 60_000

export interface PrepareContext {
  rootId: string
  /** 封面落盘目录（绝对路径，通常 userData/covers） */
  coversDir: string
  timeoutMs?: number
}

interface DetectResult {
  format: string
  encoding: string | null
  size: number
}

interface MetaResult {
  title: string | null
  author: string | null
  intro: string | null
  publisher?: string | null
  pubDate?: string | null
  lang: string | null
}

interface TxtOutlineResult {
  encoding: string
  chapters: { idx: number; title: string; level: number; offset: number; length: number }[]
}

interface EpubTocResult {
  chapters: { idx: number; title: string; level: number; href: string }[]
  chapterCount: number
  source: string
}

interface CoverResult {
  coverPath: string | null
  reason: string | null
  coverFile?: string
}

/** 按扩展名判定格式。D1 决策：只有 txt / epub，其余一律拒绝 */
export function formatOf(relPath: string): BookFormat {
  const ext = extname(relPath).toLowerCase()
  if (ext === '.txt') return 'txt'
  if (ext === '.epub') return 'epub'
  throw new AppError(ERROR_CODES.invalidArgument, '不支持的文件格式')
}

/** 文件名去后缀作为书名兜底；EPUB 的 dc:title 可能缺失 */
function stemOf(relPath: string): string {
  const name = basename(relPath)
  const ext = extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

/** 把 worker 报的章节转成库表行。字段语义见 `chapters` DDL 注释 */
function toChapterInputs(format: BookFormat, payload: TxtOutlineResult | EpubTocResult): ChapterInput[] {
  if (format === 'epub') {
    return (payload as EpubTocResult).chapters.map((chapter) => ({
      idx: chapter.idx,
      title: chapter.title,
      // EPUB 的 anchor 是 zip 内路径，M2-03 直接读
      anchor: chapter.href,
      length: null,
      level: chapter.level
    }))
  }

  return (payload as TxtOutlineResult).chapters.map((chapter) => ({
    idx: chapter.idx,
    title: chapter.title,
    // TXT 的 anchor 是字节偏移的字符串形式（DDL 是 TEXT，允许两种语义共存）
    anchor: String(chapter.offset),
    length: chapter.length,
    level: chapter.level
  }))
}

export async function prepareBook(entry: DedupeEntry, ctx: PrepareContext): Promise<BookInput> {
  if (!entry.hash) {
    // 去重阶段没算出指纹的项不该进入准备阶段，出现即调度层有 bug
    throw new AppError(ERROR_CODES.internal, '缺少内容指纹')
  }

  const format = formatOf(entry.file.relPath)
  const absPath = entry.file.absPath
  const timeoutMs = ctx.timeoutMs ?? PARSE_TIMEOUT_MS
  const bridge = getPythonBridge()

  // ① 编码只探测一次。EPUB 是 zip 容器，探测编码没有意义（worker 侧会跳过）
  const detected = await bridge.request<DetectResult>('parse.detect', { path: absPath }, { timeoutMs })
  const encoding = detected.encoding

  // ② 元数据
  const meta = await bridge.request<MetaResult>(
    'parse.meta',
    { path: absPath, format, ...(encoding ? { encoding } : {}) },
    { timeoutMs }
  )

  // ③ 目录
  const toc = await bridge.request<TxtOutlineResult | EpubTocResult>(
    format === 'epub' ? 'parse.epub.toc' : 'parse.txt.outline',
    format === 'epub' ? { path: absPath } : { path: absPath, encoding: encoding ?? 'auto' },
    { timeoutMs }
  )
  const chapters = toChapterInputs(format, toc)

  // ④ 封面：只有 EPUB 有内嵌封面；TXT 的封面留到 M1-07 用「书名 + 哈希取色」生成占位
  let coverPath: string | null = null
  if (format === 'epub') {
    const cover = await bridge.request<CoverResult>(
      'cover.extract',
      { path: absPath, destDir: ctx.coversDir },
      { timeoutMs }
    )
    // 库里存的是**文件名**（covers 目录是固定的），换机器/换盘符不会让旧封面失效
    coverPath = cover.coverPath ? basename(cover.coverPath) : null
  }

  const title = meta.title?.trim() || stemOf(entry.file.relPath)

  return {
    title,
    author: meta.author?.trim() || null,
    format,
    rootId: ctx.rootId,
    relPath: entry.file.relPath,
    fileHash: entry.hash,
    sizeBytes: entry.file.size,
    encoding,
    coverPath,
    intro: meta.intro,
    publisher: meta.publisher ?? null,
    pubDate: meta.pubDate ?? null,
    language: meta.lang,
    chapterCount: chapters.length,
    chapters
  }
}
