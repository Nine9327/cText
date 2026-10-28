/**
 * 内部拖拽的约定（M3-02）。
 *
 * 两条路径并存是刻意的：
 *
 *   - **MIME 类型**（`text/ctext-book` / `text/ctext-shelf`）只用来回答
 *     「这一坨数据能不能落在这里」。`dragover` 阶段浏览器只允许读
 *     `dataTransfer.types`，读不到内容，所以判定落点只能靠类型。
 *   - **被拖对象的 id 放在模块变量里**，不从 `dataTransfer.getData()` 取。
 *     理由有两条：跨路由的拖拽在部分平台上自定义类型会被剥离，读到空串；
 *     而且验收里的合成 `DragEvent` 也拿不到（`new DataTransfer()` 造的数据
 *     在 `drop` 阶段未必还在）。id 只是一次同窗口交互的临时状态，
 *     没必要绕一圈二进制通道。
 *
 * 不用 `text/plain`：那个类型同时被「从系统拖文件进来」占用，
 * 混用会让书架条目在拖入一个 txt 文件时也亮起来。
 */
export const BOOK_MIME = 'text/ctext-book'
export const SHELF_MIME = 'text/ctext-shelf'

export interface DragSource {
  kind: 'book' | 'shelf'
  id: string
}

let source: DragSource | null = null

export function setDragSource(next: DragSource): void {
  source = next
}

/** 取完不清空：一次拖拽可能先后经过多个落点（dragleave 后再进入） */
export function getDragSource(kind: DragSource['kind']): string | null {
  return source && source.kind === kind ? source.id : null
}

export function clearDragSource(): void {
  source = null
}
