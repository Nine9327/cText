import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { openDatabase } from './connection'
import { ensureCompatibleDatabase, migrate, migrations } from './migrations'

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

const EXPECTED_TABLES = [
  'library_roots',
  'book_sources',
  'books',
  'chapters',
  'reading_progress',
  'shelves',
  'shelf_books',
  'categories',
  'book_categories',
  'bookmarks',
  'settings',
  'books_fts'
]

const EXPECTED_INDEXES = [
  'idx_books_root_relpath',
  'idx_books_hash',
  'idx_books_last_read',
  'idx_books_root',
  'idx_books_fav',
  'idx_bookmarks_book'
]

/** 临时库文件及其 WAL 附属文件一并清理 */
function removeDbFiles(file: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${file}${suffix}`, { force: true })
  }
}

/**
 * M0-03 冒烟自检：在临时库上验证建表、PRAGMA、迁移幂等、约束与 FTS 触发器。
 * 不触碰真实书库文件；由主进程在 !app.isPackaged && CTEXT_DB_SMOKE=1 时调用。
 */
export function runDbSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const file = join(app.getPath('temp'), `ctext-db-smoke-${Date.now()}.db`)
  removeDbFiles(file)

  const { db, migration } = openDatabase(file)
  try {
    check('首次打开即建库', migration.from === 0 && migration.applied.length === migrations.length, `应用迁移 ${migration.applied.join(',')}`)

    const journalMode = db.pragma('journal_mode', { simple: true }) as string
    check('journal_mode = wal', journalMode.toLowerCase() === 'wal', journalMode)

    const fk = db.pragma('foreign_keys', { simple: true }) as number
    check('foreign_keys = ON', fk === 1, String(fk))

    const version = db.pragma('user_version', { simple: true }) as number
    check('user_version 到位', version === migrations.length, `user_version=${version}`)

    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
    )
    const missingTables = EXPECTED_TABLES.filter((t) => !tables.has(t))
    check('全部表已创建', missingTables.length === 0, missingTables.length ? `缺 ${missingTables.join(',')}` : `${EXPECTED_TABLES.length} 张`)

    const indexes = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name)
    )
    const missingIndexes = EXPECTED_INDEXES.filter((i) => !indexes.has(i))
    check('关键索引已创建', missingIndexes.length === 0, missingIndexes.length ? `缺 ${missingIndexes.join(',')}` : `${EXPECTED_INDEXES.length} 个`)

    // 迁移可重复执行：已是最新时应为空操作
    const again = migrate(db)
    check('迁移可重复执行', again.applied.length === 0 && again.to === version, `applied=${again.applied.length} to=${again.to}`)

    // 外键约束
    let fkBlocked = false
    let fkCode = ''
    try {
      db.prepare(
        'INSERT INTO books (id,title,format,file_hash,created_at,updated_at,root_id,rel_path) VALUES (?,?,?,?,?,?,?,?)'
      ).run('bad', 't', 'txt', 'h-bad', 1, 1, 'no-such-root', 'a.txt')
    } catch (e) {
      fkBlocked = true
      fkCode = (e as { code?: string }).code ?? ''
    }
    check('外键约束生效', fkBlocked, fkCode)

    // 同一根目录下 rel_path 唯一
    db.prepare('INSERT INTO library_roots (id,label,path,created_at) VALUES (?,?,?,?)').run('root1', '本机', 'D:/books', 1)
    const insertBook = db.prepare(
      'INSERT INTO books (id,title,format,file_hash,created_at,updated_at,root_id,rel_path) VALUES (?,?,?,?,?,?,?,?)'
    )
    insertBook.run('b1', 'Alpha Beta', 'txt', 'h1', 1, 1, 'root1', 'a.txt')
    let dupBlocked = false
    try {
      insertBook.run('b2', 'dup', 'txt', 'h2', 1, 1, 'root1', 'a.txt')
    } catch {
      dupBlocked = true
    }
    check('同根目录 rel_path 唯一', dupBlocked)

    // 级联删除
    db.prepare('INSERT INTO chapters (book_id,idx,title) VALUES (?,?,?)').run('b1', 0, '第一章')
    db.prepare('DELETE FROM books WHERE id = ?').run('b1')
    const left = db.prepare('SELECT COUNT(*) AS c FROM chapters').get() as { c: number }
    check('章节随书籍级联删除', left.c === 0, `剩余 ${left.c}`)

    // FTS 触发器：插入可搜到、更新后旧词失效
    insertBook.run('b3', 'Gamma Delta', 'txt', 'h3', 1, 1, 'root1', 'c.txt')
    const hit = db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all('Gamma') as unknown[]
    check('FTS 插入可检索', hit.length === 1, `命中 ${hit.length}`)

    db.prepare('UPDATE books SET title = ? WHERE id = ?').run('Epsilon Zeta', 'b3')
    const oldHit = db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all('Gamma') as unknown[]
    const newHit = db.prepare('SELECT rowid FROM books_fts WHERE books_fts MATCH ?').all('Epsilon') as unknown[]
    check('FTS 更新同步', oldHit.length === 0 && newHit.length === 1, `旧词 ${oldHit.length} / 新词 ${newHit.length}`)
  } finally {
    db.close()
    removeDbFiles(file)
  }

  // ---------------------------------------------------------------- 异物库防御
  // **旧版号**的异物库也要拦（M2-09 加 002 迁移时踩到）：一个 user_version=1
  // 但与 cText 无关的库，以前会走「正常升级路径」，002 的 ALTER TABLE 直接把
  // 应用启动打挂。判据不是「版本号等于最新」，而是「非空库必须带着探针表」。
  if (migrations.length > 1) {
    const olderFile = join(app.getPath('temp'), `ctext-db-smoke-older-${Date.now()}.db`)
    removeDbFiles(olderFile)
    const older = new Database(olderFile)
    older.pragma(`user_version = ${migrations.length - 1}`)
    older.exec('CREATE TABLE novel_books (id TEXT PRIMARY KEY)')
    older.close()

    const reopenedOlder = openDatabase(olderFile)
    try {
      check(
        '旧版号的异物库同样被归档',
        typeof reopenedOlder.migration.archived === 'string',
        reopenedOlder.migration.archived ?? '未归档（会走进正常升级路径）'
      )
      check('旧版号异物库归档后重建出现役表', generationTablesReady(reopenedOlder.db), 'books/library_roots/…')
    } finally {
      reopenedOlder.db.close()
      removeDbFiles(olderFile)
    }
  }

  // 真实事故（2026-10-28）：原型期的库 user_version 恰好是 1，与迁移链最新版本
  // 撞车，migrate 认为已是最新，一张现役表都没建 → 所有查询报 no such table。
  // M1 期间全部验收都用全新临时库，这个路径从没被跑到过。
  {
    const legacyFile = join(app.getPath('temp'), `ctext-db-smoke-legacy-${Date.now()}.db`)
    removeDbFiles(legacyFile)
    const legacy = new Database(legacyFile)
    legacy.pragma('user_version = 1')
    legacy.exec('CREATE TABLE novel_books (id TEXT PRIMARY KEY)') // 与现役 schema 毫无关系的旧表
    legacy.close()

    const reopened = openDatabase(legacyFile)
    try {
      check('异物库被识别并归档', typeof reopened.migration.archived === 'string', reopened.migration.archived ?? '未归档')
      check('归档后重建出现役表', generationTablesReady(reopened.db), 'books/library_roots/chapters/books_fts')
      check(
        '原文件保留为归档（数据零丢失）',
        typeof reopened.migration.archived === 'string' && existsSync(reopened.migration.archived!),
        reopened.migration.archived ?? '-'
      )
      let legacyTables = { c: 0 }
      if (reopened.migration.archived) {
        // 必须显式 close：句柄不释放，下面 finally 里的 rmSync 会 EBUSY
        const archivedDb = new Database(reopened.migration.archived, { readonly: true })
        try {
          legacyTables = archivedDb
            .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='novel_books'")
            .get() as { c: number }
        } finally {
          archivedDb.close()
        }
      }
      check('归档文件里的旧表原样保留', legacyTables.c === 1, String(legacyTables.c))
    } finally {
      reopened.db.close()
      removeDbFiles(legacyFile)
      if (reopened.migration.archived) rmSync(reopened.migration.archived, { force: true })
    }
  }

  // 来自未来版本的库（用户装了旧版应用）：绝不能打开，更不能动
  {
    const futureFile = join(app.getPath('temp'), `ctext-db-smoke-future-${Date.now()}.db`)
    removeDbFiles(futureFile)
    const future = new Database(futureFile)
    future.pragma('user_version = 999')
    future.exec('CREATE TABLE books (id TEXT PRIMARY KEY)')
    future.close()

    let rejected = false
    let detail = ''
    try {
      openDatabase(futureFile)
    } catch (err) {
      rejected = true
      detail = err instanceof Error ? err.message : String(err)
    }
    check('未来版本的库拒绝打开', rejected, detail.slice(0, 60))
    check('未来版本的库原样保留', existsSync(futureFile), existsSync(futureFile) ? '未改动' : '被动了')
    removeDbFiles(futureFile)
  }

  // 新库路径：文件不存在时是空操作
  check('新库路径不做代际校验', ensureCompatibleDatabase(join(app.getPath('temp'), `no-such-${Date.now()}.db`)) === null, '-')

  return checks
}

function generationTablesReady(db: import('better-sqlite3').Database): boolean {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
  )
  return ['books', 'library_roots', 'chapters', 'books_fts'].every((t) => tables.has(t))
}
