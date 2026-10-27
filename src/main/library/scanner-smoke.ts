/**
 * M1-02 自检：目录扫描器。
 *
 * 纯主进程断言，**不需要窗口**——扫描器不依赖 Electron 也不碰数据库，
 * 这样一次验收只要几百毫秒，改扫描逻辑时能高频跑。
 *
 * 目录树是现造的：
 *   tree/   结构用例（扩展名白名单、深度上限、忽略规则、符号链接防环）
 *   flat/   性能用例（1000 个文件）
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_MAX_DEPTH, parentOf, baseNameOf, resolveRelPath, scanDirectory } from './scanner'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const PERFORMANCE_FILE_COUNT = 1000
const PERFORMANCE_BUDGET_MS = 3000

function touch(file: string, content = 'x'): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

/** 结构用例树。返回创建过程中遇到的非致命问题（例如 junction 建不了） */
function buildTree(base: string): string[] {
  const notes: string[] = []
  const tree = join(base, 'tree')

  touch(join(tree, 'a.txt'))
  touch(join(tree, 'b.EPUB')) // 大小写不敏感
  touch(join(tree, 'c.pdf'))
  touch(join(tree, 'd.mobi'))
  touch(join(tree, 'no-ext'))

  touch(join(tree, 'sub1', 'e.txt'))
  touch(join(tree, 'sub1', 'sub2', 'f.txt'))
  touch(join(tree, 'sub1', 'sub2', 'sub3', 'g.epub'))

  touch(join(tree, 'node_modules', 'pkg', 'readme.txt'))
  touch(join(tree, '.git', 'config.txt'))
  touch(join(tree, '$RECYCLE.BIN', 'junk.txt'))

  // 深层目录：从 depth=9 起都该被 maxDepth=8 挡掉
  let deep = join(tree, 'deep')
  for (let i = 1; i <= 10; i++) {
    deep = join(deep, `d${i}`)
    touch(join(deep, `level${i}.txt`))
  }

  // 指向自身的 junction 形成环。不跟随符号链接就不会进去
  try {
    symlinkSync(tree, join(tree, 'loop'), 'junction')
  } catch (err) {
    notes.push(`junction 创建失败：${err instanceof Error ? err.message : String(err)}`)
  }

  return notes
}

/** 性能用例：1000 个扁平文件 */
function buildFlat(base: string): string {
  const flat = join(base, 'flat')
  mkdirSync(flat, { recursive: true })
  for (let i = 0; i < PERFORMANCE_FILE_COUNT; i++) {
    writeFileSync(join(flat, `book-${String(i).padStart(4, '0')}.txt`), 'x'.repeat(16))
  }
  return flat
}

