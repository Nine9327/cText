/**
 * M1-03 自检：内容指纹与去重。
 *
 * 纯主进程 + 临时库，不需要窗口。
 *
 * 特意保留一条「已知盲区」断言：size 相同、首末 4KB 相同、中间不同的两个文件
 * 会被 quick 指纹判为同一个。这不是 bug 是取舍（读 8KB vs 读全文），
 * 断言它存在是为了防止将来有人误以为算法是全内容的；紧跟着的 fullSha1 断言
 * 证明兜底手段能区分它们。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase } from '../db/connection'
import { fingerprintFile, fullSha1 } from './fingerprint'
import { dedupeFiles } from './dedupe'
import { scanDirectory } from './scanner'
import { ulid } from '../utils/id'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** 16KB：首 4KB + 中 8KB + 末 4KB */
const BIG_SIZE = 16 * 1024

function write(file: string, content: string | Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

export async function runDedupeSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const base = join(app.getPath('temp'), `ctext-dedupe-smoke-${Date.now()}`)
  mkdirSync(base, { recursive: true })
  const { db } = openDatabase(join(base, 'dedupe.db'))

  try {
    const rootA = join(base, 'root-a')
    const rootB = join(base, 'root-b')

    // ---------- 指纹基线 ----------
    write(join(rootA, 'book.txt'), 'same content')
    write(join(rootB, 'copy.txt'), 'same content')
    write(join(rootA, 'other.txt'), 'different content')
    write(join(rootA, 'padded.txt'), 'same content ')

    const f1 = await fingerprintFile(join(rootA, 'book.txt'))
    const f2 = await fingerprintFile(join(rootB, 'copy.txt'))
    const f3 = await fingerprintFile(join(rootA, 'other.txt'))
    const f4 = await fingerprintFile(join(rootA, 'padded.txt'))

    check('相同内容得到相同指纹', f1.hash === f2.hash, f1.hash.slice(0, 12))
    check('不同内容得到不同指纹', f1.hash !== f3.hash, `${f1.hash.slice(0, 8)} vs ${f3.hash.slice(0, 8)}`)
    check('长度不同则指纹不同', f1.hash !== f4.hash, `${f1.size} vs ${f4.size}`)
    check('指纹为 40 位小写 hex', /^[0-9a-f]{40}$/.test(f1.hash), f1.hash)
    check('指纹带上文件大小', f1.size === 12, String(f1.size))

    // ---------- 小文件（首末重叠） ----------
    const tiny = await fingerprintFile(join(rootA, 'book.txt'))
    check('小文件首末块重叠不重复读', tiny.size === f1.size && tiny.hash === f1.hash, '与基线一致')

    // ---------- 已知盲区 ----------
    const head = Buffer.alloc(4096, 0x41)
    const tail = Buffer.alloc(4096, 0x43)
    const bigA = Buffer.concat([head, Buffer.alloc(8192, 0x42), tail])
    const bigB = Buffer.concat([head, Buffer.alloc(8192, 0x5a), tail])
    write(join(rootA, 'big-a.txt'), bigA)
    write(join(rootA, 'big-b.txt'), bigB)

    const fbA = await fingerprintFile(join(rootA, 'big-a.txt'))
    const fbB = await fingerprintFile(join(rootA, 'big-b.txt'))
    check(
      '已知盲区：首末相同的大文件 quick 指纹碰撞',
      fbA.size === BIG_SIZE && fbA.hash === fbB.hash,
      'size 与首末块一致 → 同指纹（刻意取舍）'
    )
    check('fullSha1 能区分首末相同的大文件', (await fullSha1(join(rootA, 'big-a.txt'))) !== (await fullSha1(join(rootA, 'big-b.txt'))), '全文摘要不同')

    // ---------- 去重：批内 ----------
    write(join(rootA, 'dup-1.txt'), 'duplicated body')
    write(join(rootA, 'dup-2.txt'), 'duplicated body')
    write(join(rootA, 'empty.txt'), '')

    const rootId = ulid()
    db.prepare(
      `INSERT INTO library_roots (id, label, path, state, sort, created_at) VALUES (?, 'A', ?, 'online', 0, ?)`
    ).run(rootId, rootA, Date.now())

    const scanned = await scanDirectory(rootA)
    const first = await dedupeFiles(rootId, scanned.files, { db })

    const kindOf = (relPath: string) => first.entries.find((e) => e.file.relPath === relPath)?.kind
    check('批内同内容第二次出现判为 batch 重复', kindOf('dup-2.txt') === 'duplicate-in-batch', String(kindOf('dup-2.txt')))
    check(
      'batch 重复指向先出现的那个',
      first.entries.find((e) => e.file.relPath === 'dup-2.txt')?.duplicateOf === 'dup-1.txt',
      String(first.entries.find((e) => e.file.relPath === 'dup-2.txt')?.duplicateOf)
    )
    check('批内首次出现判为 new', kindOf('dup-1.txt') === 'new', String(kindOf('dup-1.txt')))
    check('空文件单独归类', kindOf('empty.txt') === 'empty', String(kindOf('empty.txt')))
    check(
      '空文件不进 unique / duplicates',
      first.unique.every((e) => e.kind === 'new') && !first.duplicates.some((e) => e.file.relPath === 'empty.txt'),
      `unique=${first.unique.length} duplicates=${first.duplicates.length} empty=${first.stats.empty}`
    )
    check(
      'unique 与 duplicates 无交集',
      first.unique.length + first.duplicates.length + first.stats.empty + first.stats.failed === first.stats.total,
      `${first.unique.length}+${first.duplicates.length}+${first.stats.empty}+${first.stats.failed}=${first.stats.total}`
    )

    // ---------- 去重：库内（跨根） ----------
    const seedHash = first.entries.find((e) => e.file.relPath === 'book.txt')?.hash
    check('新书拿到了指纹', typeof seedHash === 'string', String(seedHash).slice(0, 12))

    if (seedHash) {
      const now = Date.now()
      db.prepare(
        `INSERT INTO books (id, title, format, root_id, rel_path, file_hash, size_bytes, source_type, created_at, updated_at)
         VALUES (?, '已导入的书', 'txt', ?, 'book.txt', ?, 12, 'local', ?, ?)`
      ).run(ulid(), rootId, seedHash, now, now)
    }

    const second = await dedupeFiles(rootId, scanned.files, { db })
    const kindOf2 = (relPath: string) => second.entries.find((e) => e.file.relPath === relPath)?.kind
    check('同根同 rel_path 判为 existing-path', kindOf2('book.txt') === 'existing-path', String(kindOf2('book.txt')))
    check(
      'existing-path 给出命中的书籍',
      second.entries.find((e) => e.file.relPath === 'book.txt')?.existing?.title === '已导入的书',
      second.entries.find((e) => e.file.relPath === 'book.txt')?.existing?.title ?? '无'
    )

    // 跨根：把同一份内容放到另一个根目录下
    const rootBId = ulid()
    db.prepare(
      `INSERT INTO library_roots (id, label, path, state, sort, created_at) VALUES (?, 'B', ?, 'online', 1, ?)`
    ).run(rootBId, rootB, Date.now())
    write(join(rootB, 'copy.txt'), 'same content')
    const scannedB = await scanDirectory(rootB)
    const third = await dedupeFiles(rootBId, scannedB.files, { db })
    const crossEntry = third.entries.find((e) => e.file.relPath === 'copy.txt')
    check('另一根目录下同内容判为 duplicate-in-db', crossEntry?.kind === 'duplicate-in-db', String(crossEntry?.kind))
    check(
      'duplicate-in-db 指出已有书籍的路径',
      crossEntry?.existing?.relPath === 'book.txt',
      crossEntry?.existing?.relPath ?? '无'
    )

    // ---------- 删除后不再命中 ----------
    db.prepare('UPDATE books SET deleted_at = ? WHERE rel_path = ?').run(Date.now(), 'book.txt')
    const fourth = await dedupeFiles(rootId, scanned.files, { db })
    check(
      '软删除的书不再参与去重',
      fourth.entries.find((e) => e.file.relPath === 'book.txt')?.kind === 'new',
      String(fourth.entries.find((e) => e.file.relPath === 'book.txt')?.kind)
    )

    // ---------- 分批查询（跨过 400 的批边界） ----------
    const bulk = join(base, 'bulk')
    mkdirSync(bulk, { recursive: true })
    const BULK = 450
    for (let i = 0; i < BULK; i++) writeFileSync(join(bulk, `f${String(i).padStart(3, '0')}.txt`), `bulk-content-${i}`)

    const bulkRootId = ulid()
    db.prepare(
      `INSERT INTO library_roots (id, label, path, state, sort, created_at) VALUES (?, 'BULK', ?, 'online', 2, ?)`
    ).run(bulkRootId, bulk, Date.now())

    const bulkScan = await scanDirectory(bulk)
    const bulkFirst = await dedupeFiles(bulkRootId, bulkScan.files, { db })
    check(`批量 ${BULK} 个文件全部判为 new`, bulkFirst.stats.unique === BULK, `unique=${bulkFirst.stats.unique}`)

    // 把前 300 个写进库，重跑应当命中 300 个
    const SEEDED = 300
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO books (id, title, format, root_id, rel_path, file_hash, size_bytes, source_type, created_at, updated_at)
       VALUES (?, ?, 'txt', ?, ?, ?, ?, 'local', ?, ?)`
    )
    db.transaction(() => {
      for (const entry of bulkFirst.unique.slice(0, SEEDED)) {
        insert.run(
          ulid(),
          entry.file.relPath,
          bulkRootId,
          entry.file.relPath,
          entry.hash as string,
          entry.file.size,
          now,
          now
        )
      }
    })()

    const bulkSecond = await dedupeFiles(bulkRootId, bulkScan.files, { db })
    check(
      `跨越 ${400} 批边界仍能全部命中（${SEEDED} 条）`,
      bulkSecond.stats.existingPath === SEEDED,
      `existingPath=${bulkSecond.stats.existingPath}`
    )
    check(
      '未入库的部分仍是 new',
      bulkSecond.stats.unique === BULK - SEEDED,
      `unique=${bulkSecond.stats.unique}`
    )
    check(
      '批量去重耗时可控',
      bulkSecond.stats.elapsedMs < 5000,
      `${bulkSecond.stats.elapsedMs}ms（${BULK} 个文件）`
    )

    // ---------- 失败项 ----------
    const ghost = await dedupeFiles(rootId, [
      { relPath: 'ghost.txt', absPath: join(base, 'nope.txt'), size: 10, mtimeMs: 0 }
    ], { db })
    check(
      '读不了的文件记为 failed 而不是抛异常',
      ghost.entries[0]?.kind === 'failed',
      ghost.entries[0]?.kind ?? '无'
    )
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    try {
      db.close()
    } catch {
      // 库已关闭或从未打开，忽略
    }
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响结论
    }
  }

  return checks
}
