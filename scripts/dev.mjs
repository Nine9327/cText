/**
 * 开发启动包装器。
 *
 * 解决的问题：
 * 1. WorkBuddy / VS Code 等 IDE 的终端会预设 ELECTRON_RUN_AS_NODE=1，
 *    Electron 因此退化成纯 Node 运行 main/index.js，窗口根本不会出现
 *    （报错类似 `Cannot find module` 后 exit 1）。这里在派生子进程前清掉。
 * 2. 本机同时存在 MuMu / GameViewer 虚拟显示适配器，GPU 沙箱会导致
 *    GPU 进程 0xC0000005 崩溃并拖死主进程。主进程已按 isDev 关闭 GPU 沙箱，
 *    这里不再重复处理。
 *
 * 用法：
 *   pnpm dev        → electron-vite dev（开发，带 HMR）
 *   pnpm start      → electron-vite preview（加载 out/ 里的构建产物）
 *   也可直接：node scripts/dev.mjs <dev|preview> [...参数]
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

const [command = 'dev', ...rest] = process.argv.slice(2)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 让 electron-vite 在正确的工作目录里解析配置
env.FORCE_COLOR = process.stdout.isTTY ? '1' : '0'

const child = spawn(process.execPath, [entry, command, ...rest], {
  cwd: root,
  stdio: 'inherit',
  env
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

// Ctrl+C 时确保子进程被终止，避免残留 Electron 实例
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
