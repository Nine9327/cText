/**
 * library_roots 仓储（M1-01）。
 *
 * 分层原则沿用 M0-03：**仓储只管 SQL，业务规则（路径校验、冲突提示、状态探测）
 * 一律在 `main/library/roots-monitor.ts` 与 IPC 层**。这样仓储可以被 smoke 直接
 * 注入临时库测试，不需要启动整个 Electron 生命周期。
 *
 * 三处 DDL 细节必须记住：
 *   1. `path` 是 UNIQUE，但 SQLite 的字符串比较是**字节级**的。Windows 路径大小写不敏感，
 *      所以应用层查重要额外 lower() 兜一层（中文路径不受影响，大小写只发生在盘符与英文段）。
 *   2. `state` 是 TEXT 没有 CHECK 约束，读出来必须收窄成 `RootState`，不能直接把字符串当枚举用。
 *   3. `books.root_id` 的外键**没有 ON DELETE**——直接删根目录会撞 SQLITE_CONSTRAINT_FOREIGNKEY。
 *      「移除根目录不删书」这条产品口径（产品文档 §2.3）因此必须由仓储在事务里先解绑再删。
 */
import type { RootState } from '@shared/dto'
import type { Db } from '../connection'
import { getDb } from '../connection'
import { ulid } from '../../utils/id'

/** 领域对象（camelCase，与 DTO 同形但不含派生字段） */
export interface RootRecord {
  id: string
  label: string
  path: string
  volumeGuid: string | null
  state: RootState
  sort: number
  lastCheckAt: number | null
  createdAt: number
}

/** 带书籍数的视图（对应 RootDTO） */
export interface RootWithCount extends RootRecord {
  bookCount: number
}

interface RootRow {
  id: string
  label: string
  path: string
  volume_guid: string | null
  state: string
  sort: number
  last_check_at: number | null
  created_at: number
  book_count: number
}

/** state 列没有 CHECK 约束，读取时收窄；未知值按 online 处理（宁可让用户看到书，也不假装掉线） */
function rootStateOf(value: string): RootState {
  return value === 'offline' ? 'offline' : 'online'
}

function toRecord(row: RootRow): RootWithCount {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    volumeGuid: row.volume_guid,
    state: rootStateOf(row.state),
    sort: row.sort,
    lastCheckAt: row.last_check_at,
    createdAt: row.created_at,
    bookCount: row.book_count
  }
}

/**
 * 书籍数用相关子查询而不是 LEFT JOIN + GROUP BY：
 * 根目录数量是个位数到几十，子查询走 idx_books_root 每次都是索引定位，
 * 比聚合整个 books 表更快，也免得 GROUP BY 与 ORDER BY 打架。
 */
const SELECT_WITH_COUNT = `
  SELECT r.*, (
    SELECT COUNT(*) FROM books b
    WHERE b.root_id = r.id AND b.deleted_at IS NULL
  ) AS book_count
  FROM library_roots r
`

export class RootsRepository {
  constructor(private readonly db: Db) {}

  /** 全部根目录，按 sort 再按创建时间。空库返回 [] */
  list(): RootWithCount[] {
    const rows = this.db
      .prepare(`${SELECT_WITH_COUNT} ORDER BY r.sort ASC, r.created_at ASC`)
      .all() as RootRow[]
    return rows.map(toRecord)
  }

  get(id: string): RootWithCount | null {
    const row = this.db.prepare(`${SELECT_WITH_COUNT} WHERE r.id = ?`).get(id) as RootRow | undefined
    return row ? toRecord(row) : null
  }

  /**
   * 按路径查（大小写不敏感）。
   * SQLite 的 lower() 只折叠 ASCII，对中文路径无副作用；Windows 的大小写敏感只体现在
   * 盘符与英文段，正好落在 lower() 的覆盖范围内。
   */
  findByPath(path: string): RootWithCount | null {
    const row = this.db
      .prepare(`${SELECT_WITH_COUNT} WHERE lower(r.path) = lower(?)`)
      .get(path) as RootRow | undefined
    return row ? toRecord(row) : null
  }

