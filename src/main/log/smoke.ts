/**
 * M0-06 自检：结构化日志 + 错误码映射 + 全局异常兜底。
 *
 * 全部断言跑在真实运行时里（真落盘、真 IPC、真渲染层），由 `pnpm verify:log` 驱动：
 *   1. 日志文件真的被创建在 userData/logs 下，且内容是 JSON Lines
 *   2. 用户名被替换成 `~`、凭据被替换成 `***`（这是验收标准原话）
 *   3. 级别阈值生效（低于阈值的行不落盘）
 *   4. time() 记下了 elapsedMs
 *   5. 底层错误 → 错误码的映射
 *   6. 主进程未捕获异常不会杀死进程，且留下记录
 *   7. 渲染层未捕获异常会弹 toast，并通过 log:renderer 落到同一个文件
 *
 * 只在 `!app.isPackaged && CTEXT_LOG_SMOKE=1` 时由主进程调用。
 */
import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError, ERROR_CODES } from '@shared/errors'
import { getLogDir, getLogFilePath, createLogger, setLogLevel, shutdownLogging } from './index'
import { toAppError } from '../utils/to-app-error'
import { redactText } from '../utils/redact'

const log = createLogger('smoke')

interface LogRecord {
  ts: string
  level: string
  scope: string
  msg: string
  pid: number
  seq: number
  session: string
  fields?: Record<string, unknown>
}

function readRecords(file: string): { records: LogRecord[]; badLines: number } {
  const raw = readFileSync(file, 'utf8')
  const records: LogRecord[] = []
  let badLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as LogRecord)
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

