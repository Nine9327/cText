/**
 * 分页引擎（M2-04）。
 *
 * 做法：内容区是一个 **CSS 多列容器**——列宽 = 视口宽、列高 = 视口高、
 * `column-fill: auto`，于是「第 n 页」就是第 n 列，翻页 = 把容器水平平移
 * `n × 步长`。选它而不是手工切段落的原因：断行、断字、图片、
 * 中英混排全部交给排版引擎，我们只负责测量和映射。
 *
 * 三件事不能靠猜，必须实测：
 *   1. **总页数**：不看 `scrollWidth`（多列溢出时各浏览器口径不一致），而是
 *      取**最后一个字符**所在的列号 + 1。最后那个空列（只有段后间距）不该算一页。
 *   2. **页 ↔ 字符偏移**：进度只存「章 + 字符偏移」（产品文档 §2.6），不存页号，
 *      否则换字号后页号全废。字符偏移 = 内容区 `textContent` 里的下标。
 *   3. **重排后位置不跳**：改字号/改窗口时先记住「当前页首字符偏移」，
 *      重排后再用同一个偏移反查页号。
 *
 * 为什么用「列号」判断而不直接比较 x：同一列内每行都从左边重新开始，
 * x 不单调；而「列号 = floor(x / 步长)」在阅读顺序上是单调不减的，
 * 于是可以对偏移做二分查找（3000 字约 12 次测量，忽略不计）。
 */
import { TextIndex } from './text-index'

export interface PageBox {
  /** 单页内容宽（= 列宽） */
  width: number
  /** 单页内容高（= 列高） */
  height: number
  /** 列间距，翻页步长 = 栏数 × (width + gap) */
  gap: number
}

export interface PageSnapshot {
  /** 当前页，0 起 */
  page: number
  /** 本章总页数，最小 1 */
  pages: number
  /** 当前页首字符的章内偏移 */
  offset: number
  /** 本章总字符数 */
  total: number
}

/** 页与页之间的空白。给得比行距宽一点，避免两页文字在视觉上连成一片 */
export const PAGE_GAP = 48

/**
 * 一页放几栏（产品文档 D4：**v1 恒为 1**，双栏留给 v1.1）。
 *
 * 之所以现在就把常数抽出来：分页的全部数学都落在「第 n 页从第 n×步长开始」与
 * 「页号 = 列号 / 栏数」两句上，双栏时只需把它改成 2，页宽、步长、页号映射会
 * 一起变，测量与偏移映射的代码一行都不用动。
 *
 * 成立的前提是**页间距与栏间距相同**（都取 PAGE_GAP）：第 n 页首列下标是
 * n×栏数，列 k 的起点是 k×(栏宽+间距)，两个式子在间距相等时才自洽。
 */
export const COLUMNS_PER_PAGE = 1

/**
 * 页数上限。3000 字/页的极端排版也就几十页；这里挡的是「列宽被算成 0」
 * 之类的退化——那会让页数变成天文数字，二分查找和翻页都会失控。
 */
const MAX_PAGES = 5000

export class Paginator {
  private readonly viewport: HTMLElement
  private readonly content: HTMLElement
  private readonly index = new TextIndex()
  private box: PageBox = { width: 0, height: 0, gap: PAGE_GAP }
  private pageCount = 1
  private currentPage = 0
  /** 当前页首字符偏移。**每次翻页时更新**，重排时用它复原位置 */
  private anchor = 0

  constructor(viewport: HTMLElement, content: HTMLElement) {
    this.viewport = viewport
    this.content = content
  }

  get pages(): number {
    return this.pageCount
  }

  get page(): number {
    return this.currentPage
  }

  get totalChars(): number {
    return this.index.total
  }

  get geometry(): PageBox {
    return this.box
  }

  /** 字符索引（划线要把选区端点换算成偏移，读它） */
  get textIndex(): TextIndex {
    return this.index
  }

  /** 翻一页的位移 = 一页的栏数 × (栏宽 + 间距) */
  get step(): number {
    return COLUMNS_PER_PAGE * (this.box.width + this.box.gap)
  }

  /**
   * 重建字符索引。**DOM 变了（换章、正文替换）才需要调用**；
   * 只改字号/窗口大小时 DOM 不变，索引照旧可用。
   */
  syncDom(): void {
    this.index.rebuild(this.content)
  }

