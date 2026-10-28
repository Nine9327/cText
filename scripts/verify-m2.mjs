/**
 * M2 出口验收（开发计划 §5「M2 出口检查」）。
 *
 * 四条标准里，「200MB 不 OOM」已在 verify:reader:big 里验过（那是纯主进程的读取侧），
 * 这里验另外三条——它们都需要真实渲染层：
 *   1. 20MB TXT 首屏 ≤1.5s
 *   2. 五套主题视觉验收（按 WCAG 对比度计算，不靠肉眼）
 *   3. 进度与书签在拔插硬盘后无损
 *
 * 用法：pnpm verify:m2（构建约 10s，写 20MB 样本 + 导入 + 断言约 20s）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
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
  console.log('[2/2] M2 出口验收 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: {
        ...cleanEnv,
        CTEXT_M2_SMOKE: '1',
        CTEXT_M2_DIR: join(scratch, 'library')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    let flushed = false
    const flush = (code) => {
      if (flushed) return
      flushed = true
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE M2 (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE M2 PASS')
        const body = line.replace(/^SMOKE M2 (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('出口验收产出结果', false, `退出码 ${code}，无断言输出：${tail}`)
      }
    }

    const timer = setTimeout(() => {
      record('出口验收在 240s 内完成', false, '超时')
      flush('timeout')
      child.kill()
      resolve()
    }, 240_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      flush(code)
      resolve()
    })
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-m2-'))
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
