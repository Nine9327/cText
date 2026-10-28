/**
 * Python worker 的 NDJSON 帧协议。
 *
 * 规则（与 python/ctext_worker/rpc.py 一一对应）：
 *   - 一行一帧，UTF-8，分隔符固定 `\n`
 *   - 响应帧 { id, ok:true, result } / { id, ok:false, error }
 *   - 事件帧 { event, data }，没有 id，不期待响应
 *   - stdout 上除此之外的任何内容都是坏帧：记 warn 后丢弃，**不能**中断解码器
 *
 * 解码器必须容忍三件事，否则桥接层在实际使用中很容易假死：
 *   1. 半包：一次 data 事件只有半行
 *   2. 粘包：一次 data 事件里有多个完整帧
 *   3. 超长行：worker 写出了不受控内容（比如调试打印了一个大对象），
 *      不能无限堆在内存里，超过上限后整行丢弃并跳过
 */
import type { ErrorCode } from '@shared/errors'

export const WORKER_PROTOCOL = 1

export interface WorkerRequestFrame {
  id: string
  method: string
  params?: unknown
}

export interface WorkerReadyData {
  version: string
  protocol: number
  pid: number
  python: string
  methods: string[]
}

/** health.ping 的返回值（比握手帧多 uptime 与依赖探测） */
export interface WorkerHealthPayload {
  version: string
  protocol: number
  pid: number
  python: string
  uptimeMs: number
  methods: string[]
  deps: Record<string, boolean>
}

export interface WorkerErrorPayload {
  code: string
  message: string
  detail?: string
}

export interface WorkerSuccessFrame {
  id: string
  ok: true
  result: unknown
}

export interface WorkerErrorFrame {
  id: string | null
  ok: false
  error: WorkerErrorPayload
}

export interface WorkerEventFrame {
  event: string
  data?: unknown
}

export type WorkerResponseFrame = WorkerSuccessFrame | WorkerErrorFrame
export type WorkerFrame = WorkerResponseFrame | WorkerEventFrame

export interface DecodeResult {
  frames: WorkerFrame[]
  /** 坏帧 / 超长行的说明，供调用方记日志（不含原始内容全文，避免日志爆炸） */
  problems: string[]
}

/** 单行上限：正常帧里最大的是一次章节正文，8MB 足够；超过说明有问题 */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024

export function encodeRequest(frame: WorkerRequestFrame): string {
  return `${JSON.stringify(frame)}\n`
}

export function isEventFrame(frame: WorkerFrame): frame is WorkerEventFrame {
  return 'event' in frame
}

export function isReadyEvent(
  frame: WorkerFrame
): frame is WorkerEventFrame & { data: WorkerReadyData } {
  if (!isEventFrame(frame) || frame.event !== 'worker.ready') return false
  return isReadyData(frame.data)
}

function isReadyData(data: unknown): data is WorkerReadyData {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return (
    typeof d['version'] === 'string' &&
    typeof d['protocol'] === 'number' &&
    typeof d['pid'] === 'number' &&
    Array.isArray(d['methods'])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeError(raw: unknown): WorkerErrorPayload {
  if (!isRecord(raw)) return { code: 'E_INTERNAL', message: 'worker 返回了空的错误信息' }
  return {
    code: typeof raw['code'] === 'string' ? raw['code'] : 'E_INTERNAL',
    message: typeof raw['message'] === 'string' ? raw['message'] : '未知错误',
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : undefined
  }
}

/** 解析单行；返回字符串表示这一行是坏帧（内容就是问题描述） */
function parseLine(line: string): WorkerFrame | string {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return `不是合法 JSON: ${line.slice(0, 120)}`
  }

  if (!isRecord(raw)) return `帧不是对象: ${line.slice(0, 120)}`

  if (typeof raw['event'] === 'string') {
    return { event: raw['event'], data: raw['data'] }
  }

  if (typeof raw['id'] === 'string' && typeof raw['ok'] === 'boolean') {
    if (raw['ok']) return { id: raw['id'], ok: true, result: raw['result'] }
    return { id: raw['id'], ok: false, error: normalizeError(raw['error']) }
  }

  // id 可能是 null（worker 无法识别请求时的兜底），这种帧没人认领，当坏帧
  return `未知帧形状: ${line.slice(0, 120)}`
}

export class NdjsonDecoder {
  private buffer = ''
  /** 当前行已超长，正在丢弃直到下一个换行 */
  private discarding = false

  constructor(private readonly maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {}

  push(chunk: string): DecodeResult {
    const frames: WorkerFrame[] = []
    const problems: string[] = []
    this.buffer += chunk

    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const rawLine = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)

      if (this.discarding) {
        this.discarding = false
        problems.push(`丢弃超长帧（> ${this.maxLineBytes} 字节）`)
      } else {
        // Windows 下若用 \r\n，去掉尾部 \r
        const line = rawLine.replace(/\r$/, '').trim()
        if (line) {
          const parsed = parseLine(line)
          if (typeof parsed === 'string') problems.push(parsed)
          else frames.push(parsed)
        }
      }

      nl = this.buffer.indexOf('\n')
    }

    // 没有换行但已经过长：清空缓冲，进入丢弃模式
    if (!this.discarding && this.buffer.length > this.maxLineBytes) {
      this.buffer = ''
      this.discarding = true
    }

    return { frames, problems }
  }

  /** 进程重启时清掉残留的半行，避免新进程的首帧与旧数据拼在一起 */
  reset(): void {
    this.buffer = ''
    this.discarding = false
  }

  /** 仅诊断用：当前未成帧的残留长度 */
  get pendingBytes(): number {
    return this.buffer.length
  }
}

/** worker 错误码 → 主进程统一错误码。未知码一律归为 internal，避免把内部细节透给渲染层。 */
const KNOWN_CODES: readonly ErrorCode[] = [
  'E_INVALID_ARGUMENT',
  'E_NOT_FOUND',
  'E_NOT_IMPLEMENTED',
  'E_CONFLICT',
  'E_IO',
  'E_TIMEOUT',
  // M1-05：worker 侧的「文件坏了/加密了」必须原样透传，
  // 归成 E_INTERNAL 会让导入结果面板无法区分「解析失败」与「程序出错」
  'E_PARSE_FAILED',
  'E_INTERNAL'
]

export function toErrorCode(code: string): ErrorCode {
  return (KNOWN_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'E_INTERNAL'
}
