/**
 * 阅读器状态（M2-04 起，M2-07 接设置持久化）。
 *
 * 两份状态：
 *   - **排版**（字号/行距/字距/段距/页边距/字体/主题）：改一次就立刻作用到 DOM，
 *     同时节流写回 `settings.reader`；
 *   - **阅读模式**：`'auto'` 表示「按书籍格式取默认」（EPUB 滚动 / TXT 分页），
 *     只有用户手动切过才会写成 `'paged' / 'scroll'`——否则「EPUB 默认滚动」
 *     这条产品规则会在第一次保存设置之后永久失效。
 *
 * 为什么本地立刻生效、落库却节流：拖字号滑块会在一秒内产生几十次改动，
 * 每次都走 IPC 写库既浪费又会让 `updated_at` 疯狂抖动；300ms 的空闲窗口
 * 足够把一次「拖动」合并成一次写入。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BookFormat, ReaderSettingsDTO, ReaderTheme } from '@shared/dto'
import { call } from '@/api'

/** 生效中的阅读模式（'auto' 已经被解成具体值） */
export type ReaderMode = 'paged' | 'scroll'
/** 设置里存的模式：auto = 跟随书籍格式 */
export type ReaderModeSetting = ReaderMode | 'auto'

export interface ReaderTypography {
  /** px */
  fontSize: number
  /** 倍数 1.2 – 2.4 */
  lineHeight: number
  /** em */
  letterSpacing: number
  /** 段间距，em */
  paragraphSpacing: number
  /** 左右页边距，px（上下取它的 0.6 倍，见 `verticalMargin`） */
  margin: number
}

export interface ReaderPalette {
  bg: string
  text: string
}

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 32
export const LINE_HEIGHT_MIN = 1.2
export const LINE_HEIGHT_MAX = 2.4
export const MARGIN_MIN = 24
export const MARGIN_MAX = 120

/** 四套固定主题的配色（'system' 由 `palette()` 按系统深浅色决定） */
const THEMES: Record<Exclude<ReaderTheme, 'system'>, ReaderPalette> = {
  day: { bg: '#f7f5ef', text: '#2b2b2b' },
  night: { bg: '#17181b', text: '#b9bcc2' },
  eye: { bg: '#cce8cf', text: '#24312a' },
  paper: { bg: '#f4e8cf', text: '#3a2f22' }
}

export const THEME_OPTIONS: { value: ReaderTheme; label: string; bg: string; text: string }[] = [
  { value: 'day', label: '日间', ...THEMES.day },
  { value: 'night', label: '夜间', ...THEMES.night },
  { value: 'eye', label: '护眼绿', ...THEMES.eye },
  { value: 'paper', label: '纸张黄', ...THEMES.paper },
  { value: 'system', label: '跟随系统', bg: '', text: '' }
]

/**
 * 字体只提供内置的系统字体栈：导入字体需要「文件落盘 + 字体注册 + 存储管理」，
 * 属于 M5 的存储与字体设置，这里先把 `fontFamily` 的取值通道留好。
 */
export const FONT_OPTIONS: { value: string; label: string; stack: string }[] = [
  {
    value: 'system',
    label: '系统默认',
    stack: "'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif"
  },
  { value: 'song', label: '宋体', stack: "'Songti SC', SimSun, 'Noto Serif CJK SC', serif" },
  { value: 'hei', label: '黑体', stack: "'Microsoft YaHei', SimHei, 'Noto Sans CJK SC', sans-serif" },
  { value: 'kai', label: '楷体', stack: "KaiTi, STKaiti, 'Kaiti SC', serif" },
  { value: 'fangsong', label: '仿宋', stack: "FangSong, STFangsong, 'Fangsong SC', serif" }
]

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const round2 = (value: number): number => Math.round(value * 100) / 100

