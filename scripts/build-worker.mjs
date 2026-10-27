/**
 * 把 Python worker 打成 Windows 可执行产物（M0-07）。
 *
 *   python/ctext_worker/**  --PyInstaller --onedir-->  resources/python/ctext-worker/
 *                                                        ├─ ctext-worker.exe
 *                                                        └─ _internal/**
 *
 * 为什么是 --onedir 而不是 --onefile：
 *   - onefile 每次启动要把自身解压到 %TEMP%，冷启动多 1~2s，而我们要求的冷启动是 2s 内；
 *   - onefile 的解压行为会触发部分杀软启发式（文档 §7 已列为中风险）。
 *
 * 产物不进 git（见 .gitignore 的 resources/python/），需要时重跑本脚本。
 *
 * 用法：
 *   pnpm build:worker            正常构建
 *   pnpm build:worker --skip-check   只构建，不做产物自检
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const venvPy = join(root, '.venv', 'Scripts', 'python.exe')
const workerSrc = join(root, 'python', 'ctext_worker')
const mainPy = join(workerSrc, 'main.py')
const distDir = join(root, 'resources', 'python')
const workDir = join(root, 'python', 'build')
const exePath = join(distDir, 'ctext-worker', 'ctext-worker.exe')

const args = new Set(process.argv.slice(2))
const skipCheck = args.has('--skip-check')

/** 打包进产物的解析依赖：worker 里是 find_spec 探测，静态分析看不到，必须显式声明 */
const HIDDEN_IMPORTS = ['ebooklib', 'lxml', 'pdfminer', 'charset_normalizer', 'PIL']

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function run(cmd, argv, opts = {}) {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`)
  const r = spawnSync(cmd, argv, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts
  })
  if (r.status !== 0) fail(`${cmd} 退出码 ${r.status}`)
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

// ---------------------------------------------------------------- 0. 前置检查
if (!existsSync(venvPy)) {
  fail(`未找到 ${venvPy}\n  先执行 pnpm setup:python 建立仓库内 Python 环境`)
}
if (!existsSync(mainPy)) fail(`未找到 ${mainPy}`)

const hasPyInstaller = spawnSync(venvPy, ['-c', 'import PyInstaller'], { stdio: 'ignore' }).status === 0
if (!hasPyInstaller) {
  console.log('未安装 PyInstaller，先装进 .venv（不污染系统环境）')
  run('uv', ['pip', 'install', '--python', venvPy, 'pyinstaller>=6.11,<7'])
}

// ---------------------------------------------------------------- 1. 构建
const pyArgs = [
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--console',
  '--noupx',
  '--name',
  'ctext-worker',
  '--distpath',
  distDir,
  '--workpath',
  workDir,
  '--specpath',
  workDir,
  '--paths',
  workerSrc,
  ...HIDDEN_IMPORTS.map((m) => `--hidden-import=${m}`),
  // 打包后才不需要的东西：tkinter 十几 MB，测试框架谁都不该带进产物
  '--exclude-module=tkinter',
  '--exclude-module=pytest',
  mainPy
]
run(venvPy, pyArgs)

if (!existsSync(exePath)) fail(`构建结束但没有产物：${exePath}`)

const distRoot = join(distDir, 'ctext-worker')
const files = dirSize(distRoot)
console.log(`\n产物：${distRoot}`)
console.log(`体积：${mb(files)}`)

// ---------------------------------------------------------------- 2. 产物自检
// 只检查"文件在不在"是不够的：PyInstaller 最常见的失败是缺 hidden import，
// 表现为进程能起、一调方法就崩。所以直接把产物当 worker 跑一次握手 + health.ping。
if (skipCheck) {
  console.log('跳过产物自检（--skip-check）')
  process.exit(0)
}

console.log('\n产物自检：握手 + health.ping')
const child = spawn(exePath, [], { cwd: distRoot, stdio: ['pipe', 'pipe', 'pipe'] })

let ready = null
let ping = null
const stderrLines = []
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    stderrLines.push(`坏帧: ${line}`)
    return
  }
  if (frame.event === 'worker.ready') {
    ready = frame.data
    child.stdin.write(`${JSON.stringify({ id: 'self-check', method: 'health.ping', params: {} })}\n`)
  } else if (frame.id === 'self-check') {
    ping = frame
    child.stdin.end()
  }
})
createInterface({ input: child.stderr }).on('line', (line) => stderrLines.push(line))

const deadline = Date.now() + 20_000
const wait = setInterval(() => {
  const done = ping !== null
  if (done || Date.now() > deadline) {
    clearInterval(wait)
    finish()
  }
}, 100)

function finish() {
  child.kill()

  const problems = []
  if (!ready) problems.push('没有收到 worker.ready 握手帧')
  if (!ping) problems.push('health.ping 没有响应（超时 20s）')
  if (ping && !ping.ok) problems.push(`health.ping 返回失败：${JSON.stringify(ping.error)}`)
  if (ping?.ok) {
    const r = ping.result
    if (!r?.pid) problems.push('result 缺少 pid')
    if (r?.protocol !== 1) problems.push(`协议版本不是 1：${r?.protocol}`)
    const missing = Object.entries(r?.deps ?? {})
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
    if (missing.length > 0) problems.push(`产物缺少依赖：${missing.join(', ')}`)
  }

  if (problems.length > 0) {
    console.error('\n自检失败：')
    for (const p of problems) console.error(`  ✗ ${p}`)
    if (stderrLines.length > 0) {
      console.error('\nworker stderr：')
      for (const line of stderrLines.slice(-20)) console.error(`  ${line}`)
    }
    process.exit(1)
  }

  console.log(`  ✓ 握手 worker.ready pid=${ready.pid} python=${ready.python}`)
  console.log(`  ✓ health.ping version=${ping.result.version} protocol=${ping.result.protocol}`)
  console.log(`  ✓ 解析依赖齐备：${Object.keys(ping.result.deps).join(', ')}`)
  console.log(`  ✓ 方法 ${ping.result.methods.length} 个`)
  process.exit(0)
}
