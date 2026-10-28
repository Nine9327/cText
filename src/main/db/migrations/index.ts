import Database from 'better-sqlite3'
import { existsSync, renameSync } from 'node:fs'
import initialSql from './001_initial.sql?raw'
import bookmarkRangeSql from './002_bookmark_range.sql?raw'

/**
 * 版本化迁移。
 *
 * 约定：
 * - `version` 必须是从 1 开始、严格递增的整数，且不重复；
 * - 每个版本的 `sql` 只写增量 DDL，绝不再改动已发布版本的内容；
 * - 版本号记在 SQLite 内建的 `PRAGMA user_version` 上，事务内一并提交，
 *   所以「建表失败 → 版本号不前进」是原子的。
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initialSql },
  { version: 2, name: 'bookmark-range', sql: bookmarkRangeSql }
]

export const LATEST_VERSION = migrations[migrations.length - 1]!.version

/**
 * 代际探针表：识别「版本号吻合但 schema 完全不同」的异物库。
 *
 * 背景（2026-10-28 真实事故）：一个原型期的 ctext.db（表是 novel_books/
 * novel_progress/plugins 那套）user_version 恰好是 1，与迁移链最新版本撞车。
 * migrate 只比对版本号，认为「已是最新」，一张现役表都没建——之后所有查询
 * 都报 no such table，而 M1 全部验收都用全新临时库，从未暴露。
 *
 * 所以「版本号到了」不等于「schema 到了」，必须用探针表二次确认。
 * **约定：这些表自 001 起就存在，后续迁移不得删除或改名**；
 * 将来若有重构性迁移真的动了它们，必须同步更新这里。
 */
const PROBE_TABLES: readonly string[] = ['books', 'library_roots']

export interface MigrateResult {
  from: number
  to: number
  /** 本次实际执行的版本号，已是最新时为空数组 */
  applied: number[]
  /**
   * 非空 = 打开时发现「版本号吻合但探针表缺失」的异物库，原文件已改名为
   * 该路径（**归档，绝不删除**），当前是重建出来的全新库。
   */
  archived: string | null
}

function fileStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 打开库文件**之前**的代际校验。
 *
 * 三种结局：
 *   - 正常（新库 / 待升级 / 版本与 schema 相符）→ 原样返回；
 *   - 异物库（user_version 与最新版本相同、但探针表缺失）→ 库文件连同
 *     WAL/SHM 一起改名归档，返回归档路径，调用方随后重建全新库；
 *   - 来自未来版本（user_version 大于迁移链最新版，即用户装了旧版应用）
 *     → 抛错拒绝打开。任何情况下都不允许「降级打开」去写一个更新过的库。
 *
 * 归档必须发生在建立连接**之前**：连接一旦打开，Windows 上文件就被锁住，
 * 改不了名。
 */
export function ensureCompatibleDatabase(file: string): string | null {
  if (!existsSync(file)) return null

  const probe = new Database(file, { readonly: true })
  let from: number
  try {
    from = probe.pragma('user_version', { simple: true }) as number
    if (from === 0) return null // 空文件/新库
    if (from > LATEST_VERSION) {
      throw new Error(
        `数据库来自更新的版本（user_version=${from} > 应用支持的 ${LATEST_VERSION}），请升级应用后再打开`
      )
    }

    /*
     * **只要不是空库就要验探针表**，不能只在「版本号恰好等于最新」时才验。
     *
     * 这一条是加 002 迁移时踩出来的：一个异物库 user_version=1，比当时的
     * 最新版（2）小，于是走进「正常升级路径」，002 的 ALTER TABLE bookmarks
     * 直接在启动时炸掉，整个应用打不开。正常升级的库从 001 起就带着这些表，
     * 所以「缺表」只可能意味着它不是 cText 的库。
     */
    const tables = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (row) => row.name
      )
    )
    const missing = PROBE_TABLES.filter((table) => !tables.has(table))
    if (missing.length === 0) return null
  } finally {
    probe.close()
  }

  // 走到这里 = 版本号撞车但 schema 是别的东西：归档，绝不删除
  const archived = `${file}.incompatible-${fileStamp()}`
  renameSync(file, archived)
  for (const suffix of ['-wal', '-shm']) {
    const side = `${file}${suffix}`
    if (existsSync(side)) renameSync(side, `${archived}${suffix}`)
  }
  return archived
}

/**
 * 把库迁移到最新版本。已是最新时为空操作，可安全重复调用。
 * 每个版本单独一个事务：中途失败则回滚该版本，已完成的版本保持生效。
 */
export function migrate(db: Database.Database): MigrateResult {
  const from = db.pragma('user_version', { simple: true }) as number
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)

  const applied: number[] = []
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      // user_version 不支持参数绑定，只能是拼接后的整数字面量（version 来自本文件的常量）
      db.pragma(`user_version = ${m.version}`)
    })()
    applied.push(m.version)
  }

  return {
    from,
    to: db.pragma('user_version', { simple: true }) as number,
    applied,
    archived: null
  }
}
