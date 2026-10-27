/**
 * 封面占位取色（M1-08）。
 *
 * 产品文档 §2.4：无封面时用「书名 + 哈希取色」生成占位封面。真封面图要等
 * M2-03 的自定义协议（cover_path 只存了缓存文件名，file:// 直指会被 CSP 拦），
 * 在那之前所有封面都走这里——所以取色质量就是「封面质量」。
 *
 * 规则：seed（书籍 id，ULID，唯一且稳定）散列成色相，暗色底 + 同色系渐变，
 * 与整体深色主题协调。同一本书永远同色，不同书撞色概率低（18 个色相桶 × 明度两档）。
 */

/** 与主题一致的暗底渐变。色相分布开后就不会出现整屏同色 */
const HUES = [
  [214, 32], // 蓝
  [262, 30], // 紫
  [160, 28], // 青
  [24, 34], // 赭
  [344, 30], // 绯
  [190, 30], // 湖
  [82, 26], // 橄榄
  [292, 28] // 洋红
] as const

export interface CoverColors {
  from: string
  to: string
}

export function coverGradient(seed: string): CoverColors {
  let hash = 5381
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0
  }
  const [hue, sat] = HUES[Math.abs(hash) % HUES.length]!
  const light = 22 + (Math.abs(hash >> 7) % 8) // 底色明度抖动，避免色块感
  const from = `hsl(${hue} ${sat}% ${light + 14}%)`
  const to = `hsl(${hue} ${sat}% ${light - 6}%)`
  return { from, to }
}
