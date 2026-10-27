/**
 * IPC 注册器：所有跨进程调用的唯一入口。
 *
 * 职责（顺序不可调换）：
 *   1. 未实现的通道直接回 E_NOT_IMPLEMENTED，不进入 handler
 *   2. zod 校验入参，失败回 E_INVALID_ARGUMENT + 字段明细，并记 warn 日志
 *   3. 执行业务 handler，异常统一映射成结构化错误（不把原始异常抛过桥）
 *   4. 记录耗时（debug 级，避免刷日志）
 *
 * 关键不变量：**ipcMain.handle 的回调永远不抛异常**。一旦抛出，Electron 会把错误
 * 降级成字符串，渲染层丢失 code 与字段明细，M0-06 的错误码映射就无从谈起。
 */
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { ZodType } from 'zod'
import { ERROR_CODES, type AppErrorPayload, type FieldError, type IpcResult } from '@shared/errors'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEvents,
  IpcInput,
  IpcOutput,
  IpcSendChannel,
  IpcSends
} from '@shared/ipc/contract'
import { INVOKE_CHANNELS, SEND_CHANNELS } from '@shared/ipc/channels'
import { ipcSchemas, type ValidatedChannel } from '@shared/ipc/schemas'
import { createLogger } from '../log'
import { toAppError } from '../utils/to-app-error'

const log = createLogger('ipc')

export interface IpcContext {
  /** 发起调用的窗口；调用方已销毁时为 null */
  window: BrowserWindow | null
  /** 请求到达时间（performance.now），用于计算耗时 */
  startedAt: number
}

/** 单向消息（Renderer → Main）的上下文；payload 已在契约里声明过类型 */
export interface IpcSendContext<K extends IpcSendChannel> {
  window: BrowserWindow | null
  payload: IpcSends[K]
}

export type IpcHandler<K extends IpcChannel> = (
  input: IpcInput<K>,
  ctx: IpcContext
) => IpcOutput<K> | Promise<IpcOutput<K>>

export type IpcSendHandler<K extends IpcSendChannel> = (ctx: IpcSendContext<K>) => void

const handlers = new Map<string, (input: unknown, ctx: IpcContext) => unknown>()
const sendHandlers = new Map<string, (ctx: IpcSendContext<IpcSendChannel>) => void>()
let installed = false

/**
 * 注册 invoke handler。
 *
 * 参数类型 K 只允许 `ValidatedChannel`（即 schemas.ts 里有 schema 的通道），
 * 因此「加了 handler 却忘了写 schema」在编译期就过不去。
 */
export function registerHandler<K extends ValidatedChannel>(channel: K, handler: IpcHandler<K>): void {
  if (handlers.has(channel)) {
    throw new Error(`IPC 通道重复注册: ${channel}`)
  }
  handlers.set(channel, handler as (input: unknown, ctx: IpcContext) => unknown)
}

/** 注册 Renderer → Main 的单向消息 */
export function registerSend<K extends IpcSendChannel>(channel: K, handler: IpcSendHandler<K>): void {
  if (sendHandlers.has(channel)) {
    throw new Error(`IPC send 通道重复注册: ${channel}`)
  }
  sendHandlers.set(channel, handler as IpcSendHandler<IpcSendChannel>)
}

/** 向指定窗口推事件（Main → Renderer） */
export function emitTo<K extends IpcEventChannel>(win: BrowserWindow | null, channel: K, payload: IpcEvents[K]): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/** 向所有存活窗口广播事件 */
export function broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) emitTo(win, channel, payload)
}

function fieldErrorsOf(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '(root)',
    message: issue.message
  }))
}

/** 只保留入参的「形状」，避免把整段正文或大数组打进日志 */
function summarizeInput(raw: unknown): unknown {
  if (raw === undefined) return '(undefined)'
  if (typeof raw === 'string') return raw.length > 200 ? `${raw.slice(0, 200)}…(${raw.length} 字)` : raw
  return raw
}

