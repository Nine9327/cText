/**
 * M1-06 导入队列自检。
 *
 * 全部在**真实主进程**里跑：真 SQLite（独立的临时库）、真 Python worker、真文件系统。
 * 唯一被替换掉的是「窗口」——进度通过 `subscribeImportProgress` 观测，
 * 断言的是同一个 DTO，不额外造一套假事件。
 *
 * 覆盖七组场景：
 *   预览分类 · 首次导入 · 重复导入不产生脏数据 · overwrite 覆盖 · 单本失败隔离
 *   取消后数据一致 · 子目录导入与 registerAsRoot 语义
 *
 * 只在 `!app.isPackaged && CTEXT_IMPORT_SMOKE=1` 时执行。
 * EPUB 样本由 `scripts/verify-import.mjs` 用 `smoke_epub.py --emit` 预先铺好，
 * 通过 `CTEXT_IMPORT_SAMPLES` 传进来。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { openDatabase, type Db } from '../db/connection'
import { booksRepo } from '../db/repositories/books'
import { rootsRepo } from '../db/repositories/roots'
import { getPythonBridge } from '../bridge'
import {
  buildScanPreview,
  cancelImport,
  getTaskSnapshot,
  startImport,
  subscribeImportProgress,
  type ImportRuntimeOptions
} from './import-task'
import type { ImportProgressDTO } from '@shared/dto'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 生成一本带 n 章的 TXT。章节标记走的是强档正则，能稳定识别。
 *
 * `seed` 必须每本不同：M1-03 的指纹只取「大小 + 首尾各 4KB」，
 * 两本内容完全相同的书会被判成批内重复而跳过——那正是要去重的行为，
 * 但它会让「导入 N 本」这类断言莫名其妙地少几本。
 */
function bookText(chapters: number, author = '张三', seed = '默认'): string {
  const lines = [`作者：${author}`, `简介：自检样本 ${seed}，共 ${chapters} 章。`]
  for (let i = 1; i <= chapters; i += 1) {
    lines.push(`第${i}章 标题${i}`)
    lines.push(`这是第${i}章的正文（${seed}），内容写得长一点，让编码探测有足够的样本可以收敛。`)
  }
  return `${lines.join('\n')}\n`
}

function writeTxt(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
}

