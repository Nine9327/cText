/**
 * ULID 生成器（零依赖，替代自增主键）。
 *
 * 选 ULID 而不是 UUIDv4 的理由只有一条：**字典序 = 时间序**。
 * `books.id` / `library_roots.id` 都是 TEXT 主键，按 id 排序天然等价于按创建时间排序，
 * M1-09 的「按导入时间」排序因此不需要额外索引。
 *
 * 结构（26 个 Crockford Base32 字符 = 130 位，其中前 2 位恒 0）：
 *   - 前 10 字符：48 位 Unix 毫秒时间戳（与 Date.now() 同精度直到 10889 年）
 *   - 后 16 字符：80 位加密随机数
 *
 * 编码表去掉了 I / L / O / U —— 避免与 1 / 0 手抄混淆，也避免拼出脏词。
 */
import { randomBytes } from 'node:crypto'

/** Crockford Base32：去掉了 I L O U */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 生成一个 26 字符 ULID。
 *
 * @param now 毫秒时间戳，默认当前时间。测试里传固定值可以断言前缀。
 */
export function ulid(now: number = Date.now()): string {
  // 128 位整数 = 48 位时间戳 << 80 | 80 位随机
  let value = (BigInt(Math.floor(now)) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`)

  let out = ''
  for (let i = 0; i < 26; i++) {
    out = ENCODING[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}
