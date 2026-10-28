/**
 * M1 出口验收（开发计划 §4「M1 出口检查」）。
 *
 * 四条出口标准在 M1 阶段的落点：
 *   1. 500 本目录一键导入零人工 → 本文件：真实建 500 个 TXT（5 个子目录），
 *      走完整链路（扫描 → 指纹 → Python 解析 → 分批落库），断言 0 失败、
 *      0 跳过、章节目录完整。**不模拟**，用的是 UI 同一个 startImport。
 *   2. 拔盘后书籍保留 → 重命名目录模拟拔盘，断言根目录 state=offline、
 *      书籍总数不变、列表里的 offline 标记为真（角标/横幅由 verify:ui 覆盖）。
 *   3. 插回自动恢复 → 目录改名回来后 checkAllRoots，断言回到 online。
 *   4. 万级列表流畅 → 由 verify:list 单独覆盖（1 万本 60fps + P95），本文件不重复。
 *
 * 「点击提示正确」这条要等 M2 阅读器：M1 阶段还没有「打开书本」这个动作，
 * 能验到的是离线书籍仍列出且带离线标记。
 *
 * 只在 !app.isPackaged && CTEXT_M1_SMOKE=1 时执行（临时库 + 临时目录）。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getDb } from '../db/connection'
import { listBooks } from '../db/repositories/books'
import { rootsRepo } from '../db/repositories/roots'
import { getTaskSnapshot, startImport } from '../library/import-task'
import { checkAllRoots } from '../library/roots-monitor'
import { scanDirectory } from '../library/scanner'
import { coversDir } from '../ipc/import'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const TOTAL_BOOKS = 500
const SUBDIRS = 5
const CHAPTERS = 10

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** 章节格式与 import-smoke 对齐：「第N章 标题」+ 作者/简介行在首章之前 */
function bookText(seed: number): string {
  const lines = [`作者：作者 ${seed % 37}`, `简介：M1 出口验收样本 ${seed}，共 ${CHAPTERS} 章。`]
  for (let i = 1; i <= CHAPTERS; i += 1) {
    lines.push(`第${i}章 标题${i}`)
    // 每本正文长度不同 → 大小不同 → 指纹不同，不会被批内去重误杀
    lines.push(`这是第${i}章的正文（样本 ${seed}）。${'内容写长一点，让编码探测有足够样本。'.repeat(3 + (seed % 3))}`)
  }
  return `${lines.join('\n')}\n`
}

function makeLibrary(dir: string): number {
  const perDir = TOTAL_BOOKS / SUBDIRS
  let written = 0
  for (let d = 0; d < SUBDIRS; d += 1) {
    const sub = join(dir, `卷 ${d + 1}`)
    mkdirSync(sub, { recursive: true })
    for (let i = 0; i < perDir; i += 1) {
      const index = d * perDir + i
      writeFileSync(join(sub, `书籍 ${pad(index, 3)}.txt`), bookText(index), 'utf8')
      written += 1
    }
  }
  return written
}

/** 轮询任务快照直到收尾（导入是异步的，进度只走事件，没有 promise 可等） */
async function waitForTask(taskId: string, timeoutMs: number): Promise<string> {
  const terminal = new Set(['done', 'cancelled', 'failed'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = getTaskSnapshot(taskId)
    if (snapshot && terminal.has(snapshot.phase)) return snapshot.phase
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return 'timeout'
}

export async function runM1Smoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const dir = process.env['CTEXT_M1_DIR']
  if (!dir) {
    check('收到样本目录', false, '缺少 CTEXT_M1_DIR')
    return checks
  }

  const db = getDb()
  const written = makeLibrary(dir)
  check('样本就位：500 个 TXT（5 个子目录）', written === TOTAL_BOOKS, `${written} 个`)

  const scan = await scanDirectory(dir)
  check(
    '扫描到 500 个文件（白名单 + 忽略规则不误伤）',
    scan.files.length === TOTAL_BOOKS,
    `${scan.files.length} 个 / 目录 ${scan.stats.dirs} / 忽略 ${scan.stats.skippedIgnored} 深度 ${scan.stats.skippedDepth} 扩展名 ${scan.stats.skippedExtension}`
  )

  // ---------------------------------------------------------------- 1. 一键导入
  const t0 = Date.now()
  const { taskId } = startImport(dir, {}, { coversDir: coversDir() })
  const phase = await waitForTask(taskId, 240_000)
  const elapsed = Date.now() - t0
  const snapshot = getTaskSnapshot(taskId)
  check('导入在时限内收尾', phase === 'done', `${phase}，${(elapsed / 1000).toFixed(1)}s`)

  const imported = snapshot?.imported ?? 0
  const failed = snapshot?.failedTotal ?? -1
  const skipped = snapshot?.skipped ?? -1
  check(
    '500 本全部入库且零人工（无失败/无跳过）',
    imported === TOTAL_BOOKS && failed === 0 && skipped === 0,
    `新增 ${imported} / 失败 ${failed} / 跳过 ${skipped} / 队列 ${snapshot?.total ?? -1} / 处理 ${snapshot?.processed ?? -1}`
  )

  const listed = listBooks(db, { offset: 0, limit: 5 })
  check('书库计数 = 500', listed.total === TOTAL_BOOKS, `${listed.total} 本`)

  const chapters = db
    .prepare('SELECT MIN(chapter_count) AS min, MAX(chapter_count) AS max FROM books WHERE deleted_at IS NULL')
    .get() as { min: number; max: number }
  check(
    '每本都解析出完整章节目录',
    chapters.min === CHAPTERS && chapters.max === CHAPTERS,
    `章数 ${chapters.min}~${chapters.max}（期望 ${CHAPTERS}）`
  )

  const roots = rootsRepo(db).list()
  check('根目录已登记且只有 1 个', roots.length === 1 && roots[0]?.state === 'online', `${roots.length} 个 / ${roots[0]?.state ?? '-'}`)

  // ---------------------------------------------------------------- 2. 拔盘
  const detached = `${dir}-unplugged`
  renameSync(dir, detached)
  await checkAllRoots({ reason: 'manual', forceTouch: true })

  const afterUnplug = rootsRepo(db).list()
  check('拔盘后根目录转为离线', afterUnplug[0]?.state === 'offline', afterUnplug[0]?.state ?? '无根目录')

  const keptPage = listBooks(db, { offset: 0, limit: 5 })
  check('拔盘后书籍一条不少', keptPage.total === TOTAL_BOOKS, `${keptPage.total} 本`)
  check(
    '离线书籍带 offline 标记',
    keptPage.items.length > 0 && keptPage.items.every((book) => book.offline),
    `${keptPage.items.filter((book) => book.offline).length}/${keptPage.items.length}`
  )

  // ---------------------------------------------------------------- 3. 插回
  renameSync(detached, dir)
  await checkAllRoots({ reason: 'manual', forceTouch: true })

  const afterPlug = rootsRepo(db).list()
  check('插回后根目录恢复在线', afterPlug[0]?.state === 'online', afterPlug[0]?.state ?? '无根目录')
  const backPage = listBooks(db, { offset: 0, limit: 5 })
  check(
    '恢复后 offline 标记清除',
    backPage.total === TOTAL_BOOKS && backPage.items.every((book) => !book.offline),
    `${backPage.total} 本`
  )

  for (const item of checks) {
    console.log(`SMOKE M1 ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failedCount = checks.filter((item) => !item.ok).length
  console.log(`SMOKE M1 SUMMARY ${checks.length - failedCount}/${checks.length}`)
  app.exit(failedCount === 0 ? 0 : 1)
  return checks
}
