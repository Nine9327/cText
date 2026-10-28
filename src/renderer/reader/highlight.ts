/**
 * 划线渲染（M2-09）。
 *
 * 划线的存储是「章 + 起点偏移 + 终点偏移」，渲染就是把这两个整数还原成 DOM 上的
 * 一段文字。做法是**切分文本节点**并用 `<mark>` 包住：
 *   - 不用「按文本查找」：同一章里重复的句子太多，一定会有划错位置的那天；
 *   - `<mark>` 只带背景色、没有内外边距，**不改变排版**，所以套完不需要重新分页
 *     （重排只会发生在字号/窗口变化时，那时本来就要重排）。
 *
 * 一次渲染必须先把上一次的 `<mark>` 拆掉并 `normalize()` 回去：不拆的话每翻一次页
 * 都会在文本节点上再切一刀，几十次之后一个段落会碎成上百个节点，滚动与测量全部变慢。
 */
import type { TextIndex } from './text-index'

export interface HighlightRange {
  id: string
  offset: number
  /** 右开区间；null 表示纯书签，不画 */
  endOffset: number | null
}

/** 拆掉所有 mark 并把文本节点合并回去 */
export function clearHighlights(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll('mark[data-hl-id]'))
  const touched = new Set<Node>()
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    touched.add(parent)
  }
  for (const parent of touched) {
    if (parent instanceof Element) parent.normalize()
  }
}

/**
 * 按区间套 `<mark>`。返回实际套上的数量。
 *
 * `index` 必须是**当前 DOM** 的字符索引（DOM 变了要重建），区间超出章末的直接跳过。
 */
export function applyHighlights(root: HTMLElement, index: TextIndex, ranges: HighlightRange[]): number {
  // 先收集所有文本节点及其起点：切分过程中 DOM 会变，边切边查偏移必然错
  const spans: { node: Text; start: number; end: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let cursor = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    const length = text.data.length
    if (length > 0) {
      spans.push({ node: text, start: cursor, end: cursor + length })
      cursor += length
    }
  }
  if (cursor !== index.total) {
    // 索引与 DOM 不一致时宁可什么都不画：画错位置比不画更糟
    return 0
  }

  let drawn = 0
  for (const range of ranges) {
    const end = range.endOffset
    if (end === null || end <= range.offset) continue

    // 与区间相交的文本节点，按出现顺序处理；**同一个节点内先切右再切左**，
    // 这样左侧的下标不会被前面的切分挪动
    for (const span of spans) {
      if (span.start >= end || span.end <= range.offset) continue
      let node = span.node
      if (!node.isConnected) continue
      const localStart = Math.max(0, range.offset - span.start)
      const localEnd = Math.min(node.data.length, end - span.start)
      if (localEnd < node.data.length) node.splitText(localEnd)
      if (localStart > 0) node = node.splitText(localStart)

      const mark = document.createElement('mark')
      mark.className = 'ct-hl'
      mark.dataset['hlId'] = range.id
      node.parentNode?.insertBefore(mark, node)
      mark.appendChild(node)
      drawn += 1
    }
  }
  return drawn
}

/**
 * 读出当前 DOM 里的划线（验收用，也给「画出错位」这类问题做现场取证）。
 * 偏移按 `textContent` 累计，与存储用的是同一套坐标系。
 */
export function readHighlights(root: HTMLElement): { id: string; offset: number; endOffset: number; text: string }[] {
  const found = new Map<string, { offset: number; endOffset: number; text: string }>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let cursor = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    const length = text.data.length
    const mark = text.parentElement?.closest<HTMLElement>('mark[data-hl-id]')
    if (mark) {
      const id = mark.dataset['hlId'] ?? ''
      const entry = found.get(id) ?? { offset: cursor, endOffset: cursor, text: '' }
      entry.endOffset = cursor + length
      entry.text += text.data
      found.set(id, entry)
    }
    cursor += length
  }
  return Array.from(found, ([id, value]) => ({ id, ...value }))
}
