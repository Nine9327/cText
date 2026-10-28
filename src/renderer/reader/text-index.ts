/**
 * 章内字符位置索引（M2-04 起，M2-05 复用）。
 *
 * 阅读器里到处都要回答两类问题：
 *   - 「这个字符在屏幕上的哪一点」→ 页号、滚动位置
 *   - 「屏幕上的这一点是第几个字符」→ 存进度、恢复位置
 *
 * 两边的坐标系不同（分页是「第几列」，滚动是「纵向第几像素」），但**把 DOM 拆成
 * 字符区间**这件事是一样的，所以抽到这里，避免分页与滚动各写一套遍历 + 二分。
 *
 * 一个约定：**偏移是内容区 `textContent` 的下标**，不是 UTF-16 之外的什么单位，
 * 也不含标签。这样它既能在重排后复用（DOM 不变），也能直接落库（M2-08 的
 * `reading_progress.offset`）。
 */
interface Span {
  node: Text
  /** 该文本节点首字符在整章里的偏移 */
  start: number
}

export class TextIndex {
  private spans: Span[] = []
  private length = 0

  /** DOM 变了（换章 / 正文替换）才需要重建；改字号、缩放窗口都不用 */
  rebuild(root: HTMLElement): void {
    const spans: Span[] = []
    let start = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text
      const len = text.data.length
      if (len === 0) continue
      spans.push({ node: text, start })
      start += len
    }
    this.spans = spans
    this.length = start
  }

  get total(): number {
    return this.length
  }

  /** 把任意偏移夹进 [0, total-1] */
  clamp(offset: number): number {
    if (!Number.isFinite(offset)) return 0
    return Math.min(Math.max(0, Math.trunc(offset)), Math.max(0, this.length - 1))
  }

  /**
   * 该字符的边界矩形（**视口坐标**，已含当前滚动/位移）。
   *
   * 只取一个字符而不是整个文本节点：跨列的段落，节点整体的 rect 是各列矩形的并集，
   * 用它算页号会把整段算到同一页。单字符的 rect 永远落在它真实所在的那一栏。
   */
  rectAt(offset: number): DOMRect | null {
    if (this.length === 0) return null
    const position = this.locate(this.clamp(offset))
    if (!position) return null
    const range = document.createRange()
    range.setStart(position.node, position.local)
    range.setEnd(position.node, Math.min(position.local + 1, position.node.data.length))
    const rect = range.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return rect
    const rects = range.getClientRects()
    return rects.length > 0 ? rects[0]! : rect
  }

  /**
   * 二分查找「第一个满足条件的偏移」。
   *
   * 调用方保证 `predicate` 随偏移单调（不从 true 变回 false）——分页用「列号」，
   * 滚动用「纵向位置」，两者都随阅读顺序单调不减。找不到时返回最后一个偏移。
   */
  firstWhere(predicate: (rect: DOMRect, offset: number) => boolean): number {
    if (this.length === 0) return 0
    let lo = 0
    let hi = this.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const rect = this.rectAt(mid)
      if (rect && predicate(rect, mid)) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  /**
   * (DOM 节点, 节点内下标) → 章内字符偏移。取选区端点用。
   *
   * 选区端点常常落在**元素**上（拖到段落边界时 `anchorNode` 是 `<p>` 而不是文本节点），
   * 所以要能下探到那个位置之后的第一个文本节点；找不到返回 -1，调用方当作「无选区」。
   */
  offsetAt(node: Node, local: number): number {
    const resolved = this.resolveText(node, local)
    if (!resolved) return -1
    const span = this.spans.find((item) => item.node === resolved.node)
    if (!span) return -1
    return span.start + Math.min(resolved.local, resolved.node.data.length)
  }

  private resolveText(node: Node, local: number): { node: Text; local: number } | null {
    if (node.nodeType === Node.TEXT_NODE) return { node: node as Text, local }
    const children = node.childNodes
    if (children.length === 0) return null
    const start = children[Math.min(Math.max(0, local), children.length - 1)]!
    if (start.nodeType === Node.TEXT_NODE) return { node: start as Text, local: 0 }
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT)
    const first = walker.nextNode() as Text | null
    return first ? { node: first, local: 0 } : null
  }

  /** 偏移 → (文本节点, 节点内下标) */
  private locate(offset: number): { node: Text; local: number } | null {
    if (this.spans.length === 0) return null
    let lo = 0
    let hi = this.spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.spans[mid]!.start <= offset) lo = mid
      else hi = mid - 1
    }
    const span = this.spans[lo]!
    return { node: span.node, local: Math.min(offset - span.start, span.node.data.length - 1) }
  }
}
