/**
 * 去重判定（M1-03）。
 *
 * 输入是扫描结果，输出是「可导入 / 重复 / 空文件 / 失败」四类。
 * **这个模块不写库**——它只回答「这一批文件里哪些该入库」，真正落库是 M1-06 的事。
 *
 * 四类重复要分清，因为 UI 的提示文案完全不同：
 *   - `existing-path`：同一根目录下同一个 rel_path 已有记录 → 「这本书已在书库中（路径未变）」
 *   - `duplicate-in-db`：内容指纹命中**别的**根目录/别的路径的书 → 「书库里已有同一本书（D:\books\xx.txt）」
 *   - `duplicate-in-batch`：同一批扫描里出现两次（比如用户同时 import 两个互为备份的盘） → 「本批次内重复」
 *   - `empty`：0 字节 → 「空文件，已跳过」
 *
 * 判定顺序是刻意的：先 path 后 hash。同 path 命中说明文件就在原地，
 * 此时再报「书库里已有同一本书（另一个路径）」会让用户困惑。
 */
import type { Db } from '../db/connection'
import { getDb } from '../db/connection'
import { fingerprintFiles } from './fingerprint'
import type { ScannedFile } from './scanner'

export type DedupeKind = 'new' | 'existing-path' | 'duplicate-in-db' | 'duplicate-in-batch' | 'empty' | 'failed'

export interface ExistingBook {
  id: string
  title: string
  rootId: string | null
  relPath: string | null
}

export interface DedupeEntry {
  file: ScannedFile
  /** 指纹；失败或空文件时为 null */
  hash: string | null
  kind: DedupeKind
  /** `existing-path` / `duplicate-in-db` 时给出命中的那条记录 */
  existing: ExistingBook | null
  /** `duplicate-in-batch` 时指向批内先出现的那一项的 relPath */
  duplicateOf: string | null
  /** `failed` 时的原因（原始英文，只进日志与开发者视图） */
  error: string | null
}

export interface DedupeStats {
  total: number
  unique: number
  existingPath: number
  duplicateInDb: number
  duplicateInBatch: number
  empty: number
  failed: number
  /** 指纹计算耗时 */
  elapsedMs: number
}

export interface DedupeResult {
  entries: DedupeEntry[]
  /** 可入库的项（kind === 'new'），保持 relPath 升序 */
  unique: DedupeEntry[]
  duplicates: DedupeEntry[]
  stats: DedupeStats
  cancelled: boolean
}

/** SQLite 的绑定参数有上限（旧版 999，新版 32766），分批查是唯一稳妥做法 */
const QUERY_BATCH = 400

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

interface BookRow {
  id: string
  title: string
  root_id: string | null
  rel_path: string | null
}

/** 按指纹查已有记录（跨根，全局） */
function findByHashes(db: Db, hashes: readonly string[]): Map<string, ExistingBook> {
  const found = new Map<string, ExistingBook>()
  if (hashes.length === 0) return found

  for (const batch of chunk(hashes, QUERY_BATCH)) {
    const rows = db
      .prepare(
        `SELECT id, title, root_id, rel_path, file_hash FROM books
         WHERE deleted_at IS NULL AND file_hash IN (${placeholders(batch.length)})`
      )
      .all(...batch) as (BookRow & { file_hash: string })[]

    for (const row of rows) {
      // 唯一索引只约束 local 类型，理论上不会同 hash 多条；真出现时保留先查到的那条
      if (!found.has(row.file_hash)) {
        found.set(row.file_hash, { id: row.id, title: row.title, rootId: row.root_id, relPath: row.rel_path })
      }
    }
  }
  return found
}

/** 按 (root, rel_path) 查已有记录 */
function findByPaths(db: Db, rootId: string, relPaths: readonly string[]): Map<string, ExistingBook> {
  const found = new Map<string, ExistingBook>()
  if (relPaths.length === 0) return found

  for (const batch of chunk(relPaths, QUERY_BATCH)) {
    const rows = db
      .prepare(
        `SELECT id, title, root_id, rel_path FROM books
         WHERE root_id = ? AND deleted_at IS NULL AND rel_path IN (${placeholders(batch.length)})`
      )
      .all(rootId, ...batch) as BookRow[]

    for (const row of rows) {
      if (row.rel_path) found.set(row.rel_path, { id: row.id, title: row.title, rootId: row.root_id, relPath: row.rel_path })
    }
  }
  return found
}

export async function dedupeFiles(
  rootId: string,
  files: readonly ScannedFile[],
  options: { db?: Db; concurrency?: number; signal?: AbortSignal } = {}
): Promise<DedupeResult> {
  const started = performance.now()
  const db = options.db ?? getDb()

  const stats: DedupeStats = {
    total: files.length,
    unique: 0,
    existingPath: 0,
    duplicateInDb: 0,
    duplicateInBatch: 0,
    empty: 0,
    failed: 0,
    elapsedMs: 0
  }

  // 空文件不参与指纹计算：size=0 的指纹会全部相同，混进重复判定反而互相干扰
  const candidates = files.filter((f) => f.size > 0)

  const { results, cancelled } = await fingerprintFiles(
    candidates.map((f) => f.absPath),
    { concurrency: options.concurrency, signal: options.signal }
  )

  const printByPath = new Map(results.map((r) => [r.absPath, r]))

  const existingByPath = findByPaths(
    db,
    rootId,
    files.map((f) => f.relPath)
  )
  const existingByHash = findByHashes(
    db,
    results.map((r) => r.fingerprint?.hash).filter((h): h is string => typeof h === 'string')
  )

  const entries: DedupeEntry[] = []
  /** 批内已占用的指纹 → 首次出现的 relPath */
  const batchSeen = new Map<string, string>()

  for (const file of files) {
    if (file.size === 0) {
      entries.push({ file, hash: null, kind: 'empty', existing: null, duplicateOf: null, error: null })
      stats.empty++
      continue
    }

    const printed = printByPath.get(file.absPath)
    if (!printed || !printed.fingerprint) {
      entries.push({
        file,
        hash: null,
        kind: 'failed',
        existing: null,
        duplicateOf: null,
        error: printed?.error ?? '指纹计算失败'
      })
      stats.failed++
      continue
    }

    const hash = printed.fingerprint.hash

    const samePath = existingByPath.get(file.relPath)
    if (samePath) {
      entries.push({ file, hash, kind: 'existing-path', existing: samePath, duplicateOf: null, error: null })
      stats.existingPath++
      continue
    }

    const inDb = existingByHash.get(hash)
    if (inDb) {
      entries.push({ file, hash, kind: 'duplicate-in-db', existing: inDb, duplicateOf: null, error: null })
      stats.duplicateInDb++
      continue
    }

    const seenAt = batchSeen.get(hash)
    if (seenAt) {
      entries.push({ file, hash, kind: 'duplicate-in-batch', existing: null, duplicateOf: seenAt, error: null })
      stats.duplicateInBatch++
      continue
    }

    batchSeen.set(hash, file.relPath)
    entries.push({ file, hash, kind: 'new', existing: null, duplicateOf: null, error: null })
    stats.unique++
  }

  stats.elapsedMs = Number((performance.now() - started).toFixed(1))

  return {
    entries,
    unique: entries.filter((e) => e.kind === 'new'),
    duplicates: entries.filter(
      (e) => e.kind === 'existing-path' || e.kind === 'duplicate-in-db' || e.kind === 'duplicate-in-batch'
    ),
    stats,
    cancelled
  }
}
