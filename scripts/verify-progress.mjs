/**
 * M2-08 进度验收：**写 → 强杀 → 重开**。
 *
 * 两段进程共用同一个 userData（同一个库）：
 *   1. write 段翻到第 2 章第 3 页，等满 1s 防抖，打印 `PROGRESS SAVED` 后挂住；
 *      本脚本看到 `PROGRESS READY` 就 `SIGKILL` 掉它——**不是**正常关闭。
 *   2. read 段重新启动，从书库点进阅读器（URL 不带章号），断言恢复到同一章同一页、
 *      章内偏移与落库值完全一致。
 *
 * 为什么要这样验：如果位置只靠 `beforeunload` 兜底保存，正常关闭时一切正常，
 * 而用户真正遇到的「任务管理器结束进程 / 断电 / 崩溃」会全部丢位置。
 *
 * 用法：pnpm verify:progress
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
  console.log('[1/3] 构建 out/ ...')
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
 * 启动一段自检。
 * `killOnReady` 时等到 `PROGRESS READY` 就强杀（模拟任务管理器结束进程），
 * 并把 stdout 里的 `PROGRESS SAVED ...` 解析出来返回。
 */
function runPhase(scratch, dir, phase, killOnReady) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: {
        ...cleanEnv,
        CTEXT_PROGRESS_SMOKE: '1',
        CTEXT_PROGRESS_PHASE: phase,
        CTEXT_PROGRESS_DIR: dir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    let killed = false
    const onData = (d) => {
      out += d
      if (killOnReady && !killed && out.includes('PROGRESS READY')) {
        killed = true
        // SIGKILL：进程没有机会执行任何退出钩子
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const timer = setTimeout(() => {
      if (!killed) {
        record(`${phase} 段在 180s 内完成`, false, '超时')
        child.kill()
        resolve({ out, code: 'timeout' })
      }
    }, 180_000)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ out, code, signal, killed })
    })
  })
}

function collect(out) {
  const lines = out.split(/\r?\n/).filter((l) => /^SMOKE PROGRESS (PASS|FAIL) /.test(l))
  for (const line of lines) {
    const ok = line.startsWith('SMOKE PROGRESS PASS')
    const body = line.replace(/^SMOKE PROGRESS (PASS|FAIL) /, '')
    const m = body.match(/^(.*?)(?: \((.*)\))?$/)
    record(m?.[1] ?? body, ok, m?.[2] ?? '')
  }
  return lines.length
}

function parseProgress(out) {
  const saved = /PROGRESS SAVED chapter=(-?\d+) offset=(-?\d+) page=(-?\d+)/.exec(out)
  const restored = /PROGRESS RESTORED chapter=(-?\d+) offset=(-?\d+) page=(-?\d+)/.exec(out)
  const toNumbers = (m) => (m ? { chapter: Number(m[1]), offset: Number(m[2]), page: Number(m[3]) } : null)
  return { saved: toNumbers(saved), restored: toNumbers(restored) }
}

const scratch = mkdtempSync(join(tmpdir(), 'ctext-progress-'))
const libraryDir = join(scratch, 'library')

try {
  build()

  console.log('[2/3] 写进度并强杀 ...')
  const write = await runPhase(scratch, libraryDir, 'write', true)
  collect(write.out)
  const writeProgress = parseProgress(write.out).saved
  record(
    '写段被强杀（不是正常退出）',
    write.signal === 'SIGKILL' || write.code === 'SIGKILL',
    `signal=${write.signal} code=${write.code}`
  )

  console.log('[3/3] 重开并检查恢复 ...')
  const read = await runPhase(scratch, libraryDir, 'read', false)
  if (collect(read.out) === 0) {
    const tail = read.out.split(/\r?\n/).slice(-12).join(' / ')
    record('读段产出结果', false, `退出码 ${read.code}，无断言输出：${tail}`)
  }
  const restored = parseProgress(read.out).restored

  record(
    '强杀前后位置完全一致（章 / 页 / 偏移）',
    !!writeProgress &&
      !!restored &&
      writeProgress.chapter === restored.chapter &&
      writeProgress.page === restored.page &&
      writeProgress.offset === restored.offset,
    writeProgress && restored
      ? `杀前 章${writeProgress.chapter + 1}/页${writeProgress.page + 1}/偏移${writeProgress.offset} → 重开 章${restored.chapter + 1}/页${restored.page + 1}/偏移${restored.offset}`
      : '任一段没打印出位置'
  )
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
