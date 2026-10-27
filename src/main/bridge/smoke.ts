/**
 * M0-05 自检：NDJSON 解码器 + 真实 Python worker + 崩溃恢复。
 *
 * 只在 `!app.isPackaged && CTEXT_BRIDGE_SMOKE=1` 时执行，生产包进不来。
 *
 * 分三段：
 *   A. 解码器离线断言（不需要 Python）：半包、粘包、坏帧、超长行
 *   B. 真实 worker：握手、health.ping、未知方法、超时、坏帧容错、并发、杀进程自恢复
 *   C. 渲染层经 IPC 读取健康状态（验证 UI 侧的链路真的通）
 * 另外用第二个 bridge 实例单独验证「3 次 / 5 分钟」的重启上限与手动恢复。
 */
import type { BrowserWindow } from 'electron'
import { getPythonBridge } from './index'
import { PythonBridge } from './PythonBridge'
import { resolveLaunch } from './launch'
import { NdjsonDecoder, toErrorCode } from './protocol'

interface SmokeItem {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(40)
  }
  return predicate()
}

/** 判断进程是否还活着（Windows 上 process.kill(pid, 0) 语义在 Node 里同样可用） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function decoderChecks(checks: SmokeItem[]): void {
  const push = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // 半包：一次 data 只有半行
  const d = new NdjsonDecoder()
  const part1 = d.push('{"id":"a",')
  const part2 = d.push('"ok":true,"result":1}\n')
  push(
    '解码器容忍半包',
    part1.frames.length === 0 && part2.frames.length === 1,
    `首次 ${part1.frames.length} 帧，续传后 ${part2.frames.length} 帧`
  )

  // 粘包：一次 data 里有多个完整帧
  const sticky = d.push('{"id":"b","ok":true,"result":2}\n{"id":"c","ok":true,"result":3}\n')
  push('解码器处理粘包', sticky.frames.length === 2, `${sticky.frames.length} 帧`)

  // 坏行：跳过但不影响后续
  const bad = d.push('not json\n{"id":"d","ok":true,"result":4}\n')
  push(
    '坏帧被跳过且不中断',
    bad.problems.length === 1 && bad.frames.length === 1,
    `problems=${bad.problems.length} frames=${bad.frames.length}`
  )

  // 超长行：丢弃整行，之后仍能解析
  const small = new NdjsonDecoder(16)
  small.push(`{"id":"x","ok":true,"result":"${'a'.repeat(80)}`)
  const afterOverflow = small.push('\n{"id":"y","ok":true,"result":1}\n')
  push(
    '超长帧被丢弃后恢复',
    afterOverflow.problems.length === 1 && afterOverflow.frames.length === 1,
    `problems=${afterOverflow.problems.length} frames=${afterOverflow.frames.length}`
  )

  // 错误帧归一化
  const err = d.push('{"id":"e","ok":false,"error":{"code":"E_IO","message":"写盘失败"}}\n')
  const errFrame = err.frames[0]
  push(
    '错误帧被正确还原',
    !!errFrame && !('event' in errFrame) && errFrame.ok === false && errFrame.error.code === 'E_IO',
    errFrame && !('event' in errFrame) && !errFrame.ok ? errFrame.error.message : '形状不符'
  )

  push('未知错误码归为 E_INTERNAL', toErrorCode('E_WEIRD') === 'E_INTERNAL', toErrorCode('E_WEIRD'))
}

async function workerChecks(checks: SmokeItem[]): Promise<void> {
  const push = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })
  const bridge = getPythonBridge()
  const t0 = Date.now()

  bridge.start()
  const ready = await waitFor(() => bridge.state === 'ready', 10_000)
  push('worker 握手完成', ready, `${bridge.state}，用时 ${Date.now() - t0}ms`)
  if (!ready) {
    push('后续 worker 断言', false, `未就绪：${bridge.getStatus().lastError ?? ''}`)
    return
  }

  // 验收标准前半句：health.ping 返回版本与 pid
  const health = await bridge.ping()
  push(
    'health.ping 返回版本与 pid',
    typeof health.version === 'string' && health.version.length > 0 && health.pid > 0,
    `v${health.version} pid=${health.pid} python=${health.python}`
  )
  push(
    'health.ping 上报已注册方法',
    health.methods.includes('health.ping') && health.methods.includes('debug.crash'),
    health.methods.join(',')
  )
  push(
    '解析依赖已装入 .venv',
    Object.values(health.deps).every(Boolean),
    Object.entries(health.deps)
      .map(([k, v]) => `${k}=${v ? 'ok' : 'missing'}`)
      .join(' ')
  )

  // 未知方法 → E_NOT_IMPLEMENTED（错误码透传）
  let unknownCode = ''
  try {
    await bridge.request('nope.method')
  } catch (err) {
    unknownCode = (err as { code?: string }).code ?? ''
  }
  push('未知方法映射为 E_NOT_IMPLEMENTED', unknownCode === 'E_NOT_IMPLEMENTED', unknownCode || '未抛错')

  // 超时：请求本身的超时，不牵连进程
  const tSlow = Date.now()
  let timeoutCode = ''
  try {
    await bridge.request('debug.sleep', { ms: 600 }, { timeoutMs: 150 })
  } catch (err) {
    timeoutCode = (err as { code?: string }).code ?? ''
  }
  const slowMs = Date.now() - tSlow
  push(
    '请求超时映射为 E_TIMEOUT 且不杀进程',
    timeoutCode === 'E_TIMEOUT' && bridge.state === 'ready',
    `${timeoutCode} 用时 ${slowMs}ms 状态 ${bridge.state}`
  )

  // 超时后迟到的响应不能污染后续请求
  await sleep(600)
  const afterTimeout = await bridge.ping()
  push('超时后 worker 仍可用', afterTimeout.pid === health.pid, `pid=${afterTimeout.pid}`)

  // worker 吐出坏行，桥接层应跳过并继续工作
  const garbage = await bridge.request<{ garbageWritten: boolean }>('debug.garbage')
  const afterGarbage = await bridge.ping()
  push(
    'worker 吐出坏帧后桥接层存活',
    garbage.garbageWritten && afterGarbage.pid === health.pid,
    `pid=${afterGarbage.pid}`
  )

  // 并发：4 线程池应能重叠执行
  const tConcurrent = Date.now()
  const many = await Promise.all(
    Array.from({ length: 8 }, () => bridge.request<{ sleptMs: number }>('debug.sleep', { ms: 120 }))
  )
  const concurrentMs = Date.now() - tConcurrent
  push(
    '并发 8 个请求全部成功',
    many.length === 8 && many.every((m) => m.sleptMs === 120),
    `${concurrentMs}ms（串行应 ≥960ms）`
  )
  push('并发确实重叠执行', concurrentMs < 800, `${concurrentMs}ms < 800ms`)

  // 验收标准后半句：手动杀进程后自恢复
  const pidBefore = bridge.pid
  if (!pidBefore) {
    push('崩溃自恢复', false, '取不到 pid')
    return
  }
  process.kill(pidBefore)

  // ① 崩溃瞬间的在途请求必须被拒绝，不能挂起（挂起会让导入队列永久卡住）
  let inflightCode = ''
  try {
    await bridge.ping(5_000)
  } catch (err) {
    inflightCode = (err as { code?: string }).code ?? 'no-code'
  }
  push('崩溃时在途请求被拒绝而非挂起', inflightCode === 'E_IO', inflightCode || '竟然成功了')

  // ② 3s 内重新变为 ready，且是新进程
  const tKill = Date.now()
  const recovered = await waitFor(() => bridge.state === 'ready' && bridge.pid !== null, 3_000)
  const recoverMs = Date.now() - tKill
  let recoveredPid = 0
  if (recovered) {
    try {
      recoveredPid = (await bridge.ping(5_000)).pid
    } catch (err) {
      push('自恢复后 ping 成功', false, String(err))
    }
  }
  push(
    '杀进程后 3s 内自恢复',
    recovered && recoveredPid > 0 && recoveredPid !== pidBefore && recoverMs < 3_000,
    `pid ${pidBefore} → ${recoveredPid || '?'}，${recoverMs}ms`
  )
  push('恢复后状态为 ready', bridge.state === 'ready', bridge.state)
}

/** 渲染层经 IPC 读取健康状态（验证 UI 侧链路，而不只是桥接层内部） */
async function rendererCheck(win: BrowserWindow, checks: SmokeItem[]): Promise<void> {
  const push = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // 页面没加载完时 window.api 还不存在，直接断言会得到误导性的失败
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  const raw = (await win.webContents.executeJavaScript(String.raw`
    (async () => {
      const r = await window.api.invoke('system:worker-health')
      if (!r.ok) return JSON.stringify({ ok: false, detail: r.error.code + ' ' + r.error.message })
      return JSON.stringify({
        ok: true,
        state: r.data.state,
        pid: r.data.worker && r.data.worker.pid,
        version: r.data.worker && r.data.worker.version,
        restarts: r.data.restarts
      })
    })()
  `)) as string

  const parsed = JSON.parse(raw) as {
    ok: boolean
    detail?: string
    state?: string
    pid?: number
    version?: string
  }
  push(
    'system:worker-health 经 IPC 返回就绪状态',
    parsed.ok && parsed.state === 'ready' && (parsed.pid ?? 0) > 0,
    parsed.ok ? `state=${parsed.state} pid=${parsed.pid} v${parsed.version}` : (parsed.detail ?? '')
  )
}