/**
 * 异常 → 对外错误载荷。
 *
 * 统一走 `toAppError`：底层英文 message（ENOENT / SQLITE_* / 堆栈）不会出现在载荷里，
 * 只有 AppError 主动给出的业务文案才会透给渲染层。原始异常只进日志。
 */
function toPayload(channel: string, err: unknown): AppErrorPayload {
  const appError = toAppError(err)

  if (appError.code === ERROR_CODES.internal) {
    log.error(`${channel} 未预期异常`, { channel, error: err })
  } else {
    log.warn(`${channel} 业务失败 ${appError.code}`, { channel, code: appError.code, message: appError.message })
  }

  const payload: AppErrorPayload = { code: appError.code, message: appError.message }
  if (appError.fields && appError.fields.length > 0) payload.fields = appError.fields
  // 堆栈只在开发态回传；生产态只剩「内部错误，请查看日志」+ 日志文件
  const isProd = process.env['NODE_ENV'] === 'production'
  if (!isProd && appError.code === ERROR_CODES.internal) {
    payload.stack = err instanceof Error ? err.stack ?? err.message : String(err)
  }
  return payload
}

async function invokeWith(
  channel: string,
  handler: ((input: unknown, ctx: IpcContext) => unknown) | undefined,
  event: IpcMainInvokeEvent,
  raw: unknown
): Promise<IpcResult<unknown>> {
  if (!handler) {
    log.warn(`${channel} 被调用，但当前版本未实现`)
    return { ok: false, error: { code: ERROR_CODES.notImplemented, message: `${channel} 尚未实现` } }
  }

  const schema = (ipcSchemas as Record<string, ZodType | undefined>)[channel]
  if (!schema) {
    // 类型系统已禁止走到这里，留运行时兜底以防白名单与 schema 表被人为改坏
    log.error(`${channel} 没有 zod schema，拒绝执行`)
    return { ok: false, error: { code: ERROR_CODES.internal, message: '内部错误：通道缺少校验规则' } }
  }

  const ctx: IpcContext = {
    window: BrowserWindow.fromWebContents(event.sender),
    startedAt: performance.now()
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const fields = fieldErrorsOf(parsed.error.issues)
    log.warn(`入参校验失败 ${channel}`, {
      channel,
      code: ERROR_CODES.invalidArgument,
      fields,
      received: summarizeInput(raw)
    })
    return { ok: false, error: { code: ERROR_CODES.invalidArgument, message: '参数校验失败', fields } }
  }

  try {
    const data = await handler(parsed.data, ctx)
    log.debug(`${channel} ok`, { channel, elapsedMs: Number((performance.now() - ctx.startedAt).toFixed(1)) })
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: toPayload(channel, err) }
  }
}

/**
 * 安装所有通道。必须在 app ready 之后调用（ipcMain 在 ready 前可注册，
 * 但 fromWebContents 依赖窗口，放在 ready 之后语义更清晰）。
 * 重复调用是空操作，方便测试里反复进入。
 */
export function installIpc(): void {
  if (installed) return
  installed = true

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event, raw: unknown) => invokeWith(channel, handlers.get(channel), event, raw))
  }

  for (const channel of SEND_CHANNELS) {
    ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
      const handler = sendHandlers.get(channel)
      if (!handler) {
        log.warn(`${channel} 消息到达，但当前版本未实现`)
        return
      }
      try {
        handler({ window: BrowserWindow.fromWebContents(event.sender), payload } as IpcSendContext<IpcSendChannel>)
      } catch (err) {
        log.error(`${channel} 处理失败`, { channel, error: err })
      }
    })
  }

  const stubs = INVOKE_CHANNELS.length - handlers.size
  log.info(`IPC 就绪：invoke ${INVOKE_CHANNELS.length}（实现 ${handlers.size}，占位 ${stubs}），send ${SEND_CHANNELS.length}`)
}
