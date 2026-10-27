/**
 * PythonBridge：worker 进程的唯一管理者。
 *
 * 职责：拉起进程、握手、请求路由、超时、崩溃重启、退出清理。
 * 不做任何解析逻辑——解析全在 python/ctext_worker 里。
 *
 * 三条不变量：
 *   1. **请求一定会落地**：成功、失败、超时、进程退出，四条路径都保证 promise 被 settle。
 *      漏掉任何一条，调用方（导入队列、阅读器）就会永久挂起。
 *   2. **重启有上限**：5 分钟内最多 3 次。超过就进 failed 状态并拒绝后续请求，
 *      否则一个必崩的 worker 会变成无限重启的 CPU 打满。
 *   3. **不产生孤儿进程**：stop() 先关 stdin 让 worker 自己退（它读到 EOF 就 exit），
 *      超时才强杀；主进程被强杀时管道关闭也会让 worker 读到 EOF 退出。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { AppError, ERROR_CODES } from '@shared/errors'
import { createLogger } from '../utils/log'
import {
  NdjsonDecoder,
  encodeRequest,
  isEventFrame,
  isReadyEvent,
  toErrorCode,
  WORKER_PROTOCOL,
  type WorkerHealthPayload,
  type WorkerReadyData,
  type WorkerResponseFrame
} from './protocol'

const log = createLogger('worker')

export type BridgeState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface BridgeLaunch {
  command: string
  args: string[]
  cwd: string
  /** 追加/覆盖到子进程环境变量上；主进程环境始终继承 */
  env?: Record<string, string>
}

export interface BridgeOptions extends BridgeLaunch {
  /** 单次请求默认超时 */
  defaultTimeoutMs?: number
  /** 从 spawn 到收到 worker.ready 的上限 */
  startupTimeoutMs?: number
  maxRestarts?: number
  restartWindowMs?: number
  restartDelaysMs?: number[]
  /** worker 主动推来的事件（导入进度等） */
  onEvent?: (event: string, data: unknown) => void
}

export interface BridgeStatus {
  state: BridgeState
  pid: number | null
  /** 累计重启次数（含已恢复的） */
  restarts: number
  lastError: string | null
  /** 握手信息；未就绪时为 null */
  worker: WorkerReadyData | null
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer?: NodeJS.Timeout
}

interface Pending {
  method: string
  startedAt: number
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULTS = {
  defaultTimeoutMs: 15_000,
  startupTimeoutMs: 10_000,
  maxRestarts: 3,
  restartWindowMs: 5 * 60_000,
  restartDelaysMs: [200, 400, 800]
}

export class PythonBridge {
  private readonly opts: Required<Omit<BridgeOptions, 'env' | 'onEvent'>> &
    Pick<BridgeOptions, 'env' | 'onEvent'>

  private child: ChildProcessWithoutNullStreams | null = null
  private decoder = new NdjsonDecoder()
  private pending = new Map<string, Pending>()
  private waiters: Waiter[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private restartTimes: number[] = []
  private seq = 0
  private disposed = false

  private _state: BridgeState = 'idle'
  private _restarts = 0
  private _lastError: string | null = null
  private _worker: WorkerReadyData | null = null
  private stderrTail = ''

  constructor(options: BridgeOptions) {
    this.opts = { ...DEFAULTS, ...options }
  }

  get state(): BridgeState {
    return this._state
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  getStatus(): BridgeStatus {
    return {
      state: this._state,
      pid: this.pid,
      restarts: this._restarts,
      lastError: this._lastError,
      worker: this._worker
    }
  }

  /** 幂等；失败不会抛出（进程起不来走 restart/failed 状态机，由调用方读状态） */
  start(): void {
    if (this.disposed || this.child || this.restartTimer) return
    this.spawnWorker()
  }

  /**
   * failed 状态下的手动重试（UI 上「重新连接」）。会清空重启计数，
   * 让用户修好环境（比如补装 .venv）后不必重启整个应用。
   */
  retry(): void {
    if (this.disposed) return
    this.restartTimes = []
    this._lastError = null
    if (this.child) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this._state = 'idle'
    this.spawnWorker()
  }

  async ping(timeoutMs = 5_000): Promise<WorkerHealthPayload> {
    return this.request<WorkerHealthPayload>('health.ping', undefined, { timeoutMs })
  }

  /**
   * 发起一次请求。超时只影响本次 promise，不杀进程——
   * 大文件解析可能只是慢，杀掉会让整批导入白跑。
   */
  async request<T>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.disposed) throw new AppError(ERROR_CODES.io, 'Python worker 已释放')

    const timeoutMs = options.timeoutMs ?? this.opts.defaultTimeoutMs
    await this.waitReady(Math.max(timeoutMs, this.opts.startupTimeoutMs))

    const child = this.child
    if (!child || child.stdin.destroyed) {
      throw new AppError(ERROR_CODES.io, 'Python worker 不可写（进程已退出）')
    }

    const id = `r-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        log.warn(`${method} 超时 ${timeoutMs}ms（id=${id}）`)
        reject(new AppError(ERROR_CODES.timeout, `${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        startedAt: Date.now(),
        timer,
        resolve: resolve as (value: unknown) => void,
        reject
      })

