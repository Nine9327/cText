/**
 * M0-05 Python 桥接验收脚本。
 *
 * 覆盖开发计划的两条验收标准：
 *   1. health.ping 返回版本与 pid
 *   2. 手动杀进程后 3s 内自恢复
 * 另外覆盖：NDJSON 半包/粘包/坏帧/超长行、请求超时、并发、3 次/5 分钟重启上限、
 * retry() 手动恢复、stop() 不残留进程，以及渲染层经 IPC 读取健康状态。
 *
 * 用法：pnpm verify:bridge（会先构建 out/，再以 CTEXT_BRIDGE_SMOKE=1 启动应用）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const venvPy = join(root, '.venv', 'Scripts', 'python.exe')
const workerMain = join(root, 'python', 'ctext_worker', 'main.py')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function preflight() {
  if (!existsSync(electronBin)) {
    console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
    process.exit(1)
  }
  if (!existsSync(venvPy)) {
    console.error(`未找到项目 venv：${venvPy}\n请先执行 pnpm setup:python`)
    process.exit(1)
  }
  if (!existsSync(workerMain)) {
    console.error(`未找到 worker 入口：${workerMain}`)
    process.exit(1)
  }
}

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

function build() {
  console.log('[1/2] 构建 out/ ...')
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

function runSmoke(scratch) {
  console.log('[2/2] 桥接冒烟检查 ...')
  return new Promise((resolve) => {
    // 必须用临时 userData：不带的话会碰真实 %APPDATA%\ctext（写日志、杀 worker），
    // 而且用户自己开着 cText 时单实例锁会让这里直接假失败
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_BRIDGE_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    // 含多次崩溃重启与 600ms 超时等待，留足余量
    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 90s 内完成', false, '超时，可能有请求未落地')
      resolve()
    }, 90_000)

    child.on('exit', (code) => {
      clearTimeout(timer)

      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE BRIDGE (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE BRIDGE PASS')
        const body = line.replace(/^SMOKE BRIDGE (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join(' / ')
        record('冒烟检查产出结果', false, `进程退出码 ${code}，无断言输出：${tail}`)
      }

      // 断言之外的日志证据：握手、坏帧告警、重启行为
      record('主进程记录 worker 握手日志', /worker 就绪 v\d+\.\d+\.\d+ pid=\d+/.test(out), '')
      record('坏帧被记录为 warn 而非崩溃', /坏帧已跳过/.test(out), '')
      record('崩溃重启有日志留痕', /后重启（第 1 次）/.test(out), '')
      record('达到重启上限后明确报错', /反复崩溃，已停止自动重启/.test(out), '')

      resolve()
    })
  })
}

preflight()
const scratch = mkdtempSync(join(tmpdir(), 'ctext-bridge-'))
build()
await runSmoke(scratch)

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
