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
  /** 文件能打开但内容坏了 / 加密 / 不是声明的那种格式（M1-05） */
  parseFailed: 'E_PARSE_FAILED',
  /**
   * 书籍所在的根目录当前离线（M2-01）。
   *
   * **只由主进程产生**，不经过 Python 桥——所以 `bridge/protocol.ts` 的
   * KNOWN_CODES 里没有它（那里限制的是 worker 能回传哪些码）。
   * 与 E_NOT_FOUND 分开是为了让阅读器能给不同提示：离线是「插上磁盘/重新指定目录」，
   * 缺失是「文件被移动或删除了」。
   */
  rootOffline: 'E_ROOT_OFFLINE',
  /** 未预期异常，message 一律脱敏为通用文案 */
  internal: 'E_INTERNAL'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * 错误码 → 默认中文文案（M0-06 统一映射）。
 *
 * 三层共用同一份文案：
 *   - 主进程把底层错误（errno / SQLITE_* / 未知异常）收敛成 AppError 时兜底；
 *   - 渲染层在没拿到具体 message 时用它兜底；
 *   - 将来「错误码对照表」文档与问题反馈面板直接引它，不再手抄一遍。
 *
 * 文案原则：说清「发生了什么」+「用户能做什么」，不出现堆栈、SQL、绝对路径。
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_INVALID_ARGUMENT: '请求参数不合法',
  E_NOT_FOUND: '内容不存在，可能已被移动或删除',
  E_NOT_IMPLEMENTED: '该功能尚未实现',
  E_CONFLICT: '数据冲突，请刷新后重试',
  E_IO: '读写失败，请检查磁盘或权限',
  E_TIMEOUT: '操作超时，请稍后重试',
  E_PARSE_FAILED: '文件解析失败，可能已损坏或加密',
  E_ROOT_OFFLINE: '书籍所在的目录当前不可用，连接磁盘或重新指定目录后即可继续阅读',
  E_INTERNAL: '内部错误，请查看日志'
}

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, value)
}

/** 取错误码对应的默认文案；未知码回落到 E_INTERNAL 的文案 */
export function messageOf(code: string): string {
  return isErrorCode(code) ? ERROR_MESSAGES[code] : ERROR_MESSAGES.E_INTERNAL
}

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
