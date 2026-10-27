/**
 * M0-03 数据库层验收脚本。
 *
 * 覆盖开发计划中的验收标准：
 *   1. 首启自动建库建表（真实 userData 下 ctext.db 被创建）
 *   2. 迁移可重复执行不报错（重放 migrate 应为空操作）
 * 附带检查：WAL / foreign_keys PRAGMA、全表与关键索引齐全、外键与唯一约束、
 * 级联删除、FTS 触发器同步。
 *
 * 注意：better-sqlite3 按 Electron ABI 编译，纯 Node 加载不了，
 * 所以断言必须跑在 Electron 运行时里（主进程 CTEXT_DB_SMOKE=1 分支）。
 *
 * 用法：pnpm verify:db
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

console.log('[1/2] 构建 out/ ...')
const build = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
  { cwd: root, encoding: 'utf8', env: cleanEnv }
)
if (build.status !== 0) {
  console.error(build.stdout)
  console.error(build.stderr)
  process.exit(1)
}

console.log('[2/2] 数据库断言 ...')
const exitCode = await new Promise((resolve) => {
  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env: { ...cleanEnv, CTEXT_DB_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))

  const timer = setTimeout(() => {
    child.kill()
    record('数据库自检在 30s 内完成', false, '超时')
    resolve(1)
  }, 30_000)

  child.on('exit', (code) => {
    clearTimeout(timer)

    const lines = out.split(/\r?\n/).filter((l) => /^SMOKE DB (PASS|FAIL) /.test(l))
    for (const line of lines) {
      const ok = line.startsWith('SMOKE DB PASS')
      const body = line.replace(/^SMOKE DB (PASS|FAIL) /, '')
      const m = body.match(/^(.*?)(?: \((.*)\))?$/)
      record(m?.[1] ?? body, ok, m?.[2] ?? '')
    }

    // 真实库文件（首启建库的最终证据）
    const info = out.split(/\r?\n/).find((l) => l.startsWith('SMOKE DB INFO dbfile='))
    const dbFile = info?.replace('SMOKE DB INFO dbfile=', '').trim()
    if (dbFile) {
      const exists = existsSync(dbFile)
      const size = exists ? statSync(dbFile).size : 0
      record('userData 下已生成库文件', exists && size > 0, `${dbFile} (${size} B)`)
      record('WAL 附属文件已生成', existsSync(`${dbFile}-wal`), `${dbFile}-wal`)
    } else {
      record('取到真实库路径', false, '未输出 SMOKE DB INFO')
    }

    if (lines.length === 0) {
      record('数据库自检产出结果', false, `退出码 ${code}，无断言输出`)
    }
    resolve(code ?? 1)
  })
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`)
process.exit(failed.length === 0 ? 0 : exitCode || 1)