export async function runImportSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const base = join(app.getPath('temp'), `ctext-import-smoke-${Date.now()}`)
  const coversDir = join(base, 'covers')
  const samples = process.env['CTEXT_IMPORT_SAMPLES']
  let db: Db | null = null
  let unsubscribe: (() => void) | null = null
  let events: ImportProgressDTO[] = []

  try {
    mkdirSync(base, { recursive: true })
    db = openDatabase(join(base, 'smoke.db')).db
    const repo = rootsRepo(db)
    const books = booksRepo(db)

    const runtime: ImportRuntimeOptions = { db, coversDir }

    const bridge = getPythonBridge()
    bridge.start()
    const readyDeadline = Date.now() + 15_000
    while (bridge.getStatus().state !== 'ready' && Date.now() < readyDeadline) await sleep(40)
    check('worker 就绪', bridge.getStatus().state === 'ready', bridge.getStatus().state)
    if (bridge.getStatus().state !== 'ready') return checks

    unsubscribe = subscribeImportProgress((dto) => events.push(dto))

    /** 等任务结束；返回最终快照 */
    const waitTask = async (taskId: string, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const snapshot = getTaskSnapshot(taskId)
        if (snapshot && (snapshot.phase === 'done' || snapshot.phase === 'cancelled' || snapshot.phase === 'failed')) {
          return snapshot
        }
        await sleep(20)
      }
      return getTaskSnapshot(taskId)
    }

    // ---------------------------------------------------------------- 场景 A：预览 + 首次导入
    const rootA = join(base, 'A')
    mkdirSync(join(rootA, 'sub'), { recursive: true })
    writeTxt(join(rootA, '斗破苍穹 - 天蚕土豆.txt'), bookText(3, '天蚕土豆', 'A1'))
    writeTxt(join(rootA, '凡人修仙传_忘语.txt'), bookText(2, '忘语', 'A2'))
    writeTxt(join(rootA, 'sub', '嵌套目录的书.txt'), bookText(4, '李四', 'A3'))
    writeFileSync(join(rootA, '空文件.txt'), '')
    writeFileSync(join(rootA, '不支持.pdf'), '%PDF-1.4 fake')

    const hasSamples = Boolean(samples && existsSync(samples))
    check('EPUB 样本目录可用', hasSamples, samples ?? '未设置')
    const importedEpub = hasSamples ? ['toc_volume.epub', 'cover_meta.epub'].filter((n) => existsSync(join(samples!, n))) : []
    for (const name of importedEpub) copyFileSync(join(samples!, name), join(rootA, name))

    repo.create({ label: 'A 库', path: rootA })

    const preview = await buildScanPreview(rootA, {}, db)
    const byStatus = (status: string) => preview.items.filter((item) => item.status === status)
    check('预览统计 new（3 txt + 2 epub）', byStatus('new').length === 3 + importedEpub.length, String(byStatus('new').length))
    check('预览识别不支持的格式', byStatus('unsupported').length === 1, String(byStatus('unsupported').length))
    check('预览识别空文件', byStatus('empty').length === 1, String(byStatus('empty').length))
    check('预览未产生重复项', byStatus('duplicate').length === 0, String(byStatus('duplicate').length))
    check('预览 total 与条目数一致', preview.total === preview.items.length, `${preview.total}/${preview.items.length}`)
    check('预览不写库', books.count() === 0, String(books.count()))
    check('预览的 rel_path 相对根目录', preview.items.every((item) => !item.relPath.includes(':')), '无盘符')

    events = []
    const first = startImport(rootA, {}, runtime)
    const firstResult = await waitTask(first.taskId)
    check('首次导入完成', firstResult?.phase === 'done', String(firstResult?.phase))
    const expectNew = 3 + importedEpub.length
    check('首次导入数量正确', firstResult?.imported === expectNew, `imported=${firstResult?.imported} 期望 ${expectNew}`)
    check('空文件计入 skipped', firstResult?.skipped === 1, String(firstResult?.skipped))
    check('首次导入无失败', firstResult?.failedTotal === 0, JSON.stringify(firstResult?.failures))
    check('库中书籍数正确', books.count() === expectNew, String(books.count()))
    check('没有孤儿子章节', books.orphanChapters() === 0, String(books.orphanChapters()))

    // 进度事件：阶段完整、processed 单调、最终值与快照一致
    const phases = events.map((e) => e.phase)
    check('进度事件包含 scan 阶段', phases.includes('scan'), phases.join('>'))
    check('进度事件包含 parse 阶段', phases.includes('parse'), phases.join('>'))
    check('进度事件以终态收尾', phases[phases.length - 1] === 'done', phases[phases.length - 1] ?? '无')
    check(
      'processed 单调不减',
      events.every((e, i) => i === 0 || e.processed >= events[i - 1].processed),
      '是'
    )
    const lastEvent = events[events.length - 1]
    check('最终事件的 imported 与快照一致', lastEvent?.imported === firstResult?.imported, `${lastEvent?.imported}/${firstResult?.imported}`)

    // 章节与 anchor 的语义：TXT 是字节偏移字符串，EPUB 是 zip 内路径
    const txtBook = db
      .prepare("SELECT id, chapter_count FROM books WHERE rel_path = '斗破苍穹 - 天蚕土豆.txt'")
      .get() as { id: string; chapter_count: number } | undefined
    check('TXT 书章节数正确', txtBook?.chapter_count === 3, String(txtBook?.chapter_count))
    if (txtBook) {
      const chapters = db
        .prepare('SELECT idx, anchor, length, level FROM chapters WHERE book_id = ? ORDER BY idx')
        .all(txtBook.id) as { idx: number; anchor: string; length: number; level: number }[]
      check('TXT anchor 是字节偏移', chapters.every((c) => /^\d+$/.test(c.anchor)), chapters.map((c) => c.anchor).join(','))
      // 首章之前是「作者/简介」两行，所以首章 offset 不是 0——
      // 断言的真实语义是「offset 与文件里标记出现的字节位置一致」
      const rawBytes = readFileSync(join(rootA, '斗破苍穹 - 天蚕土豆.txt'))
      const markAt = rawBytes.indexOf(Buffer.from('第1章', 'utf8'))
      check(
        'TXT 首章 offset 与文件中标记位置一致',
        chapters[0]?.anchor === String(markAt),
        `${chapters[0]?.anchor}/${markAt}`
      )
      check('TXT 章节有字节长度', chapters.every((c) => c.length > 0), '是')
      check('TXT 章节 level 为 1', chapters.every((c) => c.level === 1), chapters.map((c) => c.level).join(','))
      const coverRow = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(txtBook.id) as
        | { cover_path: string | null }
        | undefined
      check('TXT 不抽封面（M1-07 才生成占位）', coverRow?.cover_path === null, String(coverRow?.cover_path))
    }

    if (importedEpub.includes('toc_volume.epub')) {
      const epubBook = db
        .prepare("SELECT id, chapter_count FROM books WHERE rel_path = 'toc_volume.epub'")
        .get() as { id: string; chapter_count: number } | undefined
      check('EPUB 书章节数正确（卷章结构 6 条）', epubBook?.chapter_count === 6, String(epubBook?.chapter_count))
      if (epubBook) {
        const anchors = db
          .prepare('SELECT anchor FROM chapters WHERE book_id = ? ORDER BY idx')
          .all(epubBook.id) as { anchor: string }[]
        check('EPUB anchor 是 zip 内路径', anchors.every((c) => c.anchor.startsWith('OEBPS/')), anchors[0]?.anchor ?? '无')
      }
    }

    if (importedEpub.includes('cover_meta.epub')) {
      const row = db.prepare("SELECT cover_path FROM books WHERE rel_path = 'cover_meta.epub'").get() as
        | { cover_path: string | null }
        | undefined
      check('EPUB 封面被抽出入库', Boolean(row?.cover_path) && !String(row?.cover_path).includes(':'), String(row?.cover_path))
    }

    // ---------------------------------------------------------------- 场景 B：重复导入不产生脏数据
    events = []
    const again = await waitTask(startImport(rootA, {}, runtime).taskId)
    check('重复导入全部跳过', again?.skipped === expectNew + 1, `skipped=${again?.skipped}`)
    check('重复导入不新增', again?.imported === 0, String(again?.imported))
    check('重复导入后书数不变', books.count() === expectNew, String(books.count()))
    check('重复导入无失败', again?.failedTotal === 0, JSON.stringify(again?.failures))

    // ---------------------------------------------------------------- 场景 C：overwrite 覆盖
    const overwritePath = join(rootA, '凡人修仙传_忘语.txt')
    const target = books.findByRootAndRelPath(repo.findByPath(rootA)!.id, '凡人修仙传_忘语.txt')!
    // 模拟用户「换了更好的版本」：章节变多、作者变了，同时手动标了收藏与进度
    db.prepare("UPDATE books SET favorite = 1, progress = 0.5, read_state = 'reading' WHERE id = ?").run(target.id)
    writeTxt(overwritePath, bookText(5, '忘语本人', 'A2-new'))

    const overwritten = await waitTask(startImport(rootA, { onDuplicate: 'overwrite' }, runtime).taskId)
    check('overwrite 只覆盖同路径的那一本', overwritten?.updated === 1, `updated=${overwritten?.updated}`)
    check('overwrite 不新增记录', overwritten?.imported === 0, String(overwritten?.imported))
    check('overwrite 后书数不变', books.count() === expectNew, String(books.count()))
    // 内容没变的 4 本 + 空文件：都不该被重新解析一遍
    check('overwrite 跳过内容未变的书', overwritten?.skipped === expectNew, `skipped=${overwritten?.skipped}`)
    const after = db.prepare('SELECT id, title, author, chapter_count, favorite, progress FROM books WHERE id = ?').get(target.id) as
      | { id: string; title: string; author: string; chapter_count: number; favorite: number; progress: number }
      | undefined
    check('overwrite 更新了章节数', after?.chapter_count === 5, String(after?.chapter_count))
    check('overwrite 更新了作者', after?.author === '忘语本人', String(after?.author))
    check('overwrite 保留 id', after?.id === target.id, 'id 未变')
    check('overwrite 保留收藏', after?.favorite === 1, String(after?.favorite))
    check('overwrite 保留阅读进度', after?.progress === 0.5, String(after?.progress))
    const oldChapters = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(target.id) as { n: number }
    check('overwrite 替换而非追加章节', oldChapters.n === 5, String(oldChapters.n))

    // ---------------------------------------------------------------- 场景 D：单本失败不中断
    const rootD = join(base, 'D')
    mkdirSync(rootD, { recursive: true })
    writeTxt(join(rootD, '好书一.txt'), bookText(2, '张三', 'D1'))
    writeTxt(join(rootD, '好书二.txt'), bookText(2, '张三', 'D2'))
    writeFileSync(join(rootD, '坏书.epub'), Buffer.from('这不是一个 zip 文件'.repeat(10), 'utf8'))
    repo.create({ label: 'D 库', path: rootD })

    const failedTask = await waitTask(startImport(rootD, {}, runtime).taskId)
    check('坏书不影响其余导入', failedTask?.imported === 2, String(failedTask?.imported))
    check('失败清单记录 1 条', failedTask?.failedTotal === 1, String(failedTask?.failedTotal))
    const failure = failedTask?.failures[0]
    check('失败清单里的路径可复制（相对路径）', Boolean(failure?.relPath) && failure!.relPath === '坏书.epub', String(failure?.relPath))
    check('失败原因可读', /损坏|解析/.test(failure?.reason ?? ''), String(failure?.reason))

    // ---------------------------------------------------------------- 场景 E：取消后数据一致
    const rootE = join(base, 'E')
    mkdirSync(rootE, { recursive: true })
    for (let i = 0; i < 60; i += 1) {
      writeTxt(join(rootE, `book-${String(i).padStart(3, '0')}.txt`), bookText(6, '张三', `E${i}`))
    }
    repo.create({ label: 'E 库', path: rootE })

    let cancelled = false
    const cancelWatcher = subscribeImportProgress((dto) => {
      // progressIntervalMs=0 时每本书都会发一次事件，取消点因此是确定的
      if (!cancelled && dto.processed >= 12 && (dto.phase === 'parse' || dto.phase === 'commit')) {
        cancelled = true
        cancelImport(dto.taskId)
      }
    })
    const cancelTask = await waitTask(startImport(rootE, {}, { ...runtime, progressIntervalMs: 0 }).taskId)
    cancelWatcher()
    check('取消后任务进入 cancelled', cancelTask?.phase === 'cancelled', String(cancelTask?.phase))
    check('取消确实发生在中途', (cancelTask?.processed ?? 0) > 0 && (cancelTask?.processed ?? 0) < 60, `processed=${cancelTask?.processed}`)
    const importedInE = db
      .prepare("SELECT COUNT(*) AS n FROM books b JOIN library_roots r ON r.id = b.root_id WHERE r.label = 'E 库'")
      .get() as { n: number }
    check('取消后入库数量 = 报告的数量', importedInE.n === (cancelTask?.imported ?? -1), `${importedInE.n}/${cancelTask?.imported}`)
    check('取消后没有孤儿子章节', books.orphanChapters() === 0, String(books.orphanChapters()))
    const inconsistent = db
      .prepare(
        `SELECT COUNT(*) AS n FROM books b
         WHERE b.chapter_count <> (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id)`
      )
      .get() as { n: number }
    check('取消后每本书的章节数与实际行数一致', inconsistent.n === 0, `${inconsistent.n} 本不一致`)
    check('取消不产生半本书（WAL 下事务完整）', importedInE.n > 0, String(importedInE.n))

    // ---------------------------------------------------------------- 场景 F：子目录与 registerAsRoot
    const subRoot = join(rootA, 'sub')
    writeTxt(join(subRoot, '新增的书.txt'), bookText(2, '王五', 'F1'))
    const subTask = await waitTask(startImport(subRoot, {}, runtime).taskId)
    check('子目录导入成功', subTask?.imported === 1, String(subTask?.imported))
    const subBook = db
      .prepare("SELECT rel_path FROM books WHERE title LIKE '新增的书%'")
      .get() as { rel_path: string } | undefined
    check('子目录导入的 rel_path 相对根目录', subBook?.rel_path === 'sub/新增的书.txt', String(subBook?.rel_path))
    check('子目录导入不会新建根目录', repo.list().length === 3, String(repo.list().length))

    const orphanDir = join(base, 'no-root')
    mkdirSync(orphanDir, { recursive: true })
    try {
      startImport(orphanDir, { registerAsRoot: false }, runtime)
      check('未登记目录 + registerAsRoot=false 被拒', false, '未抛错')
    } catch (err) {
      check('未登记目录 + registerAsRoot=false 被拒', (err as { code?: string }).code === 'E_INVALID_ARGUMENT', String((err as { code?: string }).code))
    }

    // 非法忽略正则要立刻报错，而不是静默不生效
    try {
      startImport(rootA, { ignorePattern: '([' }, runtime)
      check('非法忽略正则被拒', false, '未抛错')
    } catch (err) {
      check('非法忽略正则被拒', (err as { code?: string }).code === 'E_INVALID_ARGUMENT', String((err as { code?: string }).code))
    }
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    unsubscribe?.()
    try {
      db?.close()
    } catch {
      // 关不掉不影响结论
    }
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响结论
    }
  }

  return checks
}
