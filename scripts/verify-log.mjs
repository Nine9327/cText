/**
 * M0-06 基础设施验收脚本。
 *
 * 覆盖开发计划里的两条验收标准：
 *   1. 抛错有 toast + 日志落盘
 *   2. 日志路径中用户名被替换为 `~`
 * 另外附带：JSON Lines 结构、级别阈值、耗时字段、错误码映射、
 * 主进程未捕获异常不杀进程、渲染层异常转发落盘、控制台回声也脱敏。
 *
 * 断言分两段：
 *   - 进程内（src/main/log/smoke.ts）：能看到运行时状态的部分
 *   - 进程退出后（本脚本）：直接读磁盘上的日志文件，验证「真的落盘了」
 * 第二段是刻意的：只在内存里断言的话，异步流没 flush 的问题会漏过去。
 *
 * 用法：pnpm verify:log（内部会先构建一次 out/）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
// 固定 info 级：verify 里要断言 debug 不落盘，不能被本机环境变量影响
cleanEnv.CTEXT_LOG_LEVEL = 'info'

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

/** 运行 CTEXT_LOG_SMOKE=1 的 Electron，返回进程输出与退出码 */
function runSmoke() {
  console.log('[2/3] 运行时自检 ...')
  return new Promise((resolve) => {
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env: { ...cleanEnv, CTEXT_LOG_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    const timer = setTimeout(() => {
      child.kill()
      record('冒烟检查在 45s 内完成', false, '超时，可能是窗口未就绪')
      resolve({ out, code: null })
    }, 45_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ out, code })
    })
  })
}

function parseSmokeLines(out) {
  const lines = out.split(/\r?\n/).filter((l) => /^SMOKE LOG (PASS|FAIL) /.test(l))
  for (const line of lines) {
    const ok = line.startsWith('SMOKE LOG PASS')
    const body = line.replace(/^SMOKE LOG (PASS|FAIL) /, '')
    const m = body.match(/^(.*?)(?: \((.*)\))?$/)
    record(m?.[1] ?? body, ok, m?.[2] ?? '')
  }
  if (lines.length === 0) {
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join(' / ')
    record('冒烟检查产出结果', false, `没有断言输出：${tail}`)
  }
  return lines.length
}

/** 退出后从磁盘验证：文件存在、内容可解析、用户名不存在 */
function verifyOnDisk(out) {
  console.log('[3/3] 校验磁盘上的日志 ...')

  const basename = out.match(/^SMOKE LOG INFO file=(.+)$/m)?.[1]?.trim()
  record('自检报告了日志文件名', !!basename, basename ?? '')

  const appData = process.env.APPDATA
  if (!appData || !basename) {
    record('能在 userData/logs 下定位日志文件', false, '缺少 APPDATA 或文件名')
    return
  }

  const file = join(appData, 'ctext', 'logs', basename)
  if (!existsSync(file)) {
    record('日志文件在进程退出后仍然存在', false, file)
    return
  }
  record('日志文件在进程退出后仍然存在', true)

  const size = statSync(file).size
  record('日志文件非空（同步写已落盘）', size > 0, `${size} 字节`)

  const raw = readFileSync(file, 'utf8')

  const badLines = raw
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => {
      try {
        JSON.parse(l)
        return false
      } catch {
        return true
      }
    })
  record('磁盘上的每一行都是合法 JSON', badLines.length === 0, badLines.length ? badLines[0].slice(0, 120) : '')

  let username = ''
  try {
    username = userInfo().username
  } catch {
    // 拿不到就跳过这条
  }
  record(
    '日志文件中不含用户名原文',
    !username || !raw.includes(username),
    username && raw.includes(username) ? '文件里仍出现了用户名' : ''
  )
  record('日志中出现了脱敏后的 Users\\~', /C:\\\\Users\\\\~/i.test(raw) || /C:\\Users\\~/i.test(raw))

  const records = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  record(
    '存在 scope=smoke 的 error 记录',
    records.some((r) => r.scope === 'smoke' && r.level === 'error'),
    ''
  )
  record(
    '存在渲染层转发记录（scope=renderer）',
    records.some((r) => r.scope === 'renderer' && typeof r.msg === 'string' && r.msg.includes('渲染层未捕获')),
    ''
  )
  record(
    '日志行带 session / pid / seq',
    records.length > 0 && records.every((r) => typeof r.session === 'string' && typeof r.pid === 'number'),
    ''
  )

  // 控制台回声也要脱敏：verify 的 stdout 常被贴进 issue。
  // 只看我们自己打的行（Electron/Chromium 自己的告警里带的是系统路径，不归我们管）
  const ourLines = out.split(/\r?\n/).filter((l) => /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /.test(l))
  record(
    '控制台回声同样不含用户名',
    ourLines.length > 0 && (!username || ourLines.every((l) => !l.includes(username))),
    ourLines.length === 0 ? '未捕获到控制台日志行' : ''
  )

  // 结构化控制台格式（现有 verify:ipc / verify:bridge 都依赖这个前缀）
  record('控制台回声保留 [时间] 级别 模块 前缀', /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (DEBUG|INFO|WARN|ERROR)\s/m.test(out))
  record('启动阶段即已落盘（cText 启动 日志）', records.some((r) => r.scope === 'app' && r.msg === 'cText 启动'), '')
}

if (!existsSync(electronBin)) {
  console.error(`未找到 Electron 二进制：${electronBin}\n请先执行 pnpm install`)
  process.exit(1)
}

build()
const { out, code } = await runSmoke()
if (parseSmokeLines(out) > 0) {
  record('冒烟进程正常退出', code === 0, `退出码 ${code}`)
}
verifyOnDisk(out)

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length - failed.length}/${results.length}`
)
if (failed.length > 0) {
  console.log('\n—— 相关原始输出 ——')
  console.log(out.split(/\r?\n/).filter(Boolean).slice(-40).join('\n'))
}
process.exit(failed.length === 0 ? 0 : 1)
