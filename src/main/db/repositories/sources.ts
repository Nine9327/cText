/**
 * book_sources 仓储（M4-07）。
 *
 * 与 M1 的仓储同构：**只管 SQL**，业务规则（校验、兼容判定、限速）在
 * `main/engine/source/` 与 IPC 层。这样 smoke 能注入临时库直接测仓储。
 *
 * 四处 DDL 细节必须记住：
 *   1. `book_source_url` 是 UNIQUE —— 它是书源的天然身份。重复导入靠它判定，
 *      而不是靠 name（同名不同站的书源很常见）。
 *   2. `compat_level` 是 TEXT 没有 CHECK 约束，读出来必须收窄成 `CompatLevel`。
 *   3. `enabled` / `custom_order` 都是 INTEGER，DTO 层要转 boolean / number。
 *   4. `rule_json` 存**原始对象序列化后的文本**。重新导入时拿它和旧值比对来区分
 *      `skipped` 与 `updated`——没有这一列就得每次都写库，界面上的「更新了 N 个」也就没意义。
 */
import type { CompatLevel, SourceDTO } from '@shared/dto'
import type { Db } from '../connection'
import { getDb } from '../connection'
import { advanceBreaker, breakerNote, BREAKER_IDLE, type BreakerState } from '../../engine/source/breaker'
import { ulid } from '../../utils/id'

export interface SourceRecord {
  id: string
  url: string
  name: string
  group: string | null
  enabled: boolean
  customOrder: number
  compatLevel: CompatLevel
  compatNote: string | null
  ruleJson: string
  lastUsedAt: number | null
  createdAt: number
  /** 连续超时次数（M4-12）；达到阈值后由 `breaker_until` 决定是否临时停用 */
  failStreak: number
  /** 冷却结束时间；null = 未熔断 */
  breakerUntil: number | null
  /** 最近一次失败原因 */
  lastFailure: string | null
}

interface SourceRow {
  id: string
  book_source_url: string
  name: string
  group: string | null
  enabled: number
  custom_order: number
  compat_level: string
  compat_note: string | null
  rule_json: string
  last_used_at: number | null
  created_at: number
  fail_streak: number
  breaker_until: number | null
  last_failure: string | null
}

/** compat_level 列没有 CHECK 约束，读到未知值按最保守的 unsupported 处理 */
function compatOf(value: string): CompatLevel {
  return value === 'full' || value === 'partial' ? value : 'unsupported'
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    url: row.book_source_url,
    name: row.name,
    group: row.group,
    enabled: row.enabled !== 0,
    customOrder: row.custom_order,
    compatLevel: compatOf(row.compat_level),
    compatNote: row.compat_note,
    ruleJson: row.rule_json,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    failStreak: row.fail_streak,
    breakerUntil: row.breaker_until,
    lastFailure: row.last_failure
  }
}

export function toSourceDTO(record: SourceRecord, now = Date.now()): SourceDTO {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    group: record.group,
    enabled: record.enabled,
    compatLevel: record.compatLevel,
    compatNote: record.compatNote,
    customOrder: record.customOrder,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    failStreak: record.failStreak,
    breakerNote: breakerNote(
      { streak: record.failStreak, until: record.breakerUntil, lastFailure: record.lastFailure },
      now
    )
  }
}

const SELECT = `
  SELECT id, book_source_url, name, "group", enabled, custom_order,
         compat_level, compat_note, rule_json, last_used_at, created_at,
         fail_streak, breaker_until, last_failure
  FROM book_sources`

export interface UpsertInput {
  url: string
  name: string
  group: string | null
  enabled: boolean
  compatLevel: CompatLevel
  compatNote: string | null
  ruleJson: string
  /** 书源自带的 customOrder；不传或为 0 时排到末尾 */
  customOrder: number
  now: number
}

export type UpsertOutcome = 'imported' | 'updated' | 'skipped'

export class SourcesRepository {
  constructor(private readonly db: Db) {}

  list(): SourceRecord[] {
    return (
      this.db.prepare(`${SELECT} ORDER BY custom_order, created_at, id`).all() as SourceRow[]
    ).map(toRecord)
  }

  /** 只列启用的，供 M4-08 搜索用 */
  listEnabled(): SourceRecord[] {
    return (
      this.db.prepare(`${SELECT} WHERE enabled = 1 ORDER BY custom_order, created_at, id`).all() as SourceRow[]
    ).map(toRecord)
  }

