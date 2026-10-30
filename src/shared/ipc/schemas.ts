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
  'system:openPath': z.object({ target: z.enum(['logs', 'data', 'db', 'covers', 'chapters']) }),
  'system:storageStats': z.void(),
  'system:clearCovers': z.void(),
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
    /** 标签筛选用 OR：上限 32 个（再多就不是筛选而是组合搜索了） */
    categoryIds: z.array(idSchema).max(32).optional(),
    /** 全文关键字：限长 100（超长输入没有检索意义，只会拖慢 FTS） */
    keyword: z.string().max(100, '搜索词最多 100 字符').optional(),
    /** 字段用 allowlist：ORDER BY 的列名不能来自用户输入 */
    sort: z
      .object({
        field: z.enum(['lastReadAt', 'title', 'author', 'progress', 'createdAt', 'shelfOrder']),
        direction: z.enum(['asc', 'desc'])
      })
      .optional(),
    offset: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(2000)
  }),
  'books:count': z.object({
    rootId: idSchema.optional(),
    favoritesOnly: z.boolean().optional(),
    categoryIds: z.array(idSchema).max(32).optional()
  }),
  'books:relocateFile': z.object({ bookId: idSchema, searchDir: pathSchema }),
  'books:recent': z.object({
    rootId: idSchema.optional(),
    limit: z.number().int().min(1).max(20).optional()
  }),
  'library:get': z.object({ id: idSchema }),
  /** 收藏开关（M3-01）：传目标值而不是「切换」，重试幂等 */
  'library:toggleFavorite': z.object({ id: idSchema, value: z.boolean() }),
  // 批量操作（M3-05）。上限 500 与 M3-02 的书架批量同口径
  'library:setFavoriteMany': z.object({ bookIds: z.array(idSchema).min(1).max(500), value: z.boolean() }),
  'library:addCategories': z.object({
    bookIds: z.array(idSchema).min(1).max(500),
    categoryIds: z.array(idSchema).min(1).max(32)
  }),
  'library:removeCategories': z.object({
    bookIds: z.array(idSchema).min(1).max(500),
    categoryIds: z.array(idSchema).min(1).max(32)
  }),
  'library:removeMany': z.object({ bookIds: z.array(idSchema).min(1).max(500) }),
  'library:restoreMany': z.object({ bookIds: z.array(idSchema).min(1).max(500) }),
  /** 单本移除：`deleteFile` 由界面恒传 false，schema 仍允许 true 以免将来加功能时改契约 */
  'library:remove': z.object({ id: idSchema, deleteFile: z.boolean() }),

  'library:rematch': z.object({ id: idSchema }),

  /** 元信息编辑（M3-04）。长度上限按「能显示得下」定，不是按数据库能力 */
  'library:update': z.object({
    id: idSchema,
    patch: z
      .object({
        title: z.string().trim().min(1, '书名不能为空').max(200, '书名最多 200 字').optional(),
        author: z.string().max(100, '作者最多 100 字').nullable().optional(),
        series: z.string().max(100, '系列最多 100 字').nullable().optional(),
        intro: z.string().max(5000, '简介最多 5000 字').nullable().optional(),
        publisher: z.string().max(100).nullable().optional(),
        pubDate: z.string().max(40).nullable().optional(),
        language: z.string().max(40).nullable().optional()
      })
      .strict()
  }),
  /** 整体替换一本书的分类（M3-03）：传完整列表，空数组 = 清空标签 */
  'library:setCategories': z.object({ id: idSchema, categoryIds: z.array(idSchema).max(32) }),

  'shelves:get': z.object({ shelfId: idSchema }),
  'shelves:list': z.void(),
  /** 书架名去掉首尾空白后不能为空：叫「  」的书架在侧栏里是一个看不见的空行 */
  'shelves:create': z.object({ name: z.string().trim().min(1, '书架名不能为空').max(40, '书架名最多 40 字') }),
  'shelves:rename': z.object({
    shelfId: idSchema,
    name: z.string().trim().min(1, '书架名不能为空').max(40, '书架名最多 40 字')
  }),
  'shelves:remove': z.object({ shelfId: idSchema }),
  'shelves:addBooks': z.object({
    shelfId: idSchema,
    // 上限 500：与 M3-05 的批量操作同一个口径，再大就该走后台任务
    bookIds: z.array(idSchema).min(1).max(500)
  }),
  'shelves:removeBooks': z.object({ shelfId: idSchema, bookIds: z.array(idSchema).min(1).max(500) }),
  'shelves:moveBook': z.object({
    shelfId: idSchema,
    bookId: idSchema,
    toIndex: z.number().int().min(0).max(100_000)
  }),
  'shelves:reorder': z.object({ shelfIds: z.array(idSchema).max(500) }),

  // 分类（M3-03）。颜色与阅读主题同一口径：#rrggbb 或 null（＝用默认色）
  'categories:list': z.void(),
  'categories:create': z.object({
    name: z.string().trim().min(1, '分类名不能为空').max(20, '分类名最多 20 字'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, '颜色要写成 #rrggbb')
      .nullable()
  }),
  'categories:update': z.object({
    id: idSchema,
    name: z.string().trim().min(1, '分类名不能为空').max(20, '分类名最多 20 字').optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, '颜色要写成 #rrggbb')
      .nullable()
      .optional(),
    sort: z.number().int().min(0).max(10_000).optional()
  }),
  'categories:remove': z.object({ id: idSchema }),

  // 阅读器（M2-01 / 目录 M2-06）
  'reader:content': z.object({
    bookId: idSchema,
    chapterIdx: z.number().int().min(0).max(1_000_000)
  }),
  'reader:chapters': z.object({ bookId: idSchema }),
  'reader:progress': z.object({ bookId: idSchema }),
  'bookmarks:list': z.object({ bookId: idSchema }),
  'bookmarks:add': z.object({
    bookId: idSchema,
    chapterIdx: z.number().int().min(0).max(1_000_000),
    offset: z.number().int().min(0).max(100_000_000),
    endOffset: z.number().int().min(0).max(100_000_000).nullable(),
    kind: z.enum(['bookmark', 'highlight']),
    // 划线最长 5000 字：再长就不是「划线」而是「整章摘录」，超出多半是选区出错了
    text: z.string().max(5000).nullable(),
    note: z.string().max(5000).nullable().optional()
  }),
  'bookmarks:updateNote': z.object({ id: idSchema, note: z.string().max(5000).nullable() }),
  'bookmarks:remove': z.object({ id: idSchema }),
  'bookmarks:export': z.object({ bookId: idSchema, path: pathSchema.nullable() }),

  'reader:saveProgress': z.object({
    bookId: idSchema,
    chapterIdx: z.number().int().min(0).max(1_000_000),
    offset: z.number().int().min(0).max(100_000_000),
    percent: z.number().min(0).max(1)
  }),

  // 书源（M4-07）
  /**
   * 三种输入用 `strict()` + 互斥校验：同时传两种就不知道以哪个为准，
   * 静默取其一会让「我明明粘贴了却导入了文件」这种问题极难查。
   * 文本上限 6MB（比 5MB 略宽，留给转义后的膨胀），真正的体积限制在主进程按字节判。
   */
  'source:import': z
    .union([
      z.object({ json: z.string().max(6 * 1024 * 1024, '内容过大') }).strict(),
      z.object({ filePath: pathSchema }).strict(),
      z.object({ url: z.string().min(8).max(2048) }).strict()
    ])
    .refine(
      (value) => {
        const keys = ['json', 'filePath', 'url'] as const
        return keys.filter((key) => key in value).length === 1
      },
      { message: '必须且只能提供 json / filePath / url 之一' }
    ),
  'source:list': z.void(),
  'source:toggle': z.object({ id: idSchema, enabled: z.boolean() }),
  'source:remove': z.object({ id: idSchema }),
  /**
   * 排序一次性提交全量顺序。上限 1000 条足够（真实书源集合很少超过 300），
   * 超过这个数量更可能是前端把别的 id 列表传错了。
   */
  'source:reorder': z.object({ ids: z.array(idSchema).max(1000, '一次最多重排 1000 条') }),
  'source:export': z.object({ ids: z.array(idSchema).max(1000).optional(), path: pathSchema.nullable() }),
  'source:pickFile': z.void(),
  /**
   * 搜索：关键词上限 200 字——再长也不是书名，更像是把一段正文粘进来了。
   * `opts` 允许缺省（界面经常只传关键词），默认值由 zod 补空对象。
   */
  'source:search': z.object({
    keyword: z.string().trim().min(1, '请输入要搜索的书名或作者').max(200, '关键词太长'),
    opts: z
      .object({
        sourceIds: z.array(idSchema).max(200).optional(),
        page: z.number().int().min(1).max(1000).optional(),
        timeoutMs: z.number().int().min(500).max(30_000).optional(),
        mergeSame: z.boolean().optional()
      })
      .default({})
  }),

  /**
   * 加入书架（M4-09）。`bookUrl` 只收 http(s) 的绝对地址——它来自搜索结果，
   * 由主进程补全过；相对地址到了这一层说明调用方传错了东西。
   */
  'source:addBook': z.object({
    sourceId: idSchema,
    bookUrl: z
      .string()
      .trim()
      .min(8)
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), { message: '详情页地址必须是 http(s) 绝对地址' }),
    title: z.string().trim().max(200).optional()
  }),
  'source:refreshToc': z.object({ bookId: idSchema }),
  'source:cacheStats': z.void(),
  /** `bookId` 缺省 = 清理全部；给了就只清那一本 */
  'source:clearCache': z.object({ bookId: idSchema.optional() }),
  'source:openCacheDir': z.void(),
  /**
   * 规则调试（M4-11）。地址只做长度与非空校验：用户可能填目录页、甚至填一个
   * 故意写坏的地址来验证「规则不匹配时长什么样」，主进程的 URL 补全会给最终结论。
   */
  'source:debug': z.object({
    sourceId: idSchema,
    url: z.string().trim().max(2048).optional(),
    keyword: z.string().trim().max(200).optional(),
    chapterUrl: z.string().trim().max(2048).optional(),
    phases: z
      .array(z.enum(['search', 'info', 'toc', 'content']))
      .min(1)
      .max(4)
      .optional()
  }),

  'source:resetBreaker': z.object({ sourceId: idSchema }),

  // 设置（M2-07）。分区用 `.strict()`：键名写错要当场报错，
  // 而不是「保存成功但什么都没变」——后者在设置页上极难查。
  'settings:get': z.void(),
  'settings:reset': z.void(),
  'settings:patch': z.object({
    patch: z
      .object({
        general: z
          .object({
            autoLaunch: z.boolean().optional(),
            minimizeToTray: z.boolean().optional(),
            closeAction: z.enum(['tray', 'quit']).optional(),
            language: z.literal('zh-CN').optional()
          })
          .strict()
          .optional(),
        reader: z
          .object({
            fontSize: z.number().min(12).max(32).optional(),
            lineHeight: z.number().min(1.2).max(2.4).optional(),
            letterSpacing: z.number().min(-0.05).max(0.3).optional(),
            paragraphSpacing: z.number().min(0).max(2).optional(),
            margin: z.number().min(16).max(200).optional(),
            fontFamily: z.string().min(1).max(64).optional(),
            theme: z.enum(['day', 'night', 'eye', 'paper', 'system']).optional(),
            customBg: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/, '颜色要写成 #rrggbb')
              .nullable()
              .optional(),
            customText: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/, '颜色要写成 #rrggbb')
              .nullable()
              .optional(),
            mode: z.enum(['paged', 'scroll', 'auto']).optional(),
            rememberProgress: z.boolean().optional()
          })
          .strict()
          .optional(),
        storage: z.object({ coverCacheLimitMb: z.number().int().min(0).max(8192) }).strict().optional(),
        sources: z
          .object({
            complianceAccepted: z.boolean().optional(),
            cacheTtlDays: z.number().int().min(1).max(90).optional()
          })
          .strict()
          .optional(),
        shortcuts: z.record(z.string().max(40), z.string().max(40)).optional()
      })
      .strict()
  })
} satisfies Partial<{ [K in keyof IpcMap]: z.ZodType<IpcMap[K]['input']> }>

/** 有 schema 的通道 = 允许注册 handler 的通道 */
export type ValidatedChannel = keyof typeof ipcSchemas

export function schemaOf<K extends ValidatedChannel>(channel: K): (typeof ipcSchemas)[K] {
  return ipcSchemas[channel]
}
