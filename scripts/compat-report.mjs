/**
 * M4-12 真实书源抽样报告（**手动执行，不进 CI**）。
 *
 * 用法：
 *   pnpm compat:report --dir "D:/我的书源" [--out reports\compat.md] [--keyword 三体] [--limit 100]
 *
 * 样本由使用者自行提供，脚本只把目录路径传给主进程读取：
 * 不复制、不入库、不随应用分发（产品文档 §2.7）。生成两个文件（同名 .json / .md）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

function argOf(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const dir = argOf('dir')
if (dir === null) {
  console.error('用法：pnpm compat:report --dir <书源 JSON 目录> [--out <报告路径>] [--keyword <关键词>] [--limit N]')
  process.exit(2)
}
const sourceDir = resolve(dir)
if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  console.error(`目录不存在：${sourceDir}`)
  process.exit(2)
}

const out = resolve(argOf('out', join(root, 'reports', 'source-compat.md')))
const keyword = argOf('keyword', '三体')
const limit = argOf('limit', '0')

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS
delete cleanEnv.CTEXT_SAFE_MODE
delete cleanEnv.CTEXT_SOURCE_COMPAT_SMOKE

console.log('[1/2] 构建 out/ ...')
const build = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
  { cwd: root, encoding: 'utf8', env: cleanEnv }
)
if (build.status !== 0) {
  console.error(build.stdout)
  console.error(build.stderr)
  process.exit(build.status ?? 1)
}

console.log(`[2/2] 抽样 ${sourceDir} ...`)
const child = spawn(electronBin, ['.'], {
  cwd: root,
  env: {
    ...cleanEnv,
    CTEXT_COMPAT_REPORT_DIR: sourceDir,
    CTEXT_COMPAT_REPORT_OUT: out,
    CTEXT_COMPAT_REPORT_KEYWORD: keyword,
    CTEXT_COMPAT_REPORT_LIMIT: limit
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('exit', (code) => process.exit(code ?? 1))
