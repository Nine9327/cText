/**
 * 日志文件写入器。
 *
 * 三个刻意的设计选择：
 *
 * 1. **同步写（fs.writeSync）而不是流**。日志量在每秒几十条量级，同步写的代价可以忽略；
 *    换来的是「调用 write() 返回时数据已经在文件里」这个强保证——
 *    崩溃兜底（uncaughtException）和 `app.exit()` 退出都不会丢掉最后几条最关键的行。
 *    用流的话必须做 flush 握手，而崩溃现场恰恰没有机会握手。
 *
 * 2. **按天一个文件**（`ctext-YYYY-MM-DD.log`），改名检出问题时可以直接按日期定位。
 *    写入时发现日期变了就地切换到新文件，不需要定时器。
 *
 * 3. **只删自己写的文件**。清理历史日志时用 `^ctext-\d{4}-\d{2}-\d{2}\.log$` 精确匹配，
 *    目录里其他东西（用户自己放的文件、将来的崩溃转储）一律不碰。
 */
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface LogSinkOptions {
  dir: string
  /** 保留天数，含当天 */
  retentionDays: number
  /** 单文件上限（字节），超限后本次会话不再写文件 */
  maxBytes: number
}

const FILE_PATTERN = /^ctext-\d{4}-\d{2}-\d{2}\.log$/

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** 本地日期（不是 UTC）——用户看到的「今天」就是文件名里的今天 */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export class FileLogSink {
  private fd: number | null = null
  private currentDay = ''
  private filePath = ''
  private bytes = 0
  /** 打开失败只报一次，之后静默降级成「只输出控制台」，避免每次写日志都抛错 */
  private broken = false
  private capped = false
  private onProblem: ((message: string) => void) | null

  constructor(
    private readonly opts: LogSinkOptions,
    onProblem?: (message: string) => void
  ) {
    this.onProblem = onProblem ?? null
  }

  /** 当前文件路径；尚未写过任何日志时为 null */
  get path(): string | null {
    return this.filePath || null
  }

  get dir(): string {
    return this.opts.dir
  }

  write(line: string): void {
    if (this.broken) return

    const day = localDay()
    if (this.fd === null || day !== this.currentDay) this.open(day)
    if (this.fd === null) return

    const chunk = `${line}\n`
    const size = Buffer.byteLength(chunk, 'utf8')

    if (this.bytes + size > this.opts.maxBytes) {
      // 只留下一条「为什么后面没有了」的线索，然后停止写文件
      if (!this.capped) {
        this.capped = true
        const notice = `${JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          scope: 'log',
          msg: `日志文件已达上限 ${this.opts.maxBytes} 字节，本次会话后续日志仅输出到控制台`
        })}\n`
        this.rawWrite(notice)
      }
      return
    }

    this.rawWrite(chunk)
  }

  close(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      // 文件系统已经在关闭途中，忽略
    }
    this.fd = null
  }

  // ------------------------------------------------------------------ 内部

  private rawWrite(chunk: string): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, chunk)
      this.bytes += Buffer.byteLength(chunk, 'utf8')
    } catch (err) {
      this.broken = true
      this.onProblem?.(`写日志失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private open(day: string): void {
    this.close()
    this.capped = false

    try {
      mkdirSync(this.opts.dir, { recursive: true })
    } catch (err) {
      this.broken = true
      this.onProblem?.(`创建日志目录失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const file = join(this.opts.dir, `ctext-${day}.log`)
    try {
      this.fd = openSync(file, 'a')
      this.bytes = statSync(file).size
    } catch (err) {
      this.fd = null
      this.broken = true
      this.onProblem?.(`打开日志文件失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    this.currentDay = day
    this.filePath = file
    this.prune()
  }

  /** 清理超过保留期的历史日志。失败不影响写入，所以整体吞掉异常。 */
  private prune(): void {
    const keep = Math.max(1, this.opts.retentionDays)
    try {
      const files = readdirSync(this.opts.dir)
        .filter((name) => FILE_PATTERN.test(name))
        .sort() // 文件名里是 YYYY-MM-DD，字典序即时间序
        .slice(0, -keep) // 最新 keep 个之外的全是候选
      for (const name of files) {
        if (name === `ctext-${this.currentDay}.log`) continue
        try {
          unlinkSync(join(this.opts.dir, name))
        } catch {
          // 被占用（可能用户正开着），跳过
        }
      }
    } catch {
      // 目录不可读就算了，下一轮再试
    }
  }
}
