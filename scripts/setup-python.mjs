/**
 * 建立项目自包含的 Python 环境（M0-00）。
 *
 * 目标：解释器与虚拟环境全部落在仓库内，不写 %APPDATA%\uv、不改系统 PATH、不注册 py launcher。
 *   .python/  ← Python 3.11 解释器（uv 托管，仅本仓库可见）
 *   .venv/    ← 虚拟环境
 * 两者都在 .gitignore 中，删掉后重跑本脚本即可重建。
 *
 * 用法：pnpm setup:python
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pythonDir = join(root, '.python')
const venvDir = join(root, '.venv')

const version = '3.11'
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: pythonDir }

const uv = (args) => {
  console.log(`\n$ uv ${args.join(' ')}`)
  // Windows 下 uv 为 .exe，经 shell 解析更稳
  const r = spawnSync('uv', args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`\nuv ${args[0]} 失败（exit ${r.status}）`)
    process.exit(r.status ?? 1)
  }
}

uv(['python', 'install', version])
uv(['venv', '--python', version, venvDir])

const py = join(venvDir, 'Scripts', 'python.exe')
if (!existsSync(py)) {
  console.error(`\n未找到 ${py}`)
  process.exit(1)
}

const check = spawnSync(py, ['--version'], { encoding: 'utf8' })
console.log(`\nvenv: ${venvDir}`)
console.log(`${py} → ${(check.stdout || check.stderr).trim()}`)
