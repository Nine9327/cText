/**
 * 渲染层日志转发通道（Renderer → Main 单向）。
 *
 * 渲染层的 `console.*` 在打包后没人看得到，未捕获异常也不会自己跑到日志文件里。
 * 所以渲染层把「值得排查的事件」通过这条通道交给主进程，和主进程日志写进同一个文件，
 * 用户反馈时只需要发一个文件。
 *
 * 信任边界：这是渲染层来的数据，**一律按不可信处理**——级别白名单、长度截断、
 * 不做任何字符串拼接（直接作为字段），落盘前还会过一遍脱敏。
 */
import type { RendererLogDTO } from '@shared/dto'
import { createLogger, type LogLevel } from '../log'
import { registerSend } from './registry'

const log = createLogger('renderer')

const LEVELS = new Set<string>(['debug', 'info', 'warn', 'error'])
const MAX_MESSAGE = 4_000
const MAX_STACK = 8_000

function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length > max ? `${value.slice(0, max)}…（截断）` : value
}

export function registerLogIpc(): void {
  registerSend('log:renderer', ({ payload }) => {
    if (!payload || typeof payload !== 'object') {
      log.warn('收到格式非法的渲染层日志，已丢弃')
      return
    }

    const dto = payload as Partial<RendererLogDTO>
    const level: LogLevel = typeof dto.level === 'string' && LEVELS.has(dto.level) ? (dto.level as LogLevel) : 'info'
    const message = textOf(dto.message, MAX_MESSAGE) ?? '(渲染层未提供消息)'

    // toast 已经由渲染层自己弹过了，这里只落盘，避免同一条错误弹两次
    log[level](message, {
      origin: 'renderer',
      source: textOf(dto.source, 64),
      url: textOf(dto.url, 512),
      stack: textOf(dto.stack, MAX_STACK)
    })
  })
}
