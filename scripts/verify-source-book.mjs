/**
 * M4-09 阅读链路自检脚本。
 *
 * 两段：
 *   1. 构建 out/
 *   2. 起一次 Electron（临时 userData），主进程跑断言后退出
 *
 * 全程离线：自检自己起 127.0.0.1 的本地服务器模拟「详情 / 两页目录 / 两页正文」，
 * 用临时 SQLite 库验证加入书架与刷新目录。
 * 用法：
 *   pnpm verify:source-book        抓取与落库（纯主进程）
 *   pnpm verify:source-book:ui     搜索面板 → 加入书架 → 刷新目录（真实点击）
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
delete cleanEnv.CTEXT_SOURCE_BOOK_SMOKE
delete cleanEnv.CTEXT_SOURCE_BOOK_UI_SMOKE

/** 带 `--ui` 时跑界面点击那条（同一份构建，只换一个自检分支） */
const UI = process.argv.includes('--ui')
const PREFIX = UI ? 'BOOKUI' : 'BOOK'
const LABEL = UI ? 'M4-09 搜索与书架界面自检' : 'M4-09 阅读链路自检'

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
  console.log(`[2/2] ${LABEL} ...`)
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      // 界面自检要让主进程去连 127.0.0.1 的假站点（业务默认拒绝回环地址）
      env: {
        ...cleanEnv,
        CTEXT_HTTP_ALLOW_LOCAL: UI ? '1' : '0',
        [UI ? 'CTEXT_SOURCE_BOOK_UI_SMOKE' : 'CTEXT_SOURCE_BOOK_SMOKE']: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('自检在限定时间内完成', false, '超时')
      resolve()
    }, UI ? 240_000 : 180_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, PREFIX) === 0) {
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-book-'))
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
