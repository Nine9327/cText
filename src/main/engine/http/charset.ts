/**
 * 响应体解码（M4-06）。
 *
 * 中文书源里 GBK/GB2312 仍然是主流（尤其老站点），直接把响应当 UTF-8 会得到一片乱码。
 * 顺序与浏览器一致：先看 `Content-Type` 的 charset，再看 HTML 里 `<meta charset>`，
 * 都没有才按 UTF-8 处理。
 *
 * 别名统一走 `gb18030`：它是 GBK / GB2312 的超集，用超集解严格子集的字节不会出错，
 * 反过来才会——所以「声明 GBK、实际含 GB18030 扩展字」的站点也能正确解。
 */
import iconv from 'iconv-lite'

export interface DecodeResult {
  text: string
  /** 最终实际使用的编码 */
  charset: string
  /** 响应里声明的编码（含 meta 嗅探），未声明为 null */
  declared: string | null
}

/** 声明名 → iconv 可用的规范名；不认识的返回 null */
const ALIASES: Record<string, string> = {
  'utf-8': 'utf8',
  utf8: 'utf8',
  gb2312: 'gb18030',
  'gb-2312': 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'big-5': 'big5',
  'iso-8859-1': 'latin1',
  latin1: 'latin1',
  'us-ascii': 'ascii',
  ascii: 'ascii',
  shift_jis: 'shiftjis',
  sjis: 'shiftjis',
  euc_jp: 'eucjp',
  euc_kr: 'euckr'
}

export function charsetFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null
  const match = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)
  return match ? match[1].trim() : null
}

/** 从 HTML 头部嗅探 `<meta charset>` / `<?xml encoding>` */
export function sniffCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 2048).toString('latin1')
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)
  if (meta) return meta[1].trim()
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)
  if (xml) return xml[1].trim()
  return null
}

export function normalizeCharset(name: string | null): string | null {
  if (!name) return null
  const key = name.trim().toLowerCase()
  if (key === '') return null
  const mapped = ALIASES[key]
  if (mapped) return mapped
  return iconv.encodingExists(key) ? key : null
}

export function decodeBody(buffer: Buffer, contentType?: string): DecodeResult {
  const declared = charsetFromContentType(contentType) ?? sniffCharset(buffer)

  // BOM 优先：有 BOM 就是 UTF-8，声明可能写错
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), charset: 'utf8', declared }
  }

  const charset = normalizeCharset(declared)
  if (charset === null) {
    return { text: buffer.toString('utf8'), charset: 'utf8', declared }
  }

  try {
    return { text: iconv.decode(buffer, charset), charset, declared }
  } catch {
    // 声明了一个 iconv 也解不了的编码：退回 UTF-8，至少不崩
    return { text: buffer.toString('utf8'), charset: 'utf8', declared }
  }
}
