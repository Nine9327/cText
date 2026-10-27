/**
 * 以真正的 Electron 模式启动自检脚本。
 * - 某些宿主环境（IDE / 终端）会预设 ELECTRON_RUN_AS_NODE=1，
 *   此时 electron.exe 会退化成纯 Node 运行，app API 不可用，必须清掉。
 * - Electron 在 Windows 下退出码不可靠，故由本脚本解析子进程输出决定成败。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const electronPath = require('electron')
const target = join(root, 'scripts', 'verify-electron.cjs')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const noise = /Ignoring extra certs|crashpad_client_win/
const child = spawn(electronPath, [target], { env, stdio: ['ignore', 'pipe', 'pipe'] })

let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += String(chunk)
  process.stdout.write(chunk)
})

child.stderr.on('data', (chunk) => {
  const text = String(chunk)
  if (!noise.test(text)) process.stderr.write(chunk)
})

child.on('exit', () => process.exit(/ALL PASS/.test(stdout) ? 0 : 1))