/** 重启上限：3 次 / 5 分钟内反复崩溃 → failed，且后续请求立即失败；retry() 可恢复 */
async function restartLimitChecks(checks: SmokeItem[]): Promise<void> {
  const push = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })
  const plan = resolveLaunch()
  const bridge = new PythonBridge({ ...plan, maxRestarts: 3, defaultTimeoutMs: 5_000 })

  bridge.start()
  const ready = await waitFor(() => bridge.state === 'ready', 10_000)
  if (!ready) {
    push('重启上限：worker 就绪', false, bridge.getStatus().lastError ?? '未就绪')
    await bridge.stop(500)
    return
  }

  // 连续触发崩溃，直到进入 failed（正常情况下 3 次即止）
  for (let i = 0; i < 6 && bridge.state !== 'failed'; i += 1) {
    await bridge.request('debug.crash').catch(() => undefined)
    await waitFor(() => bridge.state === 'ready' || bridge.state === 'failed', 6_000)
  }

  const status = bridge.getStatus()
  push(
    '连续崩溃 3 次后进入 failed',
    status.state === 'failed',
    `state=${status.state} restarts=${status.restarts}`
  )
  push('重启次数不超过上限', status.restarts <= 3, `restarts=${status.restarts}`)

  let failCode = ''
  try {
    await bridge.request('health.ping', undefined, { timeoutMs: 1_000 })
  } catch (err) {
    failCode = (err as { code?: string }).code ?? 'no-code'
  }
  push('failed 状态下请求立即失败', failCode === 'E_IO', failCode)

  // 手动重试（界面上「重新连接」）：清空计数后应能恢复
  bridge.retry()
  const back = await waitFor(() => bridge.state === 'ready', 10_000)
  const health = back ? await bridge.ping(5_000) : null
  push('retry() 后恢复可用', back && !!health && health.pid > 0, health ? `pid=${health.pid}` : bridge.state)

  const pid = bridge.pid
  await bridge.stop(1_000)
  const stopped = await waitFor(() => bridge.state === 'stopped', 2_000)
  push(
    'stop() 后进程退出且状态为 stopped',
    stopped && bridge.pid === null && (!pid || !isAlive(pid)),
    `state=${bridge.state} pid=${pid ?? 'null'}`
  )
}

export async function runBridgeSmoke(win: BrowserWindow | null): Promise<number> {
  const checks: SmokeItem[] = []

  decoderChecks(checks)
  try {
    await workerChecks(checks)
    if (win) await rendererCheck(win, checks)
    else checks.push({ name: '渲染层 IPC 健康检查', ok: false, detail: '无可用窗口' })
  } catch (err) {
    checks.push({
      name: 'worker 断言执行',
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  try {
    await restartLimitChecks(checks)
  } catch (err) {
    checks.push({
      name: '重启上限断言执行',
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  for (const c of checks) {
    console.log(`SMOKE BRIDGE ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`SMOKE BRIDGE SUMMARY ${checks.length - failed}/${checks.length}`)

  win?.destroy()
  return failed === 0 && checks.length > 0 ? 0 : 1
}
