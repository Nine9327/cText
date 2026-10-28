/**
 * M2-04 分页引擎验收。
 *
 * 与 verify:reader（内容通路）分工：那边验「正文读得对不对」，这边验
 * 「排出来的页对不对、换字号/缩窗口后位置会不会跳」——只能在真实渲染层里量。
 *
 * 用法：pnpm verify:reader:ui（内部先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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

function runSmoke(scratch) {
  console.log('[2/2] 分页与重排检查 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: {
        ...cleanEnv,
        CTEXT_READER_UI_SMOKE: '1',
        CTEXT_READER_UI_DIR: join(scratch, 'library')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('分页检查在 120s 内完成', false, '超时，可能是渲染层没起来或分页死循环')
      resolve()
    }, 120_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE READERUI (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE READERUI PASS')
        const body = line.replace(/^SMOKE READERUI (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('分页检查产出结果', false, `进程退出码 ${code}，无断言输出：${tail}`)
      }
      resolve()
    })
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-reader-ui-'))
try {
  build()
  await runSmoke(scratch)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`)
  process.exit(1)
}
