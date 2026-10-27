/**
 * IPC 调用封装——渲染层访问主进程的唯一出口。
 *
 * 组件不要直接 `window.api.invoke(...)`：
 *   1. 这里统一把 IpcResult 解包成 Promise，失败抛 ApiError（带 code 与字段明细）
 *   2. 浏览器直连模式（pnpm dev:web）没有 preload，这里给出一条人话错误
 *   3. 将来加埋点 / 重试 / 超时，只改这一个文件
 */
import { ERROR_CODES, type AppErrorPayload, type FieldError } from '@shared/errors'
import type { IpcChannel, IpcEventChannel, IpcEvents, IpcInput, IpcOutput, IpcSendChannel } from '@shared/ipc/contract'

export class ApiError extends Error {
  readonly code: string
  readonly fields: FieldError[]

  constructor(payload: AppErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.fields = payload.fields ?? []
  }

  /** 某个字段是否校验失败（表单可直接用来标红） */
  hasField(path: string): boolean {
    return this.fields.some((f) => f.path === path)
  }
}

/** 无入参通道允许省略第二个参数 */
type InputArgs<K extends IpcChannel> = IpcInput<K> extends void ? [] : [IpcInput<K>]

function bridge(): NonNullable<Window['api']> {
  const api = window.api
  if (!api) {
    throw new ApiError({
      code: ERROR_CODES.internal,
      message: 'IPC 不可用：当前是浏览器直连模式，请用 pnpm dev 启动窗口'
    })
  }
  return api
}

export async function call<K extends IpcChannel>(channel: K, ...args: InputArgs<K>): Promise<IpcOutput<K>> {
  const result = await bridge().invoke(channel, args[0] as IpcInput<K>)
  if (!result.ok) throw new ApiError(result.error)
  return result.data
}

export function send<K extends IpcSendChannel>(channel: K): void {
  bridge().send(channel)
}

export function on<K extends IpcEventChannel>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void {
  return bridge().on(channel, cb)
}
