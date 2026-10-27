/**
 * M1-04 TXT 解析验收脚本。
 *
 * 三段：
 *   1. 构建 out/（链路自检要跑 Electron 产物，漏了这步会执行到上一轮的旧代码）
 *   2. **算法准确性**：跑 `python/smoke_parse.py`（20 个编码样本 + 章节/meta 用例）。
 *      放在 Python 侧是因为样本本身要用 GBK/UTF-16 写出来，Node 没有内置 GBK 编码器。
 *   3. **链路完整性**：起一次 Electron，经 Python bridge 调 parse.* 方法，
 *      验证 NDJSON 往返、中文路径、错误码透传。
 *
 * 覆盖开发计划里的验收标准：20 本 GBK/UTF-8/BOM 样本识别正确率 ≥90%。
 *
 * 用法：pnpm verify:txt（构建约 10s，Python 段约 2s，链路段要拉起 Python worker 约 8s）
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

function runPythonSmoke() {
  console.log('[2/3] Python 侧解析自检 ...')
  return new Promise((resolve) => {
    const child = spawn(venvPython, [join(root, 'python', 'smoke_parse.py')], {
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
      if (collect(out, 'TXT') === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('Python 自检产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

function runBridgeSmoke(scratch) {
  console.log('[3/3] Python bridge 链路自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_PARSE_SMOKE: '1' },
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
      if (collect(out, 'PARSE') === 0) {
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-txt-'))
build()
await runPythonSmoke()
await runBridgeSmoke(scratch)

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
