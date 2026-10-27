/**
 * M0-02 窗口外壳验收脚本。
 *
 * 覆盖开发计划中的验收标准：
 *   1. 标题栏可拖拽 / 按钮区不可拖拽（读 computedStyle 的 app-region）
 *   2. 二次启动聚焦已有窗口（第二实例拿不到单实例锁即退出，首实例仍存活）
 * 附带检查：最小尺寸夹紧、最大化状态回推渲染层、窗口居中。
 *
 * 用法：pnpm verify:shell（内部会先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainEntry = join(root, 'out', 'main', 'index.js')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 跑一次构建，保证 out/ 与源码一致 */
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

/** 以 CTEXT_SMOKE=1 启动应用，收集主进程输出的断言结果 */
function runSmoke() {
  console.log('[2/2] 窗口外壳冒烟检查 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 30s 内完成', false, '超时，可能是窗口未就绪')
      resolve()
    }, 30_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      // 只认断言行；did-fail-load 等诊断信息用 [smoke] 前缀，不算断言
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE PASS')
        const body = line.replace(/^SMOKE (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const diag = out.split(/\r?\n/).filter((l) => l.startsWith('[smoke]')).join(' / ')
        record('冒烟检查产出结果', false, `进程退出码 ${code}，无断言输出${diag ? `：${diag}` : ''}`)
      }
      resolve()
    })
  })
}

/** 启动两个实例，验证单实例锁与二次启动行为 */
function runSingleInstance() {
  console.log('[3/3] 单实例锁检查 ...')
  return new Promise((resolve) => {
    const first = spawn(electronBin, ['.'], { cwd: root, env: cleanEnv, stdio: 'ignore' })
    let firstAlive = true
    first.on('exit', () => (firstAlive = false))

    setTimeout(() => {
      const started = Date.now()
      const second = spawn(electronBin, ['.'], { cwd: root, env: cleanEnv, stdio: 'ignore' })

      const timer = setTimeout(() => {
        second.kill()
        record('第二实例立即退出', false, '5s 内未退出，单实例锁可能失效')
        first.kill()
        resolve()
      }, 5_000)

      second.on('exit', () => {
        clearTimeout(timer)
        const elapsed = Date.now() - started
        record('第二实例立即退出', elapsed < 5_000, `${elapsed}ms 后退出`)
        record('首实例仍在运行', firstAlive, firstAlive ? '' : '首实例已退出')
        first.kill()
        resolve()
      })
    }, 6_000)
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

build()
await runSmoke()
await runSingleInstance()

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`)
process.exit(failed.length === 0 ? 0 : 1)
