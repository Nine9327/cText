/**
 * M0-04 IPC 框架验收脚本。
 *
 * 覆盖开发计划中的两条验收标准：
 *   1. 渲染层调用 echo 接口通过
 *   2. 非法入参被 zod 拒绝并记日志
 * 另外附带：未实现通道回 E_NOT_IMPLEMENTED、handler 异常映射、preload 白名单拦截、
 * 并发调用与 delayMs 生效。
 *
 * 与 verify:shell 一样，断言跑在**真实渲染层**里（executeJavaScript），走的是真
 * preload 桥 + 真 ipcMain，不是 mock。
 *
 * 用法：pnpm verify:ipc（内部会先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function runSmoke() {
  console.log('[2/2] IPC 冒烟检查 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_IPC_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 40s 内完成', false, '超时，可能是窗口未就绪')
      resolve()
    }, 40_000)

    child.on('exit', (code) => {
      clearTimeout(timer)

      const lines = out.split(/\r?\n/).filter((l) => /^SMOKE IPC (PASS|FAIL) /.test(l))
      for (const line of lines) {
        const ok = line.startsWith('SMOKE IPC PASS')
        const body = line.replace(/^SMOKE IPC (PASS|FAIL) /, '')
        const m = body.match(/^(.*?)(?: \((.*)\))?$/)
        record(m?.[1] ?? body, ok, m?.[2] ?? '')
      }
      if (lines.length === 0) {
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join(' / ')
        record('冒烟检查产出结果', false, `进程退出码 ${code}，无断言输出：${tail}`)
      }

      // 验收标准后半句「并记日志」：主进程必须有校验失败的 warn 记录
      record(
        '非法入参在主进程留下 warn 日志',
        /WARN\s+ipc 入参校验失败 system:echo/.test(out),
        /WARN\s+ipc 入参校验失败/.test(out) ? '' : '未在输出中找到校验失败日志'
      )
      record('registry 启动日志存在', /INFO\s+ipc IPC 就绪/.test(out), '')

      resolve()
    })
  })
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

build()
await runSmoke()

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`
)
process.exit(failed.length === 0 ? 0 : 1)
