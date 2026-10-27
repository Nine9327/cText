/**
 * 统一错误码映射（M0-06）。
 *
 * 目标：**任何从主进程抛出来的东西，最终都收敛成 7 个错误码之一**，
 * 渲染层因此只需要按 code 决定文案与交互（重试 / 提示去设置页 / 直接报 bug），
 * 而不必去猜 `err.message` 里那串英文是什么。
 *
 * 三类输入：
 *   1. `AppError` —— 业务代码主动表达"已知失败"，原样透传（含 fields）
 *   2. Node/底层错误的 `code` —— fs 的 errno（ENOENT/EACCES…）、SQLite 的 SQLITE_*、
 *      zod 的校验错误。这类错误**不能**把原始 message 交给用户：
 *      "ENOENT: no such file or directory, open 'C:\Users\x\...'" 既看不懂也泄漏路径。
 *   3. 其他 —— 一律 E_INTERNAL，文案固定为通用提示，原文只进日志。
 *
 * 这个模块是**纯函数**（不写日志、不碰 Electron），方便单测与复用。
 */
import { ZodError } from 'zod'
import {
  AppError,
  ERROR_CODES,
  ERROR_MESSAGES,
  isErrorCode,
  type AppErrorPayload,
  type ErrorCode,
  type FieldError
} from '@shared/errors'

interface Mapped {
  code: ErrorCode
  message: string
}

/** 文件系统 errno → 错误码 */
const ERRNO: Record<string, Mapped> = {
  ENOENT: { code: ERROR_CODES.notFound, message: '文件或目录不存在，可能已被移动或删除' },
  EACCES: { code: ERROR_CODES.io, message: '没有访问权限，请检查文件或所在磁盘的权限' },
  EPERM: { code: ERROR_CODES.io, message: '操作被系统拒绝' },
  EBUSY: { code: ERROR_CODES.io, message: '文件正被其他程序占用' },
  EROFS: { code: ERROR_CODES.io, message: '目标磁盘为只读' },
  ENOSPC: { code: ERROR_CODES.io, message: '磁盘空间不足' },
  EMFILE: { code: ERROR_CODES.io, message: '同时打开的文件过多，请稍后重试' },
  ENFILE: { code: ERROR_CODES.io, message: '系统文件句柄已用尽，请稍后重试' },
  EISDIR: { code: ERROR_CODES.invalidArgument, message: '期望一个文件，但收到的是目录' },
  ENOTDIR: { code: ERROR_CODES.invalidArgument, message: '路径中的某一段不是目录' },
  ENAMETOOLONG: { code: ERROR_CODES.invalidArgument, message: '路径过长' },
  EEXIST: { code: ERROR_CODES.conflict, message: '目标已存在' }
}

/** SQLite 错误码（better-sqlite3 的 err.code）→ 错误码，按前缀最长匹配 */
const SQLITE: readonly (readonly [string, Mapped])[] = [
  ['SQLITE_CONSTRAINT_UNIQUE', { code: ERROR_CODES.conflict, message: '记录已存在' }],
  ['SQLITE_CONSTRAINT_PRIMARYKEY', { code: ERROR_CODES.conflict, message: '记录已存在' }],
  ['SQLITE_CONSTRAINT_FOREIGNKEY', { code: ERROR_CODES.conflict, message: '关联的数据不存在' }],
  ['SQLITE_CONSTRAINT_NOTNULL', { code: ERROR_CODES.invalidArgument, message: '必填字段为空' }],
  ['SQLITE_CONSTRAINT_CHECK', { code: ERROR_CODES.invalidArgument, message: '数据不满足约束' }],
  ['SQLITE_CONSTRAINT', { code: ERROR_CODES.conflict, message: '数据冲突' }],
  ['SQLITE_BUSY', { code: ERROR_CODES.io, message: '数据库忙，请稍后重试' }],
  ['SQLITE_LOCKED', { code: ERROR_CODES.io, message: '数据库被锁定，请稍后重试' }],
  ['SQLITE_READONLY', { code: ERROR_CODES.io, message: '数据库文件为只读' }],
  ['SQLITE_FULL', { code: ERROR_CODES.io, message: '磁盘空间不足' }],
  ['SQLITE_CORRUPT', { code: ERROR_CODES.io, message: '数据库文件损坏' }],
  ['SQLITE_NOTADB', { code: ERROR_CODES.io, message: '不是有效的数据库文件' }],
  ['SQLITE_PERM', { code: ERROR_CODES.io, message: '没有数据库文件的访问权限' }]
]

function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  return typeof value === 'string' ? value : String(value)
}

function zodFields(err: ZodError): FieldError[] {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '(root)',
    message: issue.message
  }))
}

/**
 * 把任意异常收敛成 AppError。
 *
 * 注意：返回的 `message` **已经是可以直接展示给用户的文案**，
 * 原始英文 message 不会出现在里面（除了 AppError 主动给出的业务文案）。
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err

  if (err instanceof ZodError) {
    const fields = zodFields(err)
    const first = fields[0]
    return new AppError(
      ERROR_CODES.invalidArgument,
      first ? `${first.path === '(root)' ? '参数' : first.path} ${first.message}` : ERROR_MESSAGES.E_INVALID_ARGUMENT,
      fields
    )
  }

  const code = errorCodeOf(err)

  if (code) {
    // 已经是我们自己的错误码（例如 Python worker 的 toErrorCode 结果）
    if (isErrorCode(code)) {
      return new AppError(code, messageOf(err) || ERROR_MESSAGES[code])
    }

    const sqlite = SQLITE.find(([prefix]) => code.startsWith(prefix))
    if (sqlite) return new AppError(sqlite[1].code, sqlite[1].message)

    const errno = ERRNO[code]
    if (errno) return new AppError(errno.code, errno.message)
  }

  return new AppError(ERROR_CODES.internal, ERROR_MESSAGES.E_INTERNAL)
}

/**
 * 转成跨进程传输的载荷。
 * `stack` 只在开发态回传，生产态一律不带——堆栈里有绝对路径与内部结构。
 */
export function toAppErrorPayload(err: unknown, exposeStack = false): AppErrorPayload {
  const appError = toAppError(err)
  const payload: AppErrorPayload = { code: appError.code, message: appError.message }
  if (appError.fields && appError.fields.length > 0) payload.fields = appError.fields
  if (exposeStack && appError.code === ERROR_CODES.internal) {
    payload.stack = err instanceof Error ? err.stack ?? err.message : String(err)
  }
  return payload
}
