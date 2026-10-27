/**
 * 出包的统一入口：`pnpm dist`（全部 target） / `pnpm dist:dir`（只解包目录，验收用）。
 *
 * 单独包一层而不是直接在 package.json 里调 electron-builder，是因为要注入
 * 二进制镜像环境变量（见 builder-env.mjs），跨 shell 写起来很难看。
 *
 * 额外参数透传：pnpm dist -- --win nsis
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILDER_CLI, builderEnv } from './builder-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const passthrough = process.argv.slice(2)
const args = passthrough.length > 0 ? passthrough : ['--win']

console.log(`$ electron-builder ${args.join(' ')}`)
const child = spawn(process.execPath, [resolve(root, BUILDER_CLI), ...args], {
  cwd: root,
  stdio: 'inherit',
  env: builderEnv()
})
child.on('exit', (code) => process.exit(code ?? 1))
