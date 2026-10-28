/**
 * TXT 正文读取（M2-01）。
 *
 * 只做三件事：按章节的**字节区间**读一段、按探测出的编码解码、切成段落并转义成 HTML。
 * 不做分页、不做排版——那是 M2-04 的事。
 *
 * 三个约束：
 *   1. **必须按字节 seek**。`chapters.anchor` 是字节偏移（M1-04 的产出），
 *      用字符偏移会在大段非 ASCII 文本里整体错位。章节起始天然落在字符边界上，
 *      因为偏移本来就是从「重新编码后的长度」累计出来的。
 *   2. **解码必须用书自己的编码**。GBK 的书按 UTF-8 解会得到一屏乱码，
 *      而用户看不出是编码问题还是文件坏了。
 *   3. **绝不把原文直接拼进 HTML**。正文里出现 `<` 是常态（数学式、颜文字），
 *      直接拼会把一章吞掉半页。所有文本都过 escapeHtml。
 *
 * 一次性读整章进内存：单章通常几十 KB，够了。**>50MB 的流式分段读属 M2-02**，
 * 那时会把这里换成 worker 侧的 `parse.txt.read`（带索引与区间读），
 * 本文件的解码/分段逻辑保持不动。
 */
import { open } from 'node:fs/promises'

/** Python codec 名 → WHATWG 解码标签。TextDecoder 只认后者 */
const DECODER_LABELS: Record<string, string> = {
  'utf-8': 'utf-8',
  'utf-8-sig': 'utf-8',
  // BOM 由 TextDecoder 默认剥掉（ignoreBOM=false），所以 -sig 直接归到 utf-8
  'utf-16': 'utf-16le',
  'utf-16-le': 'utf-16le',
  'utf-16-be': 'utf-16be',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'big5-hkscs': 'big5'
}

/** 未知编码一律按 UTF-8 解：解出乱码也比抛错让人打不开书好 */
export function decoderLabel(encoding: string | null): string {
  if (!encoding) return 'utf-8'
  return DECODER_LABELS[encoding.trim().toLowerCase()] ?? 'utf-8'
}

export function decodeBytes(buffer: Buffer, encoding: string | null): string {
  const label = decoderLabel(encoding)
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string)
}

/**
 * 纯文本 → 段落 HTML。
 *
 * 两个细节：
 *   - **空行不产出空段落**：中文 TXT 里段落之间普遍隔一个空行，照搬成 `<p></p>`
 *     会把段距撑成两倍。每段缩进交给 CSS（text-indent），所以先 trim。
 *   - **首行若等于章标题则丢掉**：`chapters.offset` 指向标题行本身（M1-04 的产出），
 *     而 DTO 已经把标题单独给出去了。不丢的话阅读器会出现两行一模一样的标题。
 *     只在「与标题完全相同」时丢，所以「无章节标记的书」那种首章=全文的情况不受影响。
 */
export function textToHtml(text: string, titleToStrip: string | null = null): string {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (titleToStrip && paragraphs[0] === titleToStrip.trim()) paragraphs.shift()
  return paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}

/**
 * 读一章的正文。
 *
 * `offset` / `length` 都来自 `chapters` 表；`length` 为 null 表示「读到文件末尾」
 * （只有 EPUB 会这样，TXT 不会，但保留这个语义免得将来漏判）。
 * 读到文件尾就截断，不抛错——目录与文件对不上时，宁可给出能看的内容。
 */
export async function readTxtChapter(
  absPath: string,
  offset: number,
  length: number | null,
  encoding: string | null,
  titleToStrip: string | null = null
): Promise<string> {
  const fh = await open(absPath, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.min(Math.max(0, offset), size)
    const end = length === null ? size : Math.min(size, start + Math.max(0, length))
    const wanted = end - start
    if (wanted <= 0) return ''

    const buffer = Buffer.alloc(wanted)
    let filled = 0
    while (filled < wanted) {
      const { bytesRead } = await fh.read(buffer, filled, wanted - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const text = decodeBytes(filled === wanted ? buffer : buffer.subarray(0, filled), encoding)
    return textToHtml(text, titleToStrip)
  } finally {
    await fh.close()
  }
}
