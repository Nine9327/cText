/**
 * M2-04 分页引擎验收。
 *
 * 与 verify:reader（内容通路）分工：那边验「正文读得对不对」，这边验
 * 「排出来的页对不对、换字号/缩窗口后位置会不会跳」——只能在真实渲染层里量。
 *
 * 用法：pnpm verify:reader:ui（内部先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const venvPython =
  process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')

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
 * 样本库里除了自检自己写的 TXT，还要有一本 EPUB：M2-05 的「EPUB 默认滚动」
 * 只能在「用户还没手动选过模式」时验，而那个分支一旦被跳过就再也测不到。
 * 复用 M1-05 已验收过的包（`python/smoke_epub.py --emit`），不另造样本。
 */
function emitEpub(targetDir) {
  console.log('[样本] 生成 EPUB ...')
  const emitDir = join(targetDir, '..', 'epub-emit')
  mkdirSync(targetDir, { recursive: true })
  const r = spawnSync(venvPython, [join(root, 'python', 'smoke_epub.py'), '--emit', emitDir], {
    cwd: root,
    encoding: 'utf8',
    env: { ...cleanEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  })
  const source = join(emitDir, 'toc_volume.epub')
  if (!existsSync(source)) {
    console.error(r.stdout ?? '')
    console.error(r.stderr ?? '')
    throw new Error('EPUB 样本未生成')
  }
  copyFileSync(source, join(targetDir, 'toc_volume.epub'))
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

    // 收尾时把**已经收到的**断言全部计入结果。
    // 之前超时分支直接 record('超时') 就 resolve，把已经跑过的几十条断言全丢了——
    // 表现成「0/1 项通过、一条输出都没有」，看起来像渲染层没起来，其实是跑得慢。
    let flushed = false
    const flush = (exitCode) => {
      if (flushed) return
      flushed = true
      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE READERUI (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE READERUI PASS')
        const body = line.replace(/^SMOKE READERUI (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
        record('分页检查产出结果', false, `进程退出码 ${exitCode}，无断言输出：${tail}`)
      }
    }

    const timer = setTimeout(() => {
      record('分页检查在 240s 内完成', false, '超时（下面列出超时前已跑完的断言）')
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-reader-ui-'))
try {
  build()
  emitEpub(join(scratch, 'library'))
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
