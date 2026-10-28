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

/** Windows 路径上限 32767，但实际可用远小于此；4096 足以覆盖一切正常场景，也能挡住畸形输入 */
const pathSchema = z.string().min(1, '路径不能为空').max(4096, '路径过长')

/** 主键统一是 ULID（26 字符），但这里不锁死格式，免得将来换 ID 方案还要改校验 */
const idSchema = z.string().min(1, '缺少 ID').max(64, 'ID 过长')

export const echoRequestSchema = z.object({
  message: z.string().min(1, '不能为空').max(2000, '最多 2000 字符'),
  delayMs: z.number().int().min(0).max(10_000).optional(),
  failMode: z.enum(['none', 'throw']).optional()
})

/**
 * 导入选项（M1-06）。每一项都有默认值，渲染层传 `{}` 即为「按默认方式导入」。
 *
 * `ignorePattern` 限长 500：它会被编译成正则并作用于每个路径，
 * 太长或含灾难性回溯的表达式会让扫描卡死，长度限制是第一道闸。
 */
export const importOptionsSchema = z.object({
  rootId: idSchema.optional(),
  registerAsRoot: z.boolean().optional(),
  scanDepth: z.number().int().min(1).max(32).optional(),
  ignorePattern: z.string().max(500, '忽略规则最多 500 字符').optional(),
  onDuplicate: z.enum(['skip', 'overwrite']).optional()
})

export const ipcSchemas = {
  'system:echo': echoRequestSchema,
  'system:info': z.void(),
  'system:worker-health': z.void(),
  'window:get-state': z.void(),

  // 根目录（M1-01）
  'roots:list': z.void(),
  /** scanNow 对应产品文档 §2.3「添加根目录 → 可选立即扫描导入」，真正扫描由 M1-02 接 */
  'roots:add': z.object({ path: pathSchema, scanNow: z.boolean() }),
  'roots:check': z.void(),
  'roots:relocate': z.object({ rootId: idSchema, newPath: pathSchema }),
  'roots:remove': z.object({ rootId: idSchema }),

  // 导入（M1-06）
  'import:pickFolder': z.void(),
  'import:scan': z.object({ path: pathSchema }),
  'import:commit': z.object({ path: pathSchema, options: importOptionsSchema }),
  'import:cancel': z.object({ taskId: idSchema }),

  // 书籍列表（M1-08，排序 M1-09，搜索 M1-10）
  'books:list': z.object({
    rootId: idSchema.optional(),
    favoritesOnly: z.boolean().optional(),
    shelfId: idSchema.optional(),
    /** 全文关键字：限长 100（超长输入没有检索意义，只会拖慢 FTS） */
    keyword: z.string().max(100, '搜索词最多 100 字符').optional(),
    /** 字段用 allowlist：ORDER BY 的列名不能来自用户输入 */
    sort: z
      .object({
        field: z.enum(['lastReadAt', 'title', 'author', 'progress', 'createdAt']),
        direction: z.enum(['asc', 'desc'])
      })
      .optional(),
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(2000)
  }),
  'books:count': z.object({
    rootId: idSchema.optional(),
    favoritesOnly: z.boolean().optional()
  }),
  'books:recent': z.object({
    rootId: idSchema.optional(),
    limit: z.number().int().min(1).max(20).optional()
  }),
  'shelves:get': z.object({ shelfId: idSchema }),
  'shelves:list': z.void(),

  // 阅读器（M2-01）
  'reader:content': z.object({
    bookId: idSchema,
    chapterIdx: z.number().int().min(0).max(1_000_000)
  })
} satisfies Partial<{ [K in keyof IpcMap]: z.ZodType<IpcMap[K]['input']> }>

/** 有 schema 的通道 = 允许注册 handler 的通道 */
export type ValidatedChannel = keyof typeof ipcSchemas

export function schemaOf<K extends ValidatedChannel>(channel: K): (typeof ipcSchemas)[K] {
  return ipcSchemas[channel]
}