export const useReaderStore = defineStore('reader', () => {
  const typography = ref<ReaderTypography>({
    fontSize: 18,
    lineHeight: 1.9,
    letterSpacing: 0.02,
    paragraphSpacing: 0.7,
    margin: 64
  })
  const theme = ref<ReaderTheme>('day')
  const customBg = ref<string | null>(null)
  const customText = ref<string | null>(null)
  const fontFamily = ref<string>('system')
  const mode = ref<ReaderModeSetting>('auto')
  /** 设置是否已从主进程读回来：没读到之前不要把默认值写回库（会覆盖用户设置） */
  const loaded = ref(false)

  /**
   * 上下页边距。设置里只有一个「页边距」，横向直接用、纵向取 0.6 倍：
   * 上下与左右等宽会让正文高度明显变矮（一屏少两行），而中文正文的视觉
   * 平衡点本来就在 0.6 左右。
   */
  const verticalMargin = (): number => Math.round(typography.value.margin * 0.6)

  const fontStack = (): string =>
    FONT_OPTIONS.find((option) => option.value === fontFamily.value)?.stack ?? FONT_OPTIONS[0]!.stack

  /**
   * 当前配色。`customBg / customText` 只要有一个非空就覆盖主题——
   * 产品文档 §2.6 的「自定义背景色 + 文字色」是叠加在主题之上的微调，
   * 不是第六套主题（所以不新增 `ReaderTheme` 取值）。
   */
  function palette(systemPrefersDark = false): ReaderPalette {
    const base =
      theme.value === 'system' ? (systemPrefersDark ? THEMES.night : THEMES.day) : THEMES[theme.value]
    return {
      bg: customBg.value ?? base.bg,
      text: customText.value ?? base.text
    }
  }

  // ---------------------------------------------------------------- 读设置

  async function load(): Promise<void> {
    try {
      const settings = await call('settings:get')
      apply(settings.reader)
    } catch {
      // 读不到就用默认值继续读：设置坏了不该让人打不开书
    } finally {
      loaded.value = true
    }
  }

  function apply(reader: ReaderSettingsDTO): void {
    typography.value = {
      fontSize: clamp(reader.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX),
      lineHeight: clamp(reader.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX),
      letterSpacing: reader.letterSpacing,
      paragraphSpacing: reader.paragraphSpacing,
      margin: clamp(reader.margin, MARGIN_MIN, MARGIN_MAX)
    }
    theme.value = reader.theme
    customBg.value = reader.customBg
    customText.value = reader.customText
    fontFamily.value = reader.fontFamily
    mode.value = reader.mode
  }

  // ---------------------------------------------------------------- 写设置

  let pending: Partial<ReaderSettingsDTO> = {}
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    if (Object.keys(pending).length === 0) return
    const patch = pending
    pending = {}
    void call('settings:patch', { patch: { reader: patch } }).catch(() => {
      // 保存失败只影响「下次启动的默认值」，当前会话的改动仍然有效；
      // 弹 toast 会打断阅读，这里静默失败，下次改动时自然会重试
    })
  }

  /** 改一个设置项：本地立刻生效，落库合并到 300ms 后的空闲窗口 */
  function patchReader(partial: Partial<ReaderSettingsDTO>, immediate = false): void {
    pending = { ...pending, ...partial }
    if (timer !== null) clearTimeout(timer)
    if (immediate) {
      timer = null
      flush()
      return
    }
    timer = setTimeout(() => {
      timer = null
      flush()
    }, 300)
  }

  // ---------------------------------------------------------------- 具体项

  function setFontSize(px: number): void {
    const value = clamp(Math.round(px), FONT_SIZE_MIN, FONT_SIZE_MAX)
    if (value === typography.value.fontSize) return
    typography.value.fontSize = value
    patchReader({ fontSize: value })
  }

  function stepFontSize(delta: number): void {
    setFontSize(typography.value.fontSize + delta)
  }

  function setLineHeight(value: number): void {
    const next = round2(clamp(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX))
    if (next === typography.value.lineHeight) return
    typography.value.lineHeight = next
    patchReader({ lineHeight: next })
  }

  function setLetterSpacing(value: number): void {
    const next = round2(clamp(value, -0.05, 0.3))
    if (next === typography.value.letterSpacing) return
    typography.value.letterSpacing = next
    patchReader({ letterSpacing: next })
  }

  function setParagraphSpacing(value: number): void {
    const next = round2(clamp(value, 0, 2))
    if (next === typography.value.paragraphSpacing) return
    typography.value.paragraphSpacing = next
    patchReader({ paragraphSpacing: next })
  }

  function setMargin(value: number): void {
    const next = clamp(Math.round(value), MARGIN_MIN, MARGIN_MAX)
    if (next === typography.value.margin) return
    typography.value.margin = next
    patchReader({ margin: next })
  }

  function setTheme(next: ReaderTheme): void {
    if (next === theme.value) return
    theme.value = next
    patchReader({ theme: next })
  }

  /** 自定义色：传 null 表示「清掉自定义，回到主题色」 */
  function setCustomColors(bg: string | null, text: string | null): void {
    customBg.value = bg
    customText.value = text
    // 颜色是「选完就完了」的操作，没有连续拖动的过程，直接落库
    patchReader({ customBg: bg, customText: text }, true)
  }

  function setFontFamily(next: string): void {
    if (next === fontFamily.value) return
    fontFamily.value = next
    patchReader({ fontFamily: next }, true)
  }

  function setMode(next: ReaderMode): void {
    if (next === mode.value) return
    mode.value = next
    patchReader({ mode: next }, true)
  }

  /** 当前该用哪种模式。`format` 为 null（书还没加载）时按分页处理 */
  function modeFor(format: BookFormat | null | undefined): ReaderMode {
    if (mode.value !== 'auto') return mode.value
    return format === 'epub' ? 'scroll' : 'paged'
  }

  function resetTypography(): void {
    typography.value = {
      fontSize: 18,
      lineHeight: 1.9,
      letterSpacing: 0.02,
      paragraphSpacing: 0.7,
      margin: 64
    }
    theme.value = 'day'
    customBg.value = null
    customText.value = null
    fontFamily.value = 'system'
    patchReader(
      {
        fontSize: 18,
        lineHeight: 1.9,
        letterSpacing: 0.02,
        paragraphSpacing: 0.7,
        margin: 64,
        theme: 'day',
        customBg: null,
        customText: null,
        fontFamily: 'system'
      },
      true
    )
  }

  return {
    typography,
    theme,
    customBg,
    customText,
    fontFamily,
    mode,
    loaded,
    load,
    apply,
    palette,
    fontStack,
    verticalMargin,
    setFontSize,
    stepFontSize,
    setLineHeight,
    setLetterSpacing,
    setParagraphSpacing,
    setMargin,
    setTheme,
    setCustomColors,
    setFontFamily,
    setMode,
    modeFor,
    resetTypography
  }
})
