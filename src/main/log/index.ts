/**
 * 结构化日志（M0-06）。
 *
 * 对外只暴露 `createLogger(scope)`，与 M0 前面的极简实现**完全同名同参**，
 * 所以调用方（ipc / db / bridge）不需要改调用姿势，只多了一个可选的 fields 参数。
 *
 * 一条日志同时在两个地方出现，但形态不同：
 *   - **文件**：JSON Lines，一行一个对象，字段固定为 ts / level / scope / msg / pid / seq，
 *     附加字段统一塞进 `fields`。这样机器能解析，也不用担心某个字段名和保留字段撞车。
 *   - **控制台**：`[时间] 级别 模块 消息 {附加字段}`。开发时肉眼扫，同时也被现有的
 *     verify:* 脚本用来断言（所以这个前缀格式不要随便改）。
 *
 * 两个硬要求（开发计划 M0-06 验收）：
 *   1. 必须落盘，且 `app.exit()` / 崩溃路径也不能丢最后几行 → 见 sink.ts 的同步写
 *   2. 路径里的用户名必须被替换成 `~` → 见 utils/redact.ts，写入前统一过一遍
 *
 * 级别：`CTEXT_LOG_LEVEL=debug|info|warn|error`，默认 info。debug 只在开发态打开，
 * 因为它包含每条 IPC 的耗时，生产环境开着会明显涨日志体积。
 */
import { randomUUID } from 'node:crypto'
import { redactText, redactValue } from '../utils/redact'
import { FileLogSink } from './sink'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 派生一个带固定字段的 logger（例如带 bookId，后续每条日志都会自动带上） */
  child(scope: string, fields?: LogFields): Logger
  /**
   * 计时器。返回的函数在调用时写一条日志（默认 debug 级）并回传耗时，
   * 字段名固定 `elapsedMs`，方便按字段聚合。
   */
  time(message: string, fields?: LogFields, level?: LogLevel): (extra?: LogFields) => number
}

interface LogRecord {
  ts: string
  level: LogLevel
  scope: string
  msg: string
  pid: number
  seq: number
  session: string
  fields?: LogFields
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 默认保留 7 天、单文件 16MB：够定位问题，也不至于占用用户磁盘 */
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
/** 控制台里附加字段最多打印这么多字符，避免一条日志刷满终端 */
const CONSOLE_FIELDS_LIMIT = 600

let minLevel: LogLevel = resolveMinLevel()
let sink: FileLogSink | null = null
let logDir: string | null = null
let consoleEcho = true
let seq = 0
const session = randomUUID().slice(0, 8)

function resolveMinLevel(): LogLevel {
  const raw = process.env['CTEXT_LOG_LEVEL']
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export interface LoggingOptions {
  /** 日志目录；通常传 `join(app.getPath('userData'), 'logs')` */
  dir: string
  /** 是否同时输出到控制台，默认 true */
  console?: boolean
  retentionDays?: number
  maxBytes?: number
}

/**
 * 初始化落盘。可在 app ready 之前调用（`app.getPath` 在此之前就可用）。
 * 重复调用是空操作，方便测试里反复进入。
 */
export function initLogging(options: LoggingOptions): string {
  logDir = options.dir
  consoleEcho = options.console !== false
  if (!sink) {
    sink = new FileLogSink(
      {
        dir: options.dir,
        retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES
      },
      // sink 自己出错时不能递归调 logger，直接走控制台
      (message) => console.warn(`[log] ${message}`)
    )
  }
  return options.dir
}

export function getLogDir(): string | null {
  return logDir
}

/** 当前日志文件；还没写过日志时为 null（文件是首条日志时才创建的） */
export function getLogFilePath(): string | null {
  return sink?.path ?? null
}

export function getLogLevel(): LogLevel {
  return minLevel
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** 退出前调用：关掉文件句柄，让最后一次写入尽快回到磁盘 */
export function shutdownLogging(): void {
  sink?.close()
  sink = null
}

/**
 * 一条日志的完整写入路径：级别过滤 → 脱敏 → 序列化 → 落盘 → 控制台。
 * 脱敏在这里（而不是在 sink 里）做，是为了让控制台输出也一起干净。
 */
export function writeLog(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

  const safeFields = sanitizeFields(fields)
  const rec: LogRecord = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: redactText(message),
    pid: process.pid,
    seq: ++seq,
    session
  }
  if (safeFields) rec.fields = safeFields

  sink?.write(safeStringify(rec))
  if (consoleEcho) echo(rec)
}

// -------------------------------------------------------------------- 内部

/** 丢掉 undefined 字段、脱敏、并在全空时返回 undefined（保持 JSON 里不出现空 fields） */
function sanitizeFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return undefined
  return redactValue(Object.fromEntries(entries)) as LogFields
}

/** JSON.stringify 遇到 BigInt / 循环引用会抛错，日志不能因此把主流程带崩 */
function safeStringify(rec: LogRecord): string {
  try {
    return JSON.stringify(rec)
  } catch {
    return JSON.stringify({
      ts: rec.ts,
      level: rec.level,
      scope: rec.scope,
      msg: '(字段无法序列化，已丢弃)',
      pid: rec.pid,
      seq: rec.seq,
      session: rec.session
    })
  }
}

function safeStringifyFields(fields: LogFields): string {
  try {
    return JSON.stringify(fields)
  } catch {
    return '{"fields":"(不可序列化)"}'
  }
}

function echo(rec: LogRecord): void {
  const head = `[${timeOf(rec.ts)}] ${rec.level.toUpperCase().padEnd(5)} ${rec.scope} ${rec.msg}`
  const detail = rec.fields ? ` ${truncate(safeStringifyFields(rec.fields))}` : ''
  const text = head + detail
  if (rec.level === 'error') console.error(text)
  else if (rec.level === 'warn') console.warn(text)
  else console.log(text)
}

function truncate(text: string): string {
  return text.length > CONSOLE_FIELDS_LIMIT ? `${text.slice(0, CONSOLE_FIELDS_LIMIT)}…` : text
}

export function createLogger(scope: string, base?: LogFields): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    writeLog(level, scope, message, { ...base, ...fields })
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childScope, childFields) => createLogger(childScope, { ...base, ...childFields }),
    time: (message, fields, level = 'debug') => {
      const startedAt = performance.now()
      return (extra) => {
        const elapsedMs = Number((performance.now() - startedAt).toFixed(1))
        emit(level, message, { ...fields, ...extra, elapsedMs })
        return elapsedMs
      }
    }
  }
}
