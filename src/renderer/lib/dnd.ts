/**
 * 拖放取路径（M1-07）。
 *
 * 三件麻烦事都在这里解决，组件只拿结果：
 *
 * 1. **`File.path` 已废弃**。Electron 29 起官方口子是 `webUtils.getPathForFile`，
 *    而它只能在 preload 里调，渲染层拿不到。所以路径一律经 `window.api.getFilePath`。
 * 2. **目录与文件分不清**。`DataTransfer.files` 里目录也是一个 File（type 为空）。
 *    可靠的判据是 `webkitGetAsEntry().isDirectory`；拿不到 entry 时（合成事件、
 *    跨源限制）退回「没有扩展名就当目录」，这个启发式对书名目录足够好。
 * 3. **dragleave 会假触发**。鼠标从父元素移到子元素时先 leave 后 enter，
 *    直接隐藏覆盖层会疯狂闪烁。用一个进入计数抵消，归零才真正离开。
 */
export interface DropTarget {
  /** 要导入的目录路径 */
  path: string
  /** 需要向用户说明的降级（例如拖的是文件、只能定位到所在文件夹） */
  hint: string | null
}

const EXT_RE = /\.[A-Za-z0-9]{1,8}$/

function pathOf(file: File): string {
  const api = window.api
  if (!api || typeof api.getFilePath !== 'function') return ''
  try {
    return api.getFilePath(file)
  } catch {
    // 合成事件里的 File 没有对应的磁盘文件，webUtils 会抛
    return ''
  }
}

/** 拖进来的东西里有没有文件。纯文本拖选不该触发全窗高亮 */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  const types = dt.types
  if (!types) return false
  return Array.prototype.includes.call(types, 'Files')
}

function isDirectory(item: DataTransferItem | undefined, file: File): boolean {
  try {
    const entry = item?.webkitGetAsEntry?.()
    if (entry) return entry.isDirectory
  } catch {
    // 某些拖拽源拿不到 entry，退回按扩展名猜
  }
  return !EXT_RE.test(file.name)
}

export function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : path
}

/**
 * 从 drop 事件里挑出要导入的目录。
 *
 * 优先级：拖进来的目录 > 拖进来的文件所在目录。后者是降级——M1-06 的导入入口
 * 只接受目录，单文件导入要等后续版本，所以必须通过 `hint` 如实告诉用户，
 * 不能假装「只导入了你拖的那几个文件」。
 */
export function targetFromDataTransfer(dt: DataTransfer | null | undefined): DropTarget | null {
  if (!dt) return null

  const files = Array.from(dt.files ?? [])
  const items = Array.from(dt.items ?? [])

  let fallbackFile: string | null = null
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    const path = pathOf(file)
    if (!path) continue
    if (isDirectory(items[i], file)) return { path, hint: null }
    if (!fallbackFile) fallbackFile = path
  }

  if (fallbackFile) {
    return {
      path: parentOf(fallbackFile),
      hint: '拖入的是文件，已定位到所在文件夹。单个文件导入将在后续版本提供，本次会扫描整个文件夹。'
    }
  }
  return null
}
