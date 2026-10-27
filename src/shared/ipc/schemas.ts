/**
 * 每个通道的入参 zod schema。主进程在 handler 执行**之前**统一校验。
 *
 * `satisfies Partial<...>` 保证 schema 的产出类型与契约里的 input 完全一致——
 * 契约改字段而 schema 忘改，会在这里编译报错。
 *
 * 已声明但尚未实现 handler 的通道不需要（也没有）schema：它们在 registry 里
 * 直接返回 E_NOT_IMPLEMENTED，压根不会走到校验。等对应里程碑实现 handler 时
 * 再补 schema，`registerHandler` 会强制要求。
 */
import { z } from 'zod'
import type { IpcMap } from './contract'

export const echoRequestSchema = z.object({
  message: z.string().min(1, '不能为空').max(2000, '最多 2000 字符'),
  delayMs: z.number().int().min(0).max(10_000).optional(),
  failMode: z.enum(['none', 'throw']).optional()
})

export const ipcSchemas = {
  'system:echo': echoRequestSchema,
  'system:info': z.void(),
  'window:get-state': z.void()
} satisfies Partial<{ [K in keyof IpcMap]: z.ZodType<IpcMap[K]['input']> }>

/** 有 schema 的通道 = 允许注册 handler 的通道 */
export type ValidatedChannel = keyof typeof ipcSchemas

export function schemaOf<K extends ValidatedChannel>(channel: K): (typeof ipcSchemas)[K] {
  return ipcSchemas[channel]
}
