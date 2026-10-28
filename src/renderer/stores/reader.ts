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

  return { typography, setFontSize, stepFontSize, resetTypography }
})
