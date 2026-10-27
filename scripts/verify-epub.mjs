/**
 * M1-05 EPUB 解析验收脚本。
 *
 * 三段：
 *   1. 构建 out/（链路自检要跑 Electron 产物，漏了这步会执行到上一轮的旧代码）
 *   2. **算法准确性**：跑 `python/smoke_epub.py --emit <scratch>`。
 *      它按结构生成 26 个 EPUB 样本（nav/ncx/无目录、四种封面约定、DRM、损坏、字体混淆…）
 *      并就地断言；`--emit` 让样本留在磁盘上供第 3 段复用。
 *   3. **链路完整性**：起一次 Electron，经 Python bridge 调 `parse.epub.toc` /
 *      `parse.meta` / `cover.extract`，验证 NDJSON 往返、封面跨进程落盘、错误码透传。
 *
 * 覆盖开发计划里的验收标准：20 本 EPUB 目录层级正确、封面提取率 ≥90%。
 *
 * 用法：pnpm verify:epub（构建约 10s，Python 段约 2s，链路段约 8s）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const venvPython =
  process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE
delete cleanEnv.CTEXT_EPUB_SAMPLES

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 从输出里收集 `SMOKE <PREFIX> PASS|FAIL 名称 (细节)` 行 */
function collect(out, prefix) {
  const re = new RegExp(`^SMOKE ${prefix} (PASS|FAIL) `)
  const lines = out.split(/\r?\n/).filter((l) => re.test(l))
  for (const line of lines) {
    const ok = line.startsWith(`SMOKE ${prefix} PASS`)
    const body = line.replace(re, '')
    const m = body.match(/^(.*?)(?: \((.*)\))?$/)
    record(m?.[1] ?? body, ok, m?.[2] ?? '')
  }
  return lines.length
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

function runPythonSmoke(emitDir) {
  console.log('[2/3] Python 侧 EPUB 自检 ...')
  return new Promise((resolve) => {
    const child = spawn(venvPython, [join(root, 'python', 'smoke_epub.py'), '--emit', emitDir], {
      cwd: root,
      env: { ...cleanEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('Python 自检在 120s 内完成', false, '超时')
      resolve()
    }, 120_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, 'EPUB') === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('Python 自检产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

function runBridgeSmoke(scratch, emitDir) {
  console.log('[3/3] Python bridge 链路自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_EPUB_SMOKE: '1', CTEXT_EPUB_SAMPLES: emitDir },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('链路自检在 90s 内完成', false, '超时')
      resolve()
    }, 90_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, 'EPUBCHAIN') === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('链路自检产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}
if (!existsSync(venvPython)) {
  console.error(`未找到项目内 Python：${venvPython}\n请先执行 pnpm setup:python`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-epub-'))
const samples = join(scratch, 'samples')

build()
await runPythonSmoke(samples)
await runBridgeSmoke(scratch, samples)

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
