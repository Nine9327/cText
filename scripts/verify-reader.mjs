/**
 * M2-01 内容通路验收脚本。
 *
 * 三段：
 *   1. 构建 out/
 *   2. 造样本：UTF-8 TXT 由主进程自检自己写；GBK TXT 用 venv 的 python 生成
 *      （Node 的 TextEncoder 只支持 UTF-8，编不出 GBK 字节）；EPUB 复用
 *      `python/smoke_epub.py --emit` 的产物（M1-05 已验收过的包）
 *   3. 起一次 Electron（临时 userData）跑 reader/smoke.ts
 *
 * 用法：pnpm verify:reader（构建约 10s，自检约 15s）
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
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE

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

/** GBK 样本。正文里那句标记与 reader/smoke.ts 的 GBK_MARK 一致 */
function emitGbk(sampleDir) {
  const script = [
    'import sys',
    'path = sys.argv[1]',
    'lines = [',
    '  "第1章 起点",',
    '  "这是 GBK编码正文，用来验证按 books.encoding 解码。",',
    '  "",',
    '  "第2章 第二章",',
    '  "这里是第二章正文。",',
    '  "",',
    '  "第3章 第三章",',
    '  "这里是第三章正文。",',
    ']',
    'open(path, "w", encoding="gbk", newline="\\n").write("\\n".join(lines) + "\\n")'
  ].join('\n')
  const target = join(sampleDir, 'gbk.txt')
  const r = spawnSync(venvPython, ['-c', script, target], {
    cwd: root,
    encoding: 'utf8',
    env: { ...cleanEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  })
  if (r.status !== 0) {
    console.error(r.stdout ?? '')
    console.error(r.stderr ?? '')
    throw new Error('GBK 样本生成失败')
  }
  record('样本就位：gbk.txt', existsSync(target), target)
}

function emitEpub(sampleDir, emitDir) {
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
  copyFileSync(source, join(sampleDir, 'toc_volume.epub'))
  record('样本就位：toc_volume.epub', true, join(sampleDir, 'toc_volume.epub'))
}

function runReaderSmoke(scratch, sampleDir) {
  console.log('[3/3] 内容通路自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.', `--user-data-dir=${join(scratch, 'userData')}`], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_READER_SMOKE: '1', CTEXT_READER_DIR: sampleDir },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('自检在 120s 内完成', false, '超时')
      resolve()
    }, 120_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (collect(out, 'READER') === 0) {
        const tail = out.split(/\r?\n/).slice(-14).join(' / ')
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

const scratch = mkdtempSync(join(tmpdir(), 'ctext-reader-'))
const sampleDir = join(scratch, 'samples')
mkdirSync(sampleDir, { recursive: true })
build()
console.log('[2/3] 生成样本 ...')
emitGbk(sampleDir)
emitEpub(sampleDir, join(scratch, 'emit'))
await runReaderSmoke(scratch, sampleDir)

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
