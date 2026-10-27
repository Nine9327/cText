/**
 * M1-01 根目录服务验收脚本。
 *
 * 覆盖开发计划里的验收标准：拔盘后 state 变 offline 且 UI 收到事件；改路径后恢复。
 * 附带：登记查重（大小写）、不可用路径拒绝、zod 入参校验、状态未变不重复广播、
 * 重定位的冲突与命中统计、移除后不删书。
 *
 * 「拔盘」用删除临时目录模拟——probePath 判定的正是 stat 能否拿到且是目录，
 * 删掉目录后的表现与拔掉移动硬盘一致，且可自动化。
 *
 * 用法：pnpm verify:roots（内部先构建一次 out/）
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
 * 临时 userData 启动一次自检。
 * 自检会往库里写测试根目录，必须用干净身份，否则既污染真实书库，
 * 也会因为已有数据让「初始列表为空」这类断言失败。
 */
function runSmoke(scratch) {
  console.log('[2/2] 根目录服务冒烟检查 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_ROOTS_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 120s 内完成', false, '超时，可能是渲染层没起来')
      resolve()
    }, 120_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE ROOTS (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE ROOTS PASS')
        const body = line.replace(/^SMOKE ROOTS (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-roots-'))
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
