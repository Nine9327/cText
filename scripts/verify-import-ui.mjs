/**
 * M1-07 导入交互验收脚本。
 *
 * 三段：
 *   1. 构建 out/
 *   2. 造两个样本目录（小目录验分类与结果，60 本大目录验取消）
 *   3. 起一次 Electron 跑 `import-ui-smoke.ts`：真实拖放（CDP 派发）→ 预览分类
 *      → 导入 → 结果统计 → 重新扫描确认不产生脏数据 → 中途取消
 *
 * 不用 Python 样本：这一节验的是交互链路，TXT 用 node 直接写就够，
 * EPUB 只要一个「打不开的」来触发失败分支。
 *
 * 用法：pnpm verify:import-ui（构建约 10s，链路段约 60s）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE
delete cleanEnv.CTEXT_IMPORT_UI_DIR
delete cleanEnv.CTEXT_IMPORT_UI_CANCEL_DIR
delete cleanEnv.CTEXT_IMPORT_UI_CLIP_DIR

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/**
 * 一本书的文本。`seed` 必须每本不同：指纹只取「大小 + 首尾各 4KB」，
 * 内容相同的两本会被判成批内重复，导致「新增 5」变成「新增 1」。
 */
function bookText(chapters, seed, author = '张三') {
  const lines = [`作者：${author}`, `简介：自检样本 ${seed}，共 ${chapters} 章。`]
  for (let i = 1; i <= chapters; i += 1) {
    lines.push(`第${i}章 标题${i}`)
    lines.push(`这是第${i}章的正文（${seed}），写得长一点，让编码探测有足够的样本可以收敛。`)
  }
  return `${lines.join('\n')}\n`
}

function makeBooksDir() {
  const dir = join(scratch, 'books')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= 5; i += 1) {
    writeFileSync(join(dir, `小说${i}.txt`), bookText(3, `B${i}`), 'utf8')
  }
  // 空文件 → 预览里归「跳过」，导入时不进队列
  writeFileSync(join(dir, '空文件.txt'), '')
  // 坏 EPUB → 解析失败，但不得影响其余 5 本
  writeFileSync(join(dir, '坏书.epub'), Buffer.from('这不是一个 zip 文件'.repeat(20), 'utf8'))
  // 不支持的格式 → 预览里归「不支持」，导入时根本不扫描
  writeFileSync(join(dir, '说明书.pdf'), '%PDF-1.4 fake')
  return dir
}

function makeCancelDir() {
  const dir = join(scratch, 'many')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 60; i += 1) {
    writeFileSync(join(dir, `book-${String(i).padStart(3, '0')}.txt`), bookText(6, `C${i}`), 'utf8')
  }
  return dir
}

/** 401 本：跨过渲染层 300 行的裁剪阈值，验证「只显示前 300 项」的提示会出现 */
function makeClipDir() {
  const dir = join(scratch, 'clip')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 401; i += 1) {
    writeFileSync(join(dir, `book-${String(i).padStart(4, '0')}.txt`), bookText(2, `L${i}`), 'utf8')
  }
  return dir
}

function build() {
  console.log('[1/3] 构建 out/ ...')
  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
    { cwd: root, encoding: 'utf8', env: cleanEnv }
  )
  if (r.status !== 0) {
    console.error(r.stdout)
    console.error(r.stderr)
    throw new Error(`构建失败，退出码 ${r.status}`)
  }
}

function runUiSmoke(booksDir, cancelDir, clipDir) {
  console.log('[3/3] 导入交互自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: {
        ...cleanEnv,
        CTEXT_IMPORT_UI_SMOKE: '1',
        CTEXT_IMPORT_UI_DIR: booksDir,
        CTEXT_IMPORT_UI_CANCEL_DIR: cancelDir,
        CTEXT_IMPORT_UI_CLIP_DIR: clipDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('交互自检在 180s 内完成', false, '超时')
      resolve()
    }, 180_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const re = /^SMOKE IMPORTUI (PASS|FAIL) /
      const lines = out.split(/\r?\n/).filter((l) => re.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE IMPORTUI PASS')
        const body = line.replace(re, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('交互自检产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-import-ui-'))

build()
console.log('[2/3] 生成样本目录 ...')
const booksDir = makeBooksDir()
const cancelDir = makeCancelDir()
const clipDir = makeClipDir()
record('小样本目录已生成', existsSync(booksDir), booksDir)
record('取消用样本目录已生成', existsSync(cancelDir), cancelDir)
record('截断用样本目录已生成', existsSync(clipDir), clipDir)

await runUiSmoke(booksDir, cancelDir, clipDir)

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  console.log(`  · 临时目录未清理（可手动删）：${scratch}`)
}

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`
)
process.exit(failed.length === 0 ? 0 : 1)
