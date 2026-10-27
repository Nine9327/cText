import type { Database } from 'better-sqlite3'
import initialSql from './001_initial.sql?raw'

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
  { version: 1, name: 'initial', sql: initialSql }
]

export interface MigrateResult {
  from: number
  to: number
  /** 本次实际执行的版本号，已是最新时为空数组 */
  applied: number[]
}

/**
 * 把库迁移到最新版本。已是最新时为空操作，可安全重复调用。
 * 每个版本单独一个事务：中途失败则回滚该版本，已完成的版本保持生效。
 */
export function migrate(db: Database): MigrateResult {
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
    applied
  }
}
