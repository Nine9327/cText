/**
 * 极简作用域日志。
 *
 * M0-06 会换成「结构化日志（级别/模块/耗时/脱敏）+ 落盘」，届时保留同名接口、
 * 只替换实现，所以这里刻意只暴露 level + scope + message 三件事，不引第三方库。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function resolveMinLevel(): LogLevel {
  const raw = process.env['CTEXT_LOG_LEVEL']
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

let minLevel: LogLevel = resolveMinLevel()

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export interface Logger {
  debug: (message: string, ...rest: unknown[]) => void
  info: (message: string, ...rest: unknown[]) => void
  warn: (message: string, ...rest: unknown[]) => void
  error: (message: string, ...rest: unknown[]) => void
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, rest: unknown[]) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${scope} ${message}`
    if (level === 'error') console.error(line, ...rest)
    else if (level === 'warn') console.warn(line, ...rest)
    else console.log(line, ...rest)
  }
  return {
    debug: (m, ...r) => write('debug', m, r),
    info: (m, ...r) => write('info', m, r),
    warn: (m, ...r) => write('warn', m, r),
    error: (m, ...r) => write('error', m, r)
  }
}
