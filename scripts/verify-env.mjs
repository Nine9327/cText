/**
 * M0-00 环境自检（Node 侧）。
 * 对齐 docs/开发计划.md M0-00 验收：Node 22 + pnpm、Python 3.11、VS Build Tools、electron 依赖编译通过。
 *
 * 注意：better-sqlite3 是针对 Electron ABI 编译的（NODE_MODULE_VERSION 128），
 * 在纯 Node 下加载会报 ABI 不匹配，属预期。此处只校验产物存在，
 * 真正的加载 + WAL 验证见 scripts/verify-electron.cjs（pnpm check:env:electron）。
 *
 * 用法：pnpm check:env
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const run = (bin, args) => {
  try {
    // Windows 下 pnpm 是 .cmd，execFileSync 需经 shell 才能解析
    return execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      shell: process.platform === 'win32'
    }).trim()
  } catch {
    return null
  }
}

// 完整路径的可执行文件不经 shell，避免 Program Files 的空格被拆分
const runExe = (bin, args) => {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

// 1. Node 22（electron-vite 与 toolchain 基线）
const nodeMajor = Number(process.versions.node.split('.')[0])
record('Node 22', nodeMajor === 22, `v${process.versions.node}`)

// 2. pnpm
const pnpmVersion = run('pnpm', ['--version'])
record('pnpm', !!pnpmVersion && /^\d+\./.test(pnpmVersion), pnpmVersion ?? 'not found')

// 3. Python 3.11（文档 §3.1 锁定）—— 使用仓库内 .venv，不依赖全局解释器
const venvPy = join(root, '.venv', 'Scripts', 'python.exe')
const pyVersion = existsSync(venvPy) ? runExe(venvPy, ['--version']) : null
record(
  'Python 3.11 (.venv)',
  !!pyVersion && /3\.11\./.test(pyVersion),
  pyVersion ?? '未建立，运行 pnpm setup:python'
)

// 4. VS Build Tools（C++ 工具链）—— pnpm 严格构建策略要求 node-gyp 能成功
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
const vcPath = existsSync(vswhere)
  ? runExe(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])
  : null
record('VS Build Tools (VC++)', !!vcPath, vcPath || '未安装 C++ 工作负载')

// 5. Electron 二进制
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version
const electronExe = join(root, 'node_modules/electron/dist/electron.exe')
record('Electron 32 二进制', existsSync(electronExe), `v${electronVersion}`)

// 6. better-sqlite3 已针对 Electron ABI 编译
const bs3 = JSON.parse(readFileSync(join(root, 'node_modules/better-sqlite3/package.json'), 'utf8'))
const bs3Native = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
record('better-sqlite3 原生产物', existsSync(bs3Native), `v${bs3.version}${existsSync(bs3Native) ? '' : '（需 pnpm rebuild:native）'}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`)
process.exit(failed.length === 0 ? 0 : 1)
