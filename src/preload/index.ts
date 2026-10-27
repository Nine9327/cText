/**
 * preload：渲染层与主进程之间唯一的桥。
 *
 * 安全模型（三层）：
 *   1. 只暴露 invoke / send / on 三个函数，不暴露 ipcRenderer 本体
 *   2. 每个函数先查白名单（白名单来自 shared/ipc/channels，与契约同源），
 *      渲染层即使被注入脚本也拿不到任意通道
 *   3. 事件回调只传 payload，不透传 IpcRendererEvent（防止 sender 泄漏到渲染层）
 *
 * 类型上通过一次断言把「逐通道泛型」贴到运行时的白名单函数上，
 * 调用方写错通道名或有放入参都会在编译期报错。
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { ERROR_CODES, type IpcResult } from '@shared/errors'
import { EVENT_CHANNEL_SET, INVOKE_CHANNEL_SET, SEND_CHANNEL_SET } from '@shared/ipc/channels'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEvents,
  IpcInput,
  IpcOutput,
  IpcSendChannel,
  IpcSends
} from '@shared/ipc/contract'

function rejected(message: string): IpcResult<never> {
  return { ok: false, error: { code: ERROR_CODES.invalidArgument, message } }
}

async function invokeRaw(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
  if (!INVOKE_CHANNEL_SET.has(channel)) {
    return rejected(`未授权的 IPC 通道: ${channel}`)
  }
  try {
    return (await ipcRenderer.invoke(channel, payload)) as IpcResult<unknown>
  } catch (err) {
    // 走到这里说明主进程没装 handler 或主进程异常退出，属于框架级故障
    return {
      ok: false,
      error: {
        code: ERROR_CODES.internal,
        message: `IPC 调用失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }
}

function sendRaw(channel: string, payload?: unknown): void {
  if (!SEND_CHANNEL_SET.has(channel)) {
    throw new Error(`未授权的 IPC 单向通道: ${channel}`)
  }
  ipcRenderer.send(channel, payload)
}

function onRaw(channel: string, callback: (payload: unknown) => void): () => void {
  if (!EVENT_CHANNEL_SET.has(channel)) {
    throw new Error(`未授权的 IPC 事件通道: ${channel}`)
  }
  const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const invoke = invokeRaw as <K extends IpcChannel>(
  channel: K,
  payload?: IpcInput<K>
) => Promise<IpcResult<IpcOutput<K>>>

const send = sendRaw as <K extends IpcSendChannel>(channel: K, payload?: IpcSends[K]) => void

const on = onRaw as <K extends IpcEventChannel>(
  channel: K,
  callback: (payload: IpcEvents[K]) => void
) => () => void

/**
 * 拖放进来的 File 取真实磁盘路径。
 *
 * `File.path` 自 Electron 29 起废弃（且会在控制台刷警告），官方替代是
 * `webUtils.getPathForFile`。它必须在 preload 里调——渲染层拿不到 webUtils，
 * 也拿不到任何 node 能力。
 *
 * 只接收 File 实例，不接受任意字符串：这个口子一旦能传路径，就等于给渲染层
 * 开了一个「任意路径」通道，越过了 IPC 白名单。
 */
function getFilePath(file: File): string {
  if (typeof file !== 'object' || file === null) return ''
  return webUtils.getPathForFile(file)
}

const api = { invoke, send, on, getFilePath }

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
