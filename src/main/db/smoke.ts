import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase } from './connection'
import { migrate, migrations } from './migrations'

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

  return checks
}
