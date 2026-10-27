/**
 * 统一错误码与 IPC 结果封装。
 *
 * 设计要点：**跨进程不抛异常，只传结果**。
 * Electron 的 ipcMain.handle 抛出的错误到渲染层会退化成一个字符串
 * （"Error invoking remote method 'x': Error: ..."），code / 字段明细全部丢失。
 * 因此主进程统一返回 IpcResult，由渲染层的 api 层解包后再抛 ApiError。
 */

export const ERROR_CODES = {
  /** 入参未通过 zod 校验 */
  invalidArgument: 'E_INVALID_ARGUMENT',
  /** 记录或资源不存在 */
  notFound: 'E_NOT_FOUND',
  /** 契约已声明但该版本尚未实现 */
  notImplemented: 'E_NOT_IMPLEMENTED',
  /** 唯一约束、状态冲突 */
  conflict: 'E_CONFLICT',
  /** 文件系统 / 数据库 IO 失败 */
  io: 'E_IO',
  /** 超时（Python worker、网络书源） */
  timeout: 'E_TIMEOUT',
  /** 未预期异常，message 一律脱敏为通用文案 */
  internal: 'E_INTERNAL'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** zod 校验失败的字段级明细 */
export interface FieldError {
  /** 字段路径，如 "payload.message"；顶层字段为 "message" */
  path: string
  message: string
}

export interface AppErrorPayload {
  code: ErrorCode
  message: string
  /** 仅 invalidArgument 时存在 */
  fields?: FieldError[]
  /** 仅开发态回传，用于排查；生产态始终 undefined */
  stack?: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })

export const fail = (error: AppErrorPayload): IpcResult<never> => ({ ok: false, error })

/** 业务代码可抛它来表达"已知失败"，registry 会原样保留 code 与 message */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly fields?: FieldError[]

  constructor(code: ErrorCode, message: string, fields?: FieldError[]) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.fields = fields
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}
