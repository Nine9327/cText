/**
 * 阅读器状态（M2-04 起）。
 *
 * 现在只有排版参数，且**只存内存**——持久化属于 M2-07（落 `settings` 表）。
 * 之所以提前建这个 store 而不是直接写在 ReaderView 里：分页引擎要靠字号变化
 * 触发重排，设置面板（M2-07）与快捷键（M2-10）将来都要改同一份状态，
 * 三处各持一份 ref 必然会漂。
 *
 * 取值范围对齐产品文档 §2.6「字号 12–32、行距 1.2–2.4」。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { BookFormat } from '@shared/dto'

/**
 * 阅读模式。`null` 表示「还没手动选过」——此时按书籍格式取默认：
 * EPUB 默认滚动、TXT 默认分页（产品文档 §2.6）。
 * 一旦用户点了切换，就用他的选择，不再随格式漂。
 */
export type ReaderMode = 'paged' | 'scroll'

export interface ReaderTypography {
  /** px */
  fontSize: number
  /** 倍数（1.2 – 2.6） */
  lineHeight: number
  /** em */
  letterSpacing: number
  /** 段间距，em */
  paragraphGap: number
  /** 左右页边距，px */
  marginX: number
  /** 上下页边距，px */
  marginY: number
}

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 32

const DEFAULTS: ReaderTypography = {
  fontSize: 18,
  lineHeight: 1.9,
  letterSpacing: 0.02,
  paragraphGap: 0.7,
  marginX: 64,
  marginY: 40
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export const useReaderStore = defineStore('reader', () => {
  const typography = ref<ReaderTypography>({ ...DEFAULTS })
  /** 用户显式选过的模式；null = 跟随格式 */
  const mode = ref<ReaderMode | null>(null)

  function setMode(next: ReaderMode): void {
    mode.value = next
  }

  /** 当前该用哪种模式。`format` 为 null（书还没加载）时按分页处理 */
  function modeFor(format: BookFormat | null | undefined): ReaderMode {
    return mode.value ?? (format === 'epub' ? 'scroll' : 'paged')
  }

  /** 字号步进用 1px：两档之间差 18% 的话，调一次就可能整段重排，反而不好微调 */
  function setFontSize(px: number): void {
    typography.value.fontSize = clamp(Math.round(px), FONT_SIZE_MIN, FONT_SIZE_MAX)
  }

  function stepFontSize(delta: number): void {
    setFontSize(typography.value.fontSize + delta)
  }

  function resetTypography(): void {
    typography.value = { ...DEFAULTS }
  }

  return { typography, mode, setMode, modeFor, setFontSize, stepFontSize, resetTypography }
})
