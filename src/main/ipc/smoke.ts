/**
 * M0-04 自检：在**真实渲染层**里通过 preload 白名单调用 IPC，覆盖正常、非法入参、
 * 未实现通道、异常映射、白名单拦截与并发六个方向。
 *
 * 只在 `!app.isPackaged && CTEXT_IPC_SMOKE=1` 时由主进程调用，生产包进不来。
 */
import { app, type BrowserWindow } from 'electron'

interface SmokeItem {
  name: string
  ok: boolean
  detail?: string
}

/** 在渲染层执行的断言脚本，返回 JSON 字符串 */
const RENDERER_CASES = String.raw`
(async () => {
  const out = []
  const push = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  const api = window.api

  if (!api) {
    push('preload 已注入 window.api', false, 'window.api 为 undefined')
    return JSON.stringify(out)
  }
  push('preload 已注入 window.api', true)

  const okEcho = await api.invoke('system:echo', { message: 'ping' })
  push(
    'system:echo 往返成功',
    okEcho.ok && okEcho.data.message === 'ping' && okEcho.data.from === 'main',
    JSON.stringify(okEcho).slice(0, 160)
  )

  const badType = await api.invoke('system:echo', { message: 123 })
  push(
    '非法入参被 zod 拒绝',
    badType.ok === false && badType.error.code === 'E_INVALID_ARGUMENT',
    badType.ok ? '竟然通过了' : badType.error.code
  )
  push(
    '字段明细指向 message',
    badType.ok === false && (badType.error.fields || []).some((f) => f.path === 'message'),
    badType.ok ? '' : JSON.stringify(badType.error.fields || [])
  )

  const empty = await api.invoke('system:echo', { message: '' })
  push('空字符串被 min(1) 拒绝', empty.ok === false && empty.error.code === 'E_INVALID_ARGUMENT')

  const unknown = await api.invoke('evil:channel', { a: 1 })
  push(
    '未授权 invoke 通道被 preload 拒绝',
    unknown.ok === false && unknown.error.code === 'E_INVALID_ARGUMENT',
    unknown.ok ? '竟然通过了' : unknown.error.message
  )

  const todo = await api.invoke('library:list', {})
  push(
    '已声明未实现 → E_NOT_IMPLEMENTED',
    todo.ok === false && todo.error.code === 'E_NOT_IMPLEMENTED',
    todo.ok ? '竟然通过了' : todo.error.code
  )

  const info = await api.invoke('system:info')
  push(
    'system:info 返回版本与路径',
    info.ok && typeof info.data.version === 'string' && info.data.dbPath.endsWith('ctext.db'),
    info.ok ? 'v' + info.data.version : JSON.stringify(info)
  )

  const boom = await api.invoke('system:echo', { message: 'x', failMode: 'throw' })
  push(
    'handler 抛异常映射为 E_INTERNAL',
    boom.ok === false && boom.error.code === 'E_INTERNAL' && boom.error.message === '内部错误，请查看日志',
    boom.ok ? '竟然通过了' : boom.error.message
  )

  let evtRejected = false
  try {
    api.on('evil:event', () => {})
  } catch {
    evtRejected = true
  }
  push('未授权事件通道被 preload 拒绝', evtRejected)

  let sendRejected = false
  try {
    api.send('evil:send')
  } catch {
    sendRejected = true
  }
  push('未授权单向消息被 preload 拒绝', sendRejected)

  const st = await api.invoke('window:get-state')
  push(
    'window:get-state 返回窗口状态',
    st.ok && typeof st.data.maximized === 'boolean' && typeof st.data.fullscreen === 'boolean',
    st.ok ? JSON.stringify(st.data) : JSON.stringify(st)
  )

  const many = await Promise.all(
    Array.from({ length: 20 }, (_, i) => api.invoke('system:echo', { message: 'm' + i }))
  )
  push(
    '并发 20 次全部成功且顺序无关',
    many.every((r, i) => r.ok && r.data.message === 'm' + i),
    many.filter((r) => !r.ok).length + ' 个失败'
  )

  const t0 = performance.now()
  const slow = await api.invoke('system:echo', { message: 'slow', delayMs: 120 })
  const dt = performance.now() - t0
  push('delayMs 生效且无额外开销', slow.ok && dt >= 110 && dt < 900, Math.round(dt) + 'ms')

  const noArg = await api.invoke('system:info', 'unexpected')
  push(
    '无入参通道拒收多余实参',
    noArg.ok === false && noArg.error.code === 'E_INVALID_ARGUMENT',
    noArg.ok ? '竟然通过了' : noArg.error.code
  )

  return JSON.stringify(out)
})()
`

export async function runIpcSmoke(win: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  let items: SmokeItem[] = []
  try {
    const raw = (await win.webContents.executeJavaScript(RENDERER_CASES)) as string
    items = JSON.parse(raw) as SmokeItem[]
  } catch (err) {
    items = [{ name: '自检脚本执行', ok: false, detail: err instanceof Error ? err.message : String(err) }]
  }

  for (const item of items) {
    console.log(`SMOKE IPC ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = items.filter((i) => !i.ok).length
  console.log(`SMOKE IPC SUMMARY ${items.length - failed}/${items.length}`)

  win.destroy()
  app.exit(failed === 0 && items.length > 0 ? 0 : 1)
}