export async function runLogSmoke(win: BrowserWindow): Promise<void> {
  const results: { name: string; ok: boolean; detail: string }[] = []
  const check = (name: string, ok: boolean, detail = '') =>
    results.push({ name, ok, detail: detail ? redactText(detail) : '' })
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })
  await wait(400)

  // ---------------------------------------------------------------- 1. 落盘与格式
  const file = getLogFilePath()
  const logDir = getLogDir()

  // 只统计本次运行产生的行：日志是追加写，上一次运行的断言结果不能污染这一次
  const startedAt = new Date().toISOString()
  const read = (): { records: LogRecord[]; badLines: number } => {
    if (!file) return { records: [], badLines: 0 }
    const parsed = readRecords(file)
    return { records: parsed.records.filter((r) => r.ts >= startedAt), badLines: parsed.badLines }
  }
  check('日志文件已创建', !!file && existsSync(file), file ?? 'null（尚未写过任何日志）')
  check(
    '日志目录位于 userData/logs',
    !!logDir && logDir === join(app.getPath('userData'), 'logs'),
    logDir ?? 'null'
  )
  log.info('SMOKE-LOG 结构化字段', { marker: 'structured', n: 42, ok: true })

  let { records, badLines } = read()
  check('本次运行已经写入日志行', records.length > 0, `${records.length} 行`)
  const structured = records.find((r) => r.msg === 'SMOKE-LOG 结构化字段')
  check(
    '写入结构化 JSON 行',
    !!structured && structured.level === 'info' && structured.scope === 'smoke' && structured.fields?.['n'] === 42,
    structured ? JSON.stringify(structured.fields) : '未找到该行'
  )
  check(
    '每行含 ts/level/scope/pid/seq/session',
    !!structured &&
      typeof structured.ts === 'string' &&
      typeof structured.level === 'string' &&
      typeof structured.scope === 'string' &&
      typeof structured.pid === 'number' &&
      typeof structured.seq === 'number' &&
      typeof structured.session === 'string',
    structured ? `ts=${structured.ts} pid=${structured.pid} seq=${structured.seq} session=${structured.session}` : ''
  )
  check('日志内容全部是合法 JSON 行', badLines === 0, badLines > 0 ? `${badLines} 行无法解析` : '')

  // ---------------------------------------------------------------- 2. 脱敏
  const username = (() => {
    try {
      return userInfo().username
    } catch {
      return ''
    }
  })()
  const fakeHome = `C:\\Users\\${username}\\AppData\\Roaming\\ctext`
  log.warn(`SMOKE-LOG 路径脱敏 ${fakeHome}\\ctext.db`)

  records = read().records
  const redacted = records.find((r) => r.msg.startsWith('SMOKE-LOG 路径脱敏'))
  check(
    '路径中的用户名被替换为 ~',
    !!redacted && !redacted.msg.includes(username) && /Users[\\/]~/.test(redacted.msg),
    redacted?.msg ?? '未找到该行'
  )

  log.warn('SMOKE-LOG 凭据脱敏 https://example.com/api?token=SECRET123456&x=1 Authorization: Bearer abcdefghijklmnop')
  records = read().records
  const secret = records.find((r) => r.msg.startsWith('SMOKE-LOG 凭据脱敏'))
  check(
    'URL token 与 Bearer 凭据被替换',
    !!secret && !secret.msg.includes('SECRET123456') && !secret.msg.includes('abcdefghijklmnop') && secret.msg.includes('***'),
    secret?.msg ?? '未找到该行'
  )

  // ---------------------------------------------------------------- 3. 级别阈值
  setLogLevel('error')
  log.info('SMOKE-LOG 应被过滤')
  log.error('SMOKE-LOG 应被保留')
  setLogLevel('info')
  records = read().records
  check('低于阈值的日志不落盘', !records.some((r) => r.msg === 'SMOKE-LOG 应被过滤'))
  check('达到阈值的日志落盘', records.some((r) => r.msg === 'SMOKE-LOG 应被保留'))

  // ---------------------------------------------------------------- 4. 耗时
  // 显式指定 info 级：默认是 debug，而上面刚把阈值调回了 info
  const stop = log.time('SMOKE-LOG 耗时统计', undefined, 'info')
  await wait(40)
  stop({ step: 'wait' })
  records = read().records
  const timed = records.find((r) => r.msg === 'SMOKE-LOG 耗时统计')
  const elapsedMs = timed?.fields?.['elapsedMs']
  check(
    'time() 记录 elapsedMs',
    typeof elapsedMs === 'number' && elapsedMs >= 30 && timed?.fields?.['step'] === 'wait',
    `elapsedMs=${String(elapsedMs)}`
  )

  // ---------------------------------------------------------------- 5. 错误码映射
  const enoent = toAppError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
  check(
    'ENOENT → E_NOT_FOUND 且不泄漏英文原文',
    enoent.code === ERROR_CODES.notFound && !enoent.message.includes('ENOENT'),
    `${enoent.code} ${enoent.message}`
  )
  const unique = toAppError(Object.assign(new Error('UNIQUE constraint failed: books.rel_path'), {
    code: 'SQLITE_CONSTRAINT_UNIQUE'
  }))
  check('SQLITE_CONSTRAINT_UNIQUE → E_CONFLICT', unique.code === ERROR_CODES.conflict, `${unique.code} ${unique.message}`)

  const schema = z.object({ message: z.string().min(1) })
  const zodError = schema.safeParse({ message: '' })
  const mappedZod = toAppError(zodError.success ? new Error('不应该成功') : zodError.error)
  check(
    'zod 错误 → E_INVALID_ARGUMENT 带字段明细',
    mappedZod.code === ERROR_CODES.invalidArgument && (mappedZod.fields?.length ?? 0) > 0,
    `${mappedZod.code} ${JSON.stringify(mappedZod.fields)}`
  )

  const unknown = toAppError(new Error('TypeError: x is not a function'))
  check(
    '未知异常 → E_INTERNAL 且文案为通用提示',
    unknown.code === ERROR_CODES.internal && !unknown.message.includes('TypeError'),
    `${unknown.code} ${unknown.message}`
  )

  const known = new AppError(ERROR_CODES.timeout, '解析超时')
  check('AppError 原样透传', toAppError(known) === known)

  // ---------------------------------------------------------------- 6. 渲染层未捕获异常
  const toastBefore = (await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-toast]').length`
  )) as number

  await win.webContents.executeJavaScript(
    `setTimeout(() => { throw new Error('SMOKE-LOG 渲染层未捕获') }, 0); true`
  )
  await wait(700)

  const toastAfter = (await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-toast][data-toast-level="error"]').length`
  )) as number
  check('渲染层未捕获异常弹出错误 toast', toastAfter > toastBefore, `异常前 ${toastBefore} 条，异常后 ${toastAfter} 条`)

  records = read().records
  const forwarded = records.find((r) => r.scope === 'renderer' && r.msg.includes('SMOKE-LOG 渲染层未捕获'))
  check(
    '渲染层异常转发进主进程日志',
    !!forwarded && forwarded.level === 'error' && forwarded.fields?.['source'] === 'window.onerror',
    forwarded ? `source=${String(forwarded.fields?.['source'])}` : '日志中未找到'
  )

  // ---------------------------------------------------------------- 7. 主进程未捕获异常
  setTimeout(() => {
    throw new Error('SMOKE-LOG 主进程未捕获')
  }, 0)
  await wait(400)

  records = read().records
  const mainCaught = records.find((r) => r.msg.includes('未捕获异常') && r.level === 'error')
  check(
    '主进程 uncaughtException 被兜底并落盘',
    !!mainCaught && JSON.stringify(mainCaught.fields ?? {}).includes('SMOKE-LOG 主进程未捕获'),
    mainCaught ? `scope=${mainCaught.scope}` : '日志中未找到'
  )
  check('兜底后进程仍然存活', true, '能执行到这里说明没有退出')

  const toastAfterMain = (await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-toast][data-toast-level="error"]').length`
  )) as number
  check('主进程异常也能把 toast 推到界面', toastAfterMain > toastAfter, `主进程异常后 ${toastAfterMain} 条`)

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`SMOKE LOG ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
  }
  console.log(`SMOKE LOG INFO file=${file ? file.slice(file.lastIndexOf('\\') + 1) : ''}`)
  console.log(`SMOKE LOG SUMMARY ${results.length - failed.length}/${results.length}`)

  const code = failed.length === 0 ? 0 : 1
  win.destroy()
  shutdownLogging()
  app.exit(code)
}