export async function runScannerSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const base = join(app.getPath('temp'), `ctext-scan-smoke-${Date.now()}`)

  try {
    const notes = buildTree(base)
    const tree = join(base, 'tree')

    // ---------- 结构 ----------
    const structure = await scanDirectory(tree)
    const rels = structure.files.map((f) => f.relPath)

    check(
      '收下白名单扩展名（含大写 .EPUB）',
      rels.includes('a.txt') && rels.includes('b.EPUB'),
      rels.filter((r) => /\.(txt|epub|EPUB)$/i.test(r)).join(' ')
    )
    check(
      '拒绝非白名单扩展名',
      !rels.includes('c.pdf') && !rels.includes('d.mobi') && !rels.includes('no-ext'),
      `skippedExtension=${structure.stats.skippedExtension}`
    )
    check(
      '忽略 node_modules / .git / 回收站',
      !rels.some((r) => r.startsWith('node_modules/') || r.startsWith('.git/') || r.startsWith('$RECYCLE.BIN/')),
      `skippedIgnored=${structure.stats.skippedIgnored}`
    )
    check(
      'rel_path 一律用 / 分隔',
      rels.every((r) => !r.includes('\\')),
      rels.find((r) => r.includes('\\')) ?? '全部合规'
    )
    check(
      '结果按 relPath 升序',
      rels.every((r, i) => i === 0 || rels[i - 1] <= r),
      `${rels.length} 项`
    )

    // 深度：root 自身是第 0 层，deep 是第 1 层，d1 是第 2 层 … d7 是第 8 层，d8 已是第 9 层
    check('收下 depth=3 的文件', rels.includes('sub1/sub2/sub3/g.epub'), 'sub1/sub2/sub3/g.epub')
    check(
      '第 8 层子目录内的文件被收下',
      rels.includes('deep/d1/d2/d3/d4/d5/d6/d7/level7.txt'),
      `skippedDepth=${structure.stats.skippedDepth}`
    )
    check(
      '第 9 层子目录不再进入',
      !rels.some((r) => r.includes('/d8/')),
      rels.find((r) => r.includes('/d8/')) ?? '未进入 d8'
    )

    // ---------- 符号链接 ----------
    check(
      '符号链接不跟随（统计到跳过数）',
      structure.stats.skippedSymlink >= 1,
      `skippedSymlink=${structure.stats.skippedSymlink}`
    )
    check(
      '环状链接未导致重复或爆炸',
      new Set(rels).size === rels.length && rels.length < 100,
      `${rels.length} 项，去重后 ${new Set(rels).size}`
    )
    if (notes.length > 0) {
      check('junction 创建（非致命）', true, notes.join('; '))
    }

    // ---------- 元信息 ----------
    const a = structure.files.find((f) => f.relPath === 'a.txt')
    check('记录文件大小', a?.size === 1, `${a?.size}`)
    check('记录 mtime', typeof a?.mtimeMs === 'number' && a.mtimeMs > 0, `${a?.mtimeMs}`)

    // ---------- 选项 ----------
    const shallow = await scanDirectory(tree, { maxDepth: 0 })
    check(
      'maxDepth=0 只扫根层',
      shallow.files.every((f) => !f.relPath.includes('/')),
      `${shallow.files.length} 项，skippedDepth=${shallow.stats.skippedDepth}`
    )
    check(
      'maxDepth=0 时根层文件仍在',
      shallow.files.some((f) => f.relPath === 'a.txt'),
      shallow.files.map((f) => f.relPath).join(' ')
    )

    const onlyTxt = await scanDirectory(tree, { extensions: ['.txt'] })
    check(
      '扩展名白名单可覆盖',
      onlyTxt.files.every((f) => f.relPath.toLowerCase().endsWith('.txt')),
      `${onlyTxt.files.length} 项`
    )

    const noIgnore = await scanDirectory(tree, { ignore: [] })
    check(
      '忽略规则可清空',
      noIgnore.files.some((f) => f.relPath.startsWith('node_modules/')),
      `skippedIgnored=${noIgnore.stats.skippedIgnored}`
    )

    const truncated = await scanDirectory(tree, { maxFiles: 3 })
    check(
      'maxFiles 触发截断',
      truncated.stats.truncated && truncated.files.length === 3,
      `files=${truncated.files.length} truncated=${truncated.stats.truncated}`
    )

    // ---------- 取消 ----------
    const controller = new AbortController()
    controller.abort()
    const cancelled = await scanDirectory(tree, { signal: controller.signal })
    check(
      '已取消的信号立即返回',
      cancelled.stats.cancelled && cancelled.files.length === 0,
      `cancelled=${cancelled.stats.cancelled} files=${cancelled.files.length}`
    )

    // ---------- 不存在的根 ----------
    const missing = await scanDirectory(join(base, 'nope'))
    check(
      '根目录不存在时记录错误而不抛异常',
      missing.files.length === 0 && missing.stats.unreadable.length === 1,
      missing.stats.unreadable[0]?.relPath ?? '未记录'
    )

    // ---------- 路径工具 ----------
    check('parentOf 取父目录', parentOf('a/b/c.txt') === 'a/b', parentOf('a/b/c.txt'))
    check('parentOf 顶层返回空串', parentOf('a.txt') === '', JSON.stringify(parentOf('a.txt')))
    check('baseNameOf 取文件名', baseNameOf('a/b/c.txt') === 'c.txt', baseNameOf('a/b/c.txt'))
    check(
      'resolveRelPath 还原绝对路径',
      resolveRelPath(tree, 'sub1/e.txt').toLowerCase() === join(tree, 'sub1', 'e.txt').toLowerCase(),
      resolveRelPath(tree, 'sub1/e.txt').toLowerCase() === join(tree, 'sub1', 'e.txt').toLowerCase()
        ? '与 join 结果一致'
        : '不一致'
    )
    check('默认深度为 8', DEFAULT_MAX_DEPTH === 8, String(DEFAULT_MAX_DEPTH))

    // ---------- 性能 ----------
    const flat = buildFlat(base)
    const perf = await scanDirectory(flat)
    check(
      `扫描 ${PERFORMANCE_FILE_COUNT} 个文件全部命中`,
      perf.files.length === PERFORMANCE_FILE_COUNT,
      `${perf.files.length} 个`
    )
    check(
      `扫描 ${PERFORMANCE_FILE_COUNT} 个文件 ≤${PERFORMANCE_BUDGET_MS}ms`,
      perf.stats.elapsedMs <= PERFORMANCE_BUDGET_MS,
      `${perf.stats.elapsedMs}ms`
    )
    check(
      '性能用例按文件名有序',
      perf.files[0]?.relPath === 'book-0000.txt' && perf.files.at(-1)?.relPath === 'book-0999.txt',
      `${perf.files[0]?.relPath} … ${perf.files.at(-1)?.relPath}`
    )
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响断言结论
    }
  }

  return checks
}