  /** 新增。调用方负责校验路径可读与查重，这里只兜 DB 唯一约束 */
  create(input: { label: string; path: string; volumeGuid?: string | null }): RootWithCount {
    const id = ulid()
    const now = Date.now()
    const sort = this.nextSort()

    this.db
      .prepare(
        `INSERT INTO library_roots (id, label, path, volume_guid, state, sort, last_check_at, created_at)
         VALUES (?, ?, ?, ?, 'online', ?, NULL, ?)`
      )
      .run(id, input.label, input.path, input.volumeGuid ?? null, sort, now)

    // 重新查一次而不是手工拼对象：book_count 与 sort 都以库里的值为准
    const created = this.get(id)
    if (!created) throw new Error(`library_roots 写入后读不到：${id}`)
    return created
  }

  /** 换路径（重定位）。同时更新 volume_guid 与状态由调用方按探测结果再调 setState */
  updatePath(id: string, path: string, volumeGuid: string | null = null): void {
    this.db.prepare('UPDATE library_roots SET path = ?, volume_guid = ? WHERE id = ?').run(path, volumeGuid, id)
  }

  /** 写状态 + 检测时间。返回 false 表示 id 不存在 */
  setState(id: string, state: RootState, checkedAt: number): boolean {
    const info = this.db
      .prepare('UPDATE library_roots SET state = ?, last_check_at = ? WHERE id = ?')
      .run(state, checkedAt, id)
    return info.changes > 0
  }

  /**
   * 只更新时间戳，不动状态。
   * 用于「检测过但状态没变」的场合；调用方按需节流，避免每次 focus 都产生一次写。
   */
  touchCheck(id: string, checkedAt: number): void {
    this.db.prepare('UPDATE library_roots SET last_check_at = ? WHERE id = ?').run(checkedAt, id)
  }

  /**
   * 移除根目录，**不删书籍**（产品文档 §2.3）。
   *
   * `books.root_id` 外键没有 ON DELETE，所以顺序必须是先解绑再删，
   * 并且两步同事务——中途失败会留下「根目录没了书还挂着外键」的半残状态。
   *
   * 解绑后书籍的 `root_id` 为 NULL：与「网络书 root_id 为 NULL」共用同一表示，
   * 靠 `source_type` 区分。M1-08 的书库列表要把 `root_id IS NULL AND source_type='local'`
   * 当成「未归属 + 离线」渲染。
   */
  remove(id: string): { detachedBooks: number } {
    const detach = this.db.prepare('UPDATE books SET root_id = NULL WHERE root_id = ?')
    const del = this.db.prepare('DELETE FROM library_roots WHERE id = ?')

    return this.db.transaction(() => {
      const detached = detach.run(id).changes
      del.run(id)
      return { detachedBooks: detached }
    })()
  }

  /** 下一個排序位（MAX+1，空表从 0 开始） */
  nextSort(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM library_roots').get() as {
      next: number
    }
    return row.next
  }

  /** 该根目录下未删除的书籍的 rel_path 列表（重定位时逐个校验文件是否还在） */
  relPathsOf(rootId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT rel_path FROM books
         WHERE root_id = ? AND deleted_at IS NULL AND rel_path IS NOT NULL`
      )
      .all(rootId) as { rel_path: string }[]
    return rows.map((r) => r.rel_path)
  }
}

/**
 * 仓储单例。
 *
 * 按 db 实例缓存：IPC 层不传参走全局连接，smoke 传临时库也能拿到独立实例，
 * 两者互不污染。
 */
let cached: { db: Db; repo: RootsRepository } | null = null

export function rootsRepo(database?: Db): RootsRepository {
  const db = database ?? getDb()
  if (cached && cached.db === db) return cached.repo
  const repo = new RootsRepository(db)
  cached = { db, repo }
  return repo
}
