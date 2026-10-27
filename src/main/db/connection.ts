import Database from 'better-sqlite3'
import { ensureCompatibleDatabase, migrate, type MigrateResult } from './migrations'
import { createLogger } from '../log'

const log = createLogger('db')

export type Db = Database.Database

export interface OpenResult {
  db: Db
  migration: MigrateResult
}

/** 连接级 PRAGMA：每次打开都要设置，WAL 是持久化到库文件头的，其余不是 */
const PRAGMAS = [
  'journal_mode = WAL', // 读写并发：读不阻塞写
  'synchronous = NORMAL', // WAL 下的推荐值，掉电最多丢最后一个事务
  'foreign_keys = ON', // 默认关闭，必须显式开
  'busy_timeout = 5000', // 避免瞬时锁冲突直接抛 SQLITE_BUSY
  'temp_store = MEMORY'
] as const

/**
 * 打开库文件：设置 PRAGMA 并把结构迁移到最新版本。
 * 调用方负责生命周期；需要单例时用 initDatabase。
 */
export function openDatabase(file: string): OpenResult {
  // 代际校验在建立连接**之前**：连接一旦打开，Windows 上就改不了名
  const archived = ensureCompatibleDatabase(file)
  if (archived) {
    log.warn('检测到与当前版本不符的旧数据文件，已归档并重建', { archived })
  }
  const db = new Database(file)
  for (const pragma of PRAGMAS) db.pragma(pragma)
  const migration = migrate(db)
  return { db, migration: { ...migration, archived } }
}

let instance: Db | null = null

/**
 * 初始化全局连接（幂等）。主进程启动时调用一次。
 */
export function initDatabase(file: string): OpenResult {
  if (instance) {
    return { db: instance, migration: { from: 0, to: 0, applied: [], archived: null } }
  }
  const opened = openDatabase(file)
  instance = opened.db
  return opened
}

export function getDb(): Db {
  if (!instance) throw new Error('数据库尚未初始化，请先调用 initDatabase()')
  return instance
}

export function closeDatabase(): void {
  instance?.close()
  instance = null
}
