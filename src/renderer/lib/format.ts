/**
 * 渲染层格式化函数。
 *
 * 体积格式化本来在 `BookDetailView` 和 `ImportDialog` 里各写了一份，M4-10 的缓存卡片
 * 要用第三份——顺手收到这里。旧的重复实现先不动（改动面越小越好），新代码从这里取。
 */

/** 1024 进制的人类可读体积 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}
