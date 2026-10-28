/**
 * 设置读写（M2-07）。
 *
 * 存储形态：`settings(key, value_json, updated_at)` —— **一个分区一行**，
 * key 取 `general / reader / storage / sources / shortcuts`，value 是该分区的整个对象。
 *
 * 为什么不按「叶子字段一行」存：`settings:patch` 的语义是「改我给的字段，其余不动」，
 * 分区粒度把这件事变成一次 JSON 浅合并 + 一次 UPSERT，不需要为每个字段写 schema 迁移；
 * 而按字段存会让「加一个设置项」变成「加一行默认值 + 一条读取逻辑」。
 *
 * 默认值的唯一来源是 `DEFAULT_SETTINGS`：**读取时永远先铺默认值再覆盖**，
 * 所以旧版本写进去的行缺字段不会让界面拿到 undefined（升级不需要写迁移脚本）。
 */
import type { SettingsDTO } from '@shared/dto'
import { getDb, type Db } from '../connection'

export type SettingsSection = 'general' | 'reader' | 'storage' | 'sources'

/** 分区列表。`shortcuts` 单独处理：它的值本身就是一张表 */
const SECTIONS: SettingsSection[] = ['general', 'reader', 'storage', 'sources']

export const DEFAULT_SETTINGS: SettingsDTO = {
  general: {
    autoLaunch: false,
    minimizeToTray: false,
    closeAction: 'quit',
    language: 'zh-CN'
  },
  reader: {
    fontSize: 18,
    lineHeight: 1.9,
    letterSpacing: 0.02,
    paragraphSpacing: 0.7,
    margin: 64,
    fontFamily: 'system',
    theme: 'day',
    customBg: null,
    customText: null,
    // 'auto' = 按书籍格式取默认（EPUB 滚动 / TXT 分页），产品文档 §2.6
    mode: 'auto',
    rememberProgress: true
  },
  storage: { coverCacheLimitMb: 512 },
  sources: { complianceAccepted: false, cacheTtlDays: 7 },
  shortcuts: {}
}

export function loadSettings(db: Db = getDb()): SettingsDTO {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string
    value_json: string
  }[]

  // 先深拷贝默认值：直接返回 DEFAULT_SETTINGS 的引用会让调用方改到「默认值」本身，
  // 之后再读就永远是上次改过的内容（这类 bug 只有在连续两次读之间才看得出来）
  const merged = structuredClone(DEFAULT_SETTINGS)

  for (const row of rows) {
    const parsed = safeParse(row.value_json)
    if (!parsed || typeof parsed !== 'object') continue
    if (row.key === 'shortcuts') {
      merged.shortcuts = { ...merged.shortcuts, ...(parsed as Record<string, string>) }
      continue
    }
    if (!SECTIONS.includes(row.key as SettingsSection)) continue
    const section = row.key as SettingsSection
    // 浅合并：分区内字段的默认值仍然生效，行里多出来的未知键原样保留（向后兼容）
    merged[section] = { ...merged[section], ...(parsed as object) } as never
  }

  return merged
}

/**
 * 局部更新。只写 patch 里出现的分区，其余分区的 `updated_at` 保持不动
 * （将来做「设置同步」时，这个时间戳是判断「哪些分区真的变了」的唯一依据）。
 */
export function patchSettings(
  db: Db,
  patch: Record<string, unknown>,
  now: number = Date.now()
): SettingsDTO {
  const current = loadSettings(db)
  const next = structuredClone(current)

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue
    if (key === 'shortcuts') {
      next.shortcuts = { ...next.shortcuts, ...(value as Record<string, string>) }
      continue
    }
    if (!SECTIONS.includes(key as SettingsSection)) continue
    const section = key as SettingsSection
    next[section] = { ...next[section], ...(value as object) } as never
  }

  const upsert = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
  const write = db.transaction(() => {
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined || patch[key] === null) continue
      if (key === 'shortcuts') {
        upsert.run('shortcuts', JSON.stringify(next.shortcuts), now)
        continue
      }
      if (!SECTIONS.includes(key as SettingsSection)) continue
      upsert.run(key, JSON.stringify(next[key as SettingsSection]), now)
    }
  })
  write()

  return next
}

/** 重置为默认值（设置页的「恢复默认」用；M2-07 先给通道，界面在 M5-01） */
export function resetSettings(db: Db, now: number = Date.now()): SettingsDTO {
  db.prepare('DELETE FROM settings').run()
  return patchSettings(db, structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>, now)
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 坏行当作没写过：宁可回到默认值，也不要让整个设置读不出来
    return null
  }
}