      try {
        child.stdin.write(encodeRequest({ id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AppError(ERROR_CODES.io, `向 Python worker 写入失败：${String(err)}`))
      }
    })
  }

  /**
   * 优雅停止：先关 stdin（worker 读到 EOF 自行退出），超时再强杀。
   * 应用退出路径必须调用它，否则 Python 进程可能残留到下一次启动。
   */
  async stop(graceMs = 1_000): Promise<void> {
    this.disposed = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.clearStartupTimer()

    const child = this.child
    this._state = 'stopped'
    this.rejectWaiters(new AppError(ERROR_CODES.io, 'Python worker 已停止'))
    this.rejectPending(new AppError(ERROR_CODES.io, 'Python worker 已停止'))

    if (!child) return

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.stdin.end()
    } catch {
      // 管道已断，直接进强杀分支
    }

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs))
    await Promise.race([exited, timeout])

    if (this.child === child) {
      log.warn('worker 未在宽限期内退出，强制终止')
      child.kill()
      this.child = null
    }
  }

  // ------------------------------------------------------------------ 内部

  private spawnWorker(): void {
    if (this.disposed) return

    this._state = 'starting'
    this.decoder.reset()
    this.stderrTail = ''

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: {
          ...process.env,
          // Windows 管道默认走 ANSI 代码页，中文会乱码或抛 UnicodeEncodeError
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          ...this.opts.env
        },
        stdio: 'pipe',
        windowsHide: true
      })
    } catch (err) {
      // spawn 同步抛错（参数非法等）
      this.fail(`启动 Python worker 失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk))
    // worker 死掉后写 stdin 会 EPIPE，不处理会变成 uncaughtException
    child.stdin.on('error', (err) => log.debug(`stdin 错误：${err.message}`))

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        // 命令不存在：重启也不会变好，直接进 failed 并给出可执行的指引
        this.fail(
          `找不到 Python 解释器：${this.opts.command}\n请先执行 pnpm setup:python 建立仓库内 .venv`
        )
        this.child = null
        return
      }
      log.error(`worker 进程错误：${err.message}`)
    })

    child.on('exit', (code, signal) => this.onExit(child, code, signal))

    this.startupTimer = setTimeout(() => {
      if (this._state !== 'ready') {
        log.error(`worker 启动超时（${this.opts.startupTimeoutMs}ms 未收到 worker.ready），重启`)
        child.kill()
      }
    }, this.opts.startupTimeoutMs)

    log.info(
      `启动 worker: ${this.opts.command} ${this.opts.args.join(' ')} (cwd=${this.opts.cwd}, pid=${child.pid ?? '?'})`
    )
  }

  private onStdout(chunk: string): void {
    const { frames, problems } = this.decoder.push(chunk)

    for (const problem of problems) log.warn(`坏帧已跳过：${problem}`)

    for (const frame of frames) {
      if (isEventFrame(frame)) {
        if (isReadyEvent(frame)) this.onReady(frame.data)
        else this.opts.onEvent?.(frame.event, frame.data)
        continue
      }
      this.settle(frame)
    }
  }

  private onReady(data: WorkerReadyData): void {
    this.clearStartupTimer()
    this._state = 'ready'
    this._worker = data
    this._lastError = null

    if (data.protocol !== WORKER_PROTOCOL) {
      // 不阻断：worker 可能是旧版本，让它继续跑但留下明确线索
      log.error(
        `协议版本不一致：worker=${data.protocol} 主进程=${WORKER_PROTOCOL}，可能出现字段缺失`
      )
    }

    log.info(
      `worker 就绪 v${data.version} pid=${data.pid} python=${data.python} methods=${data.methods.length}`
    )
    this.resolveWaiters()
  }

  private onStderr(chunk: string): void {
    // worker 的诊断输出统一转发到主进程日志，保持级别为 warn 便于排查
    this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim()
      if (text) log.warn(text.slice(0, 800))
    }
  }

  private settle(frame: WorkerResponseFrame): void {
    // id 为 null 说明 worker 自己也不知道是哪条请求（比如请求帧缺 id），没人认领
    if (frame.id === null) {
      log.warn('worker 返回了无法归属的帧（id=null），已丢弃')
      return
    }

    const pending = this.pending.get(frame.id)
    if (!pending) {
      // 超时后才回来的响应，或重启前旧进程的残留
      log.debug(`收到无人认领的响应 id=${frame.id}（可能已超时）`)
      return
    }
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)

    const elapsed = Date.now() - pending.startedAt
    if (frame.ok) {
      log.debug(`${pending.method} ok ${elapsed}ms`)
      pending.resolve(frame.result)
      return
    }

    log.warn(`${pending.method} 失败 ${frame.error.code} ${frame.error.message} ${elapsed}ms`)
    if (frame.error.detail) log.warn(`${pending.method} detail: ${frame.error.detail}`)
    // detail 只进日志，不回传渲染层：里面可能带绝对路径
    pending.reject(new AppError(toErrorCode(frame.error.code), frame.error.message))
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return // 已被替换的旧进程回调
    this.child = null
    this.clearStartupTimer()
    this.decoder.reset()
    this._worker = null

    const reason = `worker 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`
    this.rejectPending(new AppError(ERROR_CODES.io, 'Python worker 进程已退出，请求未完成'))
    this.rejectWaiters(new AppError(ERROR_CODES.io, 'Python worker 已退出'))

    if (this.disposed) {
      this._state = 'stopped'
      return
    }

    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.opts.restartWindowMs)

    if (this.restartTimes.length >= this.opts.maxRestarts) {
      this.fail(
        `${reason}：${this.opts.maxRestarts} 次/` +
          `${Math.round(this.opts.restartWindowMs / 60_000)} 分钟内反复崩溃，已停止自动重启` +
          (this.stderrTail ? `\n${this.stderrTail.slice(-500)}` : '')
      )
      return
    }

    this.restartTimes.push(now)
    this._restarts += 1
    this._state = 'restarting'

    const delay =
      this.opts.restartDelaysMs[
        Math.min(this.restartTimes.length - 1, this.opts.restartDelaysMs.length - 1)
      ] ?? 500
    log.warn(`${reason}，${delay}ms 后重启（第 ${this.restartTimes.length} 次）`)

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnWorker()
    }, delay)
  }

  private fail(message: string): void {
    this.clearStartupTimer()
    this._state = 'failed'
    this._lastError = message
    this._worker = null
    log.error(message)
    this.rejectPending(new AppError(ERROR_CODES.io, 'Python worker 不可用'))
    this.rejectWaiters(new AppError(ERROR_CODES.io, message))
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this._state === 'ready' && this.child) return Promise.resolve()

    if (this.disposed || this._state === 'stopped') {
      return Promise.reject(new AppError(ERROR_CODES.io, 'Python worker 已停止'))
    }
    if (this._state === 'failed') {
      return Promise.reject(new AppError(ERROR_CODES.io, this._lastError ?? 'Python worker 不可用'))
    }

    // starting / restarting / idle：排队等握手，避免「刚崩溃就来的请求」直接失败
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(waiter.timer)
          resolve()
        },
        reject: (err: Error) => {
          clearTimeout(waiter.timer)
          reject(err)
        }
      }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(new AppError(ERROR_CODES.timeout, '等待 Python worker 就绪超时'))
      }, timeoutMs)
      this.waiters.push(waiter)

      if (this._state === 'idle') this.start()
    })
  }

  private resolveWaiters(): void {
    const list = this.waiters
    this.waiters = []
    for (const w of list) w.resolve()
  }

  private rejectWaiters(err: Error): void {
    const list = this.waiters
    this.waiters = []
    for (const w of list) w.reject(err)
  }

  private rejectPending(err: Error): void {
    const list = [...this.pending.values()]
    this.pending.clear()
    for (const p of list) {
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }
}
