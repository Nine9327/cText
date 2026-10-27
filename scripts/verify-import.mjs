/**
 * M1-06 导入任务队列验收脚本。
 *
 * 三段：
 *   1. 构建 out/（链路自检跑的是 Electron 产物，漏了这步会执行到上一轮的旧代码）
 *   2. 用 `python/smoke_epub.py --emit <dir>` 生成 EPUB 样本，供第 3 段复用。
 *      导入队列需要真实的 EPUB（要走 cover.extract 落盘），现造的话脚本里
 *      要再写一份 zip 拼装逻辑；复用 M1-05 已验收过的样本更可靠。
 *   3. 起一次 Electron 跑 `import-smoke.ts`：独立临时库 + 临时目录，
 *      覆盖预览分类、首次导入、重复导入、overwrite 覆盖、单本失败隔离、
 *      取消后数据一致、子目录导入与根目录归属语义。
 *
 * 用法：pnpm verify:import（构建约 10s，样本约 2s，链路段约 40s）
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
delete cleanEnv.CTEXT_IMPORT_SAMPLES

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

function emitSamples(emitDir) {
  console.log('[2/3] 生成 EPUB 样本 ...')
  const r = spawnSync(venvPython, [join(root, 'python', 'smoke_epub.py'), '--emit', emitDir], {
    cwd: root,
    encoding: 'utf8',
    env: { ...cleanEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  })
  const wanted = ['toc_volume.epub', 'cover_meta.epub']
  for (const name of wanted) {
    record(`样本就位：${name}`, existsSync(join(emitDir, name)), emitDir)
  }
  if (!wanted.every((name) => existsSync(join(emitDir, name)))) {
    console.error((r.stdout ?? '') + (r.stderr ?? ''))
    throw new Error('EPUB 样本未生成，无法继续')
  }
}

function runImportSmoke(scratch, samples) {
  console.log('[3/3] 导入队列链路自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_IMPORT_SMOKE: '1', CTEXT_IMPORT_SAMPLES: samples },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    // 60 本取消用例要跑满 180 次 worker 请求，给足预算
    const timer = setTimeout(() => {
      child.kill()
      record('链路自检在 180s 内完成', false, '超时')
      resolve()
    }, 180_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, 'IMPORT') === 0) {
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-import-'))
const samples = join(scratch, 'samples')

build()
emitSamples(samples)
await runImportSmoke(scratch, samples)

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
