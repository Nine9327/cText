/**
 * EPUB 章节读取（M2-03）。
 *
 * 章节 HTML 的净化在 Python 侧完成（`render.py`）：XHTML 是不可信输入，
 * 净化必须发生在进入渲染层之前，而图片要从 zip 里抽出来——只有 Python 有 zipfile。
 * 这里只负责把 `chapters.anchor`（zip 内路径）和资源落点传下去。
 */
import { AppError, ERROR_CODES } from '@shared/errors'
import { getPythonBridge } from '../bridge'
import { assetsDir } from '../protocol/assets'

export interface EpubChapter {
  /** 已净化的 HTML 片段；图片 src 已改写成 ctext-asset:// */
  html: string
  images: number
  droppedImages: number
}

export async function readEpubChapter(
  absPath: string,
  href: string,
  title: string | null
): Promise<EpubChapter> {
  if (!href) {
    // 目录里没有这个字段说明数据本身坏了（M1-05 落库时必有 anchor）
    throw new AppError(ERROR_CODES.parseFailed, '这一章缺少内容定位，目录可能已损坏')
  }
  return getPythonBridge().request<EpubChapter>('parse.epub.chapter', {
    path: absPath,
    href,
    destDir: assetsDir(),
    ...(title ? { title } : {})
  })
}
