/**
 * 全局提示（Toast）的唯一状态源。
 *
 * 为什么不用 Pinia：toast 会被**非组件代码**触发（api 层、全局异常兜底），
 * 那些地方拿不到 `useStore()` 需要的 active pinia 上下文。用一个模块级 reactive
 * 数组反而更简单，也没有"必须在 app.use(pinia) 之后才能用"的时序陷阱。
 *
 * 三条规则：
 *   1. 同一条消息在栈里存在时不重复插入，只重置它的计时器（幂等，避免刷屏）；
 *   2. 最多同时显示 4 条，超出时挤掉最旧的一条（错误优先保留得久一些）；
 *   3. 计时器在移除时一定清理，避免"已经关掉但计时器又改状态"的幽灵更新。
 */
import { reactive } from 'vue'
import { ERROR_MESSAGES, isErrorCode } from '@shared/errors'
import type { ToastDTO } from '@shared/dto'

export type ToastLevel = ToastDTO['level']

export interface ToastItem {
  id: number
  level: ToastLevel
  message: string
  /** 关联错误码；展示成等宽小字，用户反馈时可以直接报这串 */
  code?: string
}

const MAX_VISIBLE = 4
const DURATION: Record<ToastLevel, number> = {
  info: 3_200,
  warn: 5_000,
  // 错误留久一点：用户往往需要读完再决定要不要重试
  error: 6_500
}

const items = reactive<ToastItem[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let seq = 0

/** 只读视图；组件里 v-for 它 */
export const toasts = items

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

export function dismiss(id: number): void {
  clearTimer(id)
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) items.splice(index, 1)
}

export function clearToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id)
  items.splice(0, items.length)
}

export interface PushToastInput {
  level?: ToastLevel
  message: string
  code?: string
  /** 覆盖默认停留时长；传 0 表示不自动消失 */
  durationMs?: number
}

/** 返回 toast id，需要手动关闭时用 */
export function pushToast(input: PushToastInput): number {
  const level = input.level ?? 'info'
  const message = input.message.trim() || '操作未成功'
  const code = input.code

  const existing = items.find((item) => item.level === level && item.message === message && item.code === code)
  if (existing) {
    clearTimer(existing.id)
    schedule(existing.id, input.durationMs ?? DURATION[level])
    return existing.id
  }

  const item: ToastItem = { id: ++seq, level, message }
  if (code) item.code = code
  items.push(item)

  // 超出上限时挤掉最旧的；错误消息优先保留
  while (items.length > MAX_VISIBLE) {
    const victim = items.find((candidate) => candidate.level !== 'error') ?? items[0]
    if (victim) dismiss(victim.id)
    else break
  }

  schedule(item.id, input.durationMs ?? DURATION[level])
  return item.id
}

function schedule(id: number, durationMs: number): void {
  if (durationMs <= 0) return
  timers.set(
    id,
    setTimeout(() => dismiss(id), durationMs)
  )
}

/** 主进程推来的 toast（worker 崩溃、渲染进程异常等） */
export function toastFromMain(payload: ToastDTO): void {
  pushToast({ level: payload.level, message: payload.message, code: payload.code })
}

/**
 * 把异常转成 toast。
 *
 * 文案优先级：异常自带的 message（AppError 的业务文案） > 错误码默认文案 > 兜底文案。
 * 底层错误（ENOENT 之类）经过主进程的 toAppError 之后 message 已经是人话了，
 * 所以这里可以放心直接用。
 */
export function toastError(err: unknown, fallback = '操作失败，请稍后重试'): void {
  const raw = err as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof raw?.code === 'string' && isErrorCode(raw.code) ? raw.code : undefined
  const message =
    (typeof raw?.message === 'string' && raw.message.trim()) || (code ? ERROR_MESSAGES[code] : fallback)
  pushToast({ level: 'error', message, code })
}