  /**
   * 重新测量并分页。
   *
   * @param anchor 指定「以哪个字符偏移为当前页首」。换章/恢复进度时传；
   *               重排（改字号、缩放窗口）时**不要传**，让它沿用上次翻页时记下的位置。
   */
  paginate(anchor?: number): PageSnapshot {
    if (anchor !== undefined) this.anchor = this.index.clamp(anchor)

    this.measureBox()
    // 列宽/列高刚写进样式，这里读一次几何把布局强制刷新到最新，
    // 否则下面量到的是上一版的列
    void this.content.offsetHeight

    const lastCharPage = this.index.total === 0 ? 0 : this.columnOf(this.index.total - 1)
    this.pageCount = Math.max(1, Math.min(lastCharPage + 1, MAX_PAGES))
    this.currentPage = this.clampPage(this.pageOf(this.anchor))
    this.applyOffset()
    return this.snapshot()
  }

  goToPage(page: number): PageSnapshot {
    this.currentPage = this.clampPage(page)
    // 翻页后「当前位置」= 新页首字符，重排就靠它复原
    this.anchor = this.offsetAtPage(this.currentPage)
    this.applyOffset()
    return this.snapshot()
  }

  /** 章内偏移 → 页号（落在末尾之外时夹到末页） */
  pageOfOffset(offset: number): number {
    return this.clampPage(this.pageOf(offset))
  }

  /**
   * 页号 → 该页首字符的章内偏移。
   *
   * 二分查找「第一个列号 ≥ page 的字符」——列号随偏移单调不减，所以成立。
   * 零宽字符（换行、空格）不影响结论：它们的列号与相邻可见字符相同。
   */
  offsetAtPage(page: number): number {
    if (this.index.total === 0) return 0
    const target = this.clampPage(page)
    if (target === 0) return 0
    return this.index.firstWhere((rect) => this.columnOfRect(rect) >= target)
  }

  snapshot(): PageSnapshot {
    return {
      page: this.currentPage,
      pages: this.pageCount,
      offset: this.anchor,
      total: this.index.total
    }
  }

  destroy(): void {
    this.content.style.transform = ''
  }

  // ---------------------------------------------------------------- 内部

  private measureBox(): void {
    // 页宽从容器实测：没有任何「一页多少字」的硬编码，改窗口/双栏都不需要改这里
    const available = Math.max(1, Math.floor(this.viewport.clientWidth))
    const width = Math.max(1, Math.floor((available - (COLUMNS_PER_PAGE - 1) * PAGE_GAP) / COLUMNS_PER_PAGE))
    const height = Math.max(1, Math.floor(this.viewport.clientHeight))
    this.box = { width, height, gap: PAGE_GAP }

    const style = this.content.style
    style.columnWidth = `${width}px`
    style.columnGap = `${PAGE_GAP}px`
    // 页面尺寸也写进变量：图片的 max-height 要靠它夹住，
    // 否则一张竖图会溢出列高、把后面的页整体挤错
    style.setProperty('--ct-page-width', `${width}px`)
    style.setProperty('--ct-page-height', `${height}px`)
  }

  private applyOffset(): void {
    // 用 transform 而不是 scrollLeft：overflow:hidden 的容器仍然可以被
    // 程序化滚动，但那样「当前页」会依赖滚动状态，读 rect 时还要把 scrollLeft
    // 加回来；transform 只影响绘制，几何关系始终是「第 n 页从 n×步长开始」
    this.content.style.transform = `translateX(${-this.currentPage * this.step}px)`
  }

  private clampPage(page: number): number {
    if (!Number.isFinite(page)) return 0
    return Math.min(Math.max(0, Math.trunc(page)), this.pageCount - 1)
  }

  private pageOf(offset: number): number {
    return Math.max(0, this.columnOf(this.index.clamp(offset)))
  }

  /** 字符偏移 → 页号（不做夹取，可能超出当前页数：用于求总页数） */
  private columnOf(offset: number): number {
    const rect = this.index.rectAt(offset)
    return rect ? this.columnOfRect(rect) : 0
  }

  /** 字符矩形 → 页号。相对内容区左边界算，平移/滚动都不影响差值 */
  private columnOfRect(rect: DOMRect): number {
    const origin = this.content.getBoundingClientRect().left
    const step = this.box.width + this.box.gap
    // +0.5 是给列边界的舍入误差留的余量：列首字符的 x 有时会算出
    // k×间距 - 0.4，直接 floor 会掉到上一栏。先算栏号，再除以栏数得到页号
    const column = Math.floor((rect.left - origin + 0.5) / step)
    return Math.max(0, Math.floor(column / COLUMNS_PER_PAGE))
  }
}
