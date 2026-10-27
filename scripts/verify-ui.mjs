/**
 * M0-08 侧栏骨架验收脚本。
 *
 * 覆盖开发计划里的验收标准：五个入口可切换、选中态与设计稿一致。
 * 附带：书库切换器的过滤与离线态、两个层级的折叠、失效链接的空状态、
 * 未实现动作落到 toast（顺带回归 M0-06 的提示链路）。
 *
 * 用法：pnpm verify:ui（内部先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
// 宿主 IDE 会预设这两个：前者让 Electron 退化成纯 Node，后者带的 shim 会打噪声日志
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
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

/**
 * 用临时 userData 启动一次自检。
 * 所有断言都是"点击 → 路由 → 类名"，对这些结果来说 localStorage 里的折叠状态
 * 是干扰项，所以必须每次都是干净身份（也顺带不会碰用户真实的库与日志）。
 */
function runSmoke(scratch) {
  console.log('[2/2] 侧栏骨架冒烟检查 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_UI_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 90s 内完成', false, '超时，可能是渲染层没起来')
      resolve()
    }, 90_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE UI (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE UI PASS')
        const body = line.replace(/^SMOKE UI (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-12).join(' / ')
        record('冒烟检查产出结果', false, `进程退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-ui-'))
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
