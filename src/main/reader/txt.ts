/**
 * TXT 正文读取（M2-01 / M2-02）。
 *
 * **读取本身在 Python worker 里做**（`parse.txt.read`），这里只做编排与呈现：
 *   1. 编码知识只在一处（`textenc` + 各 codec）。Node 侧若自己维护一份
 *      「Python codec 名 → WHATWG 标签」的映射，迟早和 Python 对不上。
 *   2. 窗口末尾的半个字符要靠增量解码器精确回退字节数，Python 直接给得出。
 *   3. 大文件的区间读与将来的流式索引都在同一侧，省一次跨进程搬字节。
 *
 * **一次读取不会把整本书抖进内存**：worker 侧有 4MB 窗口上限，超出时回
 * `hasMore`，由调用方标 `truncated`（继续读由 M2-04 的分页按需驱动）。
 * 一条 200MB 的无章节 TXT 因此只占一个窗口的内存，而不是 400MB 的字符串。
 *
 * 分段的两个细节：
 *   - 空行不产出空段落：中文 TXT 段落之间普遍隔一个空行，照搬成 `<p></p>`
 *     会把段距撑成两倍。每段缩进交给 CSS（text-indent）。
 *   - 首行若等于章标题则丢掉：`chapters.offset` 指向标题行本身（M1-04 的产出），
 *     而 DTO 已经把标题单独给出。只在「完全相同」时丢，所以「无章节标记的书
 *     （首章=全文）」不受影响。
 */
import { getPythonBridge } from '../bridge'

export interface TxtWindow {
  /** 已解码的纯文本（**未转义**） */
  text: string
  /** 本次实际消费的字节数（可能小于请求长度：收在行边界或半个字符之前） */
  bytesConsumed: number
  /** 这一段之后还有内容（窗口被 maxBytes 截住） */
  hasMore: boolean
}

/**
 * 读一章的一段。`length` 为 null 表示「到文件末尾」。
 *
 * 超时用默认 15s：窗口最大 4MB，慢盘也就几百毫秒；真超时说明是别的问题，
 * 不该用「等更久」掩盖。
 */
export async function readTxtWindow(
  absPath: string,
  offset: number,
  length: number | null,
  encoding: string | null
): Promise<TxtWindow> {
  return getPythonBridge().request<TxtWindow>('parse.txt.read', {
    path: absPath,
    offset,
    length,
    encoding: encoding ?? 'utf-8'
  })
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

/** 纯文本 → 段落 HTML（`titleToStrip` 见文件头第 2 条） */
export function textToHtml(text: string, titleToStrip: string | null = null): string {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (titleToStrip && paragraphs[0] === titleToStrip.trim()) paragraphs.shift()
  return paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
}
