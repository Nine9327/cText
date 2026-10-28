/**
 * 滚动模式的位置换算（M2-05）。
 *
 * 与分页引擎共用 `TextIndex`，但坐标只有一个自由维度：纵向。
 * 因此这里不需要「列号 → 页号」那套映射——**第一个可见字符**就是位置，
 * 反过来「把字符滚到顶部」就是恢复位置。
 *
 * 为什么不用 `scrollTop / 总高度` 当进度：段落高度差异很大（空白段、插图、
 * 标题），按比例恢复位置在改字号后会漂出半屏。字符偏移对排版不敏感，
 * 也能直接与分页模式、`reading_progress.offset` 对齐——三种表示最终只有一个。
 */
import { TextIndex } from './text-index'

export interface ScrollSnapshot {
  /** 视口顶部第一个可见字符的章内偏移 */
  offset: number
  total: number
  /** 本章内的滚动比例 0..1（仅用于展示，不用于恢复位置） */
  ratio: number
}

export type ScrollResult = 'ok' | 'edge'

export class ScrollPositioner {
  private readonly viewport: HTMLElement
  private readonly content: HTMLElement
  private readonly index = new TextIndex()
  /** 最近一次记录的「顶部字符」。改字号/切模式时用它把位置还原 */
  private anchorOffset = 0

  constructor(viewport: HTMLElement, content: HTMLElement) {
    this.viewport = viewport
    this.content = content
  }

  get total(): number {
    return this.index.total
  }

  /** 字符索引（划线要把选区端点换算成偏移，读它） */
  get textIndex(): TextIndex {
    return this.index
  }

  get scrollTop(): number {
    return this.viewport.scrollTop
  }

  get maxScrollTop(): number {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight)
  }

  syncDom(): void {
    this.index.rebuild(this.content)
  }

  /**
   * 视口顶部第一个可见字符。
   *
   * 判据是 `rect.bottom > 顶部`：跨过折叠线的那个字符**仍然算可见**，
   * 用 `rect.top >= 顶部` 会把它算成已滚过，恢复位置时就会往前跳一行。
   */
  offsetAtTop(): number {
    if (this.index.total === 0) return 0
    const top = this.viewport.getBoundingClientRect().top
    return this.index.firstWhere((rect) => rect.bottom > top + 1)
  }

  /** 把某个字符滚到视口顶部（尽量；接近章末时会被 scrollTop 上限截住） */
  scrollToOffset(offset: number): void {
    // 先夹到合法区间并同步索引，否则换章后拿旧偏移量不到 rect
    const target = this.index.clamp(offset)
    this.anchorOffset = target
    const rect = this.index.rectAt(target)
    if (!rect) return
    const top = this.viewport.getBoundingClientRect().top
    this.viewport.scrollTop += rect.top - top
  }

  /** 滚动事件里调：把「当前位置」记下来 */
  capture(): number {
    this.anchorOffset = this.offsetAtTop()
    return this.anchorOffset
  }

  /** 排版/尺寸变化后调：回到记下的位置 */
  restore(): void {
    this.scrollToOffset(this.anchorOffset)
  }

  /** 整页滚动。已在边界时返回 edge，由调用方决定要不要换章 */
  scrollPage(direction: 1 | -1): ScrollResult {
    const max = this.maxScrollTop
    if (max <= 0) return 'edge'
    if (direction > 0 && this.viewport.scrollTop >= max - 2) return 'edge'
    if (direction < 0 && this.viewport.scrollTop <= 0) return 'edge'
    // 留一行的重叠：整屏跳过去会让读者丢掉「上一屏最后一行是哪个字」的线索
    this.viewport.scrollTop += direction * this.viewport.clientHeight * 0.9
    this.capture()
    return 'ok'
  }

  /** 单行滚动（方向键） */
  scrollLine(direction: 1 | -1): ScrollResult {
    const max = this.maxScrollTop
    if (max <= 0) return 'edge'
    if (direction > 0 && this.viewport.scrollTop >= max - 2) return 'edge'
    if (direction < 0 && this.viewport.scrollTop <= 0) return 'edge'
    this.viewport.scrollTop += direction * lineHeightOf(this.content)
    this.capture()
    return 'ok'
  }

  snapshot(): ScrollSnapshot {
    const max = this.maxScrollTop
    return {
      offset: this.anchorOffset,
      total: this.index.total,
      ratio: max > 0 ? Math.min(1, this.viewport.scrollTop / max) : 0
    }
  }
}

/** 从计算样式读行高；读不到时退回 1.9 倍字号的估算 */
function lineHeightOf(element: HTMLElement): number {
  const style = getComputedStyle(element)
  const height = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(height) && height > 0) return height
  const fontSize = Number.parseFloat(style.fontSize) || 18
  return fontSize * 1.9
}
