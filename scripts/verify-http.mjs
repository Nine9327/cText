/**
 * M4-06 HTTP 层自检脚本。
 *
 * 两段：
 *   1. 构建 out/
 *   2. 起 Electron（临时 userData），主进程起本地服务器跑断言后退出
 *
 * 全程离线：测试站是 127.0.0.1 上临时起的 node:http 服务。
 * 用法：pnpm verify:http
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE
delete cleanEnv.CTEXT_HTTP_SMOKE

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

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
  console.log('[2/2] M4-06 HTTP 层自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_HTTP_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('自检在 90s 内完成', false, '超时')
      resolve()
    }, 90_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, 'HTTP') === 0) {
        const tail = out.split(/\r?\n/).slice(-16).join(' / ')
        record('自检产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-http-'))
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
