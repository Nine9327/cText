/**
 * 阅读器键位表（M2-10）。
 *
 * 三件事：
 *   1. **规范化**：用户/配置文件里可能写 `ctrl+t`、`Ctrl+T`、`CommandOrControl+T`，
 *      一律折成 `Ctrl+T`。不做规范化，同一个键位会被当成三个不同的组合。
 *   2. **主键位 + 内置备选**：`settings.shortcuts` 每个动作只存一个主键位（可改），
 *      PgDn / 空格这类阅读器惯例键作为内置备选**不参与改键**——它们不是「用户的偏好」，
 *      而是「键盘上本来就有两个方向键」。
 *   3. **冲突检测**：两个动作抢同一个组合时，按声明顺序保留先出现的那个，后面的作废并
 *      报出来。宁可某个快捷键暂时失效，也不要「按一下触发两件事」。
 */

export type ShortcutAction =
  | 'reader.next'
  | 'reader.prev'
  | 'reader.lineNext'
  | 'reader.linePrev'
  | 'reader.toc'
  | 'reader.notes'
  | 'reader.settings'
  | 'reader.bookmark'
  | 'reader.fontUp'
  | 'reader.fontDown'
  | 'reader.fullscreen'
  | 'reader.back'

export interface ShortcutMeta {
  action: ShortcutAction
  label: string
  /** 默认主键位（可改） */
  primary: string
  /** 内置备选（不可改）：键盘上本来就有的同类键 */
  alternates?: string[]
}

/** 顺序即冲突时的优先级 */
export const SHORTCUTS: ShortcutMeta[] = [
  { action: 'reader.next', label: '下一页 / 下滚一屏', primary: 'ArrowRight', alternates: ['PageDown', 'Space'] },
  { action: 'reader.prev', label: '上一页 / 上滚一屏', primary: 'ArrowLeft', alternates: ['PageUp', 'Shift+Space'] },
  { action: 'reader.lineNext', label: '下滚一行', primary: 'ArrowDown' },
  { action: 'reader.linePrev', label: '上滚一行', primary: 'ArrowUp' },
  { action: 'reader.toc', label: '目录', primary: 'Ctrl+T' },
  { action: 'reader.notes', label: '书签与笔记', primary: 'Ctrl+B' },
  { action: 'reader.settings', label: '排版与主题', primary: 'Ctrl+,' },
  { action: 'reader.bookmark', label: '当前位置加书签', primary: 'Ctrl+D' },
  { action: 'reader.fontUp', label: '增大字号', primary: 'Ctrl+=' , alternates: ['Ctrl++', 'Ctrl+Shift+='] },
  { action: 'reader.fontDown', label: '减小字号', primary: 'Ctrl+-' },
  { action: 'reader.fullscreen', label: '全屏', primary: 'F11' },
  { action: 'reader.back', label: '返回 / 关闭浮层', primary: 'Escape' }
]

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = Object.fromEntries(
  SHORTCUTS.map((item) => [item.action, item.primary])
) as Record<ShortcutAction, string>

const LABELS: Record<string, string> = {
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Space: '空格',
  Escape: 'Esc',
  Enter: 'Enter'
}

/** 单个按键名归一：`' '` → `Space`，字母统一大写 */
function normalizeKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** 事件 → `Ctrl+Shift+K` 这种规范串 */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  // Meta 一律折算成 Ctrl：Windows 上不存在 Meta 组合，这样也不必分平台维护两套
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  parts.push(normalizeKey(event.key))
  return parts.join('+')
}

/**
 * 配置里的组合 → 规范串。`ctrl+t` / `Ctrl + T` / `cmdorctrl+t` 都折成 `Ctrl+T`。
 * 认不出的写法原样返回（当成一个奇怪的按键名，至少不会静默变成空串）。
 */
export function normalizeCombo(raw: string): string {
  const text = raw.trim()
  if (text.length === 0) return ''
  const tokens = text.split('+').map((part) => part.trim()).filter(Boolean)
  if (tokens.length === 0) return ''

  const modifiers: string[] = []
  let key = ''
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmdorctrl' || lower === 'commandorcontrol' || lower === 'meta') {
      if (!modifiers.includes('Ctrl')) modifiers.push('Ctrl')
    } else if (lower === 'shift') {
      if (!modifiers.includes('Shift')) modifiers.push('Shift')
    } else if (lower === 'alt' || lower === 'option') {
      if (!modifiers.includes('Alt')) modifiers.push('Alt')
    } else {
      key = normalizeKey(token)
    }
  }
  if (!key) return ''
  // 修饰键顺序固定，否则 Ctrl+Shift+T 与 Shift+Ctrl+T 会被当成两个键
  return [...modifiers, key].join('+')
}

/** 给界面展示用：`Ctrl+T` → `Ctrl + T`，方向键换成箭头符号 */
export function displayCombo(combo: string): string {
  if (!combo) return '未设置'
  return combo
    .split('+')
    .map((part) => LABELS[part] ?? part)
    .join(' + ')
}

export interface ResolvedShortcuts {
  /** 生效的主键位（冲突时后者被剔除） */
  bindings: Partial<Record<ShortcutAction, string>>
  /** 冲突明细：组合 → 抢它的动作 */
  conflicts: { combo: string; actions: ShortcutAction[] }[]
}

/**
 * 合并「用户配置 + 默认值」并解冲突。
 *
 * 用户配置里没有的动作取默认值；有但写坏了（空串 / 解析不出来）也退回默认值——
 * 一个动作不该因为配置里手改坏了就彻底没有快捷键。
 */
export function resolveShortcuts(saved: Record<string, string> | undefined): ResolvedShortcuts {
  const bindings: Partial<Record<ShortcutAction, string>> = {}
  const used = new Map<string, ShortcutAction[]>()
  const conflicts: { combo: string; actions: ShortcutAction[] }[] = []

  for (const meta of SHORTCUTS) {
    const raw = saved?.[meta.action]
    const combo = raw ? normalizeCombo(raw) : ''
    const primary = combo || meta.primary

    if (used.has(primary)) {
      used.get(primary)!.push(meta.action)
      conflicts.push({ combo: primary, actions: used.get(primary)! })
      // 后出现的动作让位：不绑主键位，但仍保留内置备选（若有）
      continue
    }
    used.set(primary, [meta.action])
    bindings[meta.action] = primary
  }

  return { bindings, conflicts }
}

/** 事件是否命中某个动作（主键位 + 内置备选） */
export function matchesAction(
  event: KeyboardEvent,
  action: ShortcutAction,
  resolved: ResolvedShortcuts
): boolean {
  const combo = comboFromEvent(event)
  if (resolved.bindings[action] === combo) return true
  const meta = SHORTCUTS.find((item) => item.action === action)
  return meta?.alternates?.some((alt) => normalizeCombo(alt) === combo) ?? false
}