  get(id: string): SourceRecord | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as SourceRow | undefined
    return row ? toRecord(row) : null
  }

  /**
   * 按 URL 查。**大小写不敏感**：`https://A.com` 与 `https://a.com` 在 DNS 上是同一台机器，
   * 判成两个书源会让用户看到两条一模一样的记录，还各自发请求。
   * 规范化（补斜杠、去端口）在这里不做——存进去什么样就什么样，只在比对时折叠大小写。
   */
  findByUrl(url: string): SourceRecord | null {
    const row = this.db
      .prepare(`${SELECT} WHERE lower(book_source_url) = lower(?)`)
      .get(url) as SourceRow | undefined
    return row ? toRecord(row) : null
  }

  /**
   * 幂等写入。三种结果：
   *   - `skipped`：同 URL 已存在且 `rule_json` 完全相同（重复导入同一个文件）
   *   - `updated`：同 URL 已存在但内容变了（用户改了书源再导入）
   *   - `imported`：新记录
   *
   * **不覆盖 `enabled`**：用户手动停用的书源，重新导入一次不该被悄悄打开。
   * 新记录才用书源自带的 `enabled`。
   */
  upsert(input: UpsertInput): { outcome: UpsertOutcome; record: SourceRecord } {
    const existing = this.findByUrl(input.url)
    if (existing) {
      if (existing.ruleJson === input.ruleJson) return { outcome: 'skipped', record: existing }
      this.db
        .prepare(
          `UPDATE book_sources
              SET name = ?, "group" = ?, compat_level = ?, compat_note = ?, rule_json = ?
            WHERE id = ?`
        )
        .run(input.name, input.group, input.compatLevel, input.compatNote, input.ruleJson, existing.id)
      return { outcome: 'updated', record: this.get(existing.id) ?? existing }
    }

    const id = ulid(input.now)
    const order = input.customOrder !== 0 ? input.customOrder : this.nextOrder()
    this.db
      .prepare(
        `INSERT INTO book_sources
           (id, book_source_url, name, "group", enabled, custom_order,
            compat_level, compat_note, rule_json, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        id,
        input.url,
        input.name,
        input.group,
        input.enabled ? 1 : 0,
        order,
        input.compatLevel,
        input.compatNote,
        input.ruleJson,
        input.now
      )
    const created = this.get(id)
    // 刚插入的行必然存在；真取不到说明并发写坏了库，抛出比返回半截对象好
    if (!created) throw new Error(`书源写入后读回失败: ${id}`)
    return { outcome: 'imported', record: created }
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE book_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0
  }

  /**
   * 删除书源。
   *
   * **必须先把书籍的 `source_id` 置空再删**：`books.source_id` 是外键且没有
   * `ON DELETE SET NULL`（DDL 里没写动作 = RESTRICT），直接 DELETE 会撞
   * `FOREIGN KEY constraint failed`——表现为「书源删不掉」，而用户看到的就是一个报错。
   * 产品口径是「删书源不删书，书保留但不能再刷新」，所以这里把引用清掉，书籍行留着。
   */
  remove(id: string): boolean {
    const detach = this.db.prepare('UPDATE books SET source_id = NULL WHERE source_id = ?')
    const run = this.db.transaction(() => {
      detach.run(id)
      return this.db.prepare('DELETE FROM book_sources WHERE id = ?').run(id).changes > 0
    })
    return run()
  }

  /**
   * 按给定顺序重排。**必须在一个事务里**：写一半崩了会让 custom_order 出现重复段，
   * 之后列表顺序就固定不下来。
   */
  reorder(ids: string[]): void {
    const update = this.db.prepare('UPDATE book_sources SET custom_order = ? WHERE id = ?')
    this.db.transaction(() => {
      ids.forEach((id, index) => update.run(index, id))
    })()
  }

  /** 记录一次使用（M4-08 搜索成功后调用，供列表按「最近使用」排序） */
  touch(id: string, now: number): void {
    this.db.prepare('UPDATE book_sources SET last_used_at = ? WHERE id = ?').run(now, id)
  }

  /** 读熔断状态；记录不存在时返回空状态（调用方无需先判空） */
  breakerOf(id: string): BreakerState {
    const row = this.db
      .prepare('SELECT fail_streak, breaker_until, last_failure FROM book_sources WHERE id = ?')
      .get(id) as { fail_streak: number; breaker_until: number | null; last_failure: string | null } | undefined
    if (!row) return { ...BREAKER_IDLE }
    return { streak: row.fail_streak, until: row.breaker_until, lastFailure: row.last_failure }
  }

  /**
   * 用一次抓取结果推进熔断状态并落库。返回推进后的状态，供调用方决定本次是否要跳过。
   *
   * 只写三列、**不动 `updated_at`/`last_used_at`**：熔断是运行时状态，
   * 不该让列表的「最近使用」排序跳动。
   */
  recordOutcome(id: string, outcome: { ok: boolean; code?: string | null; message?: string | null }, now: number): BreakerState {
    const next = advanceBreaker(this.breakerOf(id), outcome, now)
    this.db
      .prepare('UPDATE book_sources SET fail_streak = ?, breaker_until = ?, last_failure = ? WHERE id = ?')
      .run(next.streak, next.until, next.lastFailure, id)
    return next
  }

  /** 手动恢复：清空连击与冷却（界面上的「恢复」按钮） */
  resetBreaker(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE book_sources SET fail_streak = 0, breaker_until = NULL, last_failure = NULL WHERE id = ?')
        .run(id).changes > 0
    )
  }

  nextOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(custom_order), -1) + 1 AS next FROM book_sources').get() as {
      next: number
    }
    return row.next
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM book_sources').get() as { n: number }
    return row.n
  }
}

/**
 * 仓储单例。按 db 实例缓存，IPC 层不传参走全局连接，smoke 传临时库拿独立实例。
 */
let cached: { db: Db; repo: SourcesRepository } | null = null

export function sourcesRepo(database?: Db): SourcesRepository {
  const db = database ?? getDb()
  if (cached && cached.db === db) return cached.repo
  const repo = new SourcesRepository(db)
  cached = { db, repo }
  return repo
}
