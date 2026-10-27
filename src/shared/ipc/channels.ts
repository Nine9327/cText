/**
 * 通道名的唯一真相来源。
 *
 * preload 的白名单直接由这三个数组生成——渲染层拿不到任意通道字符串，
 * 即使页面被注入脚本也只能调用这里列出的通道。
 *
 * `satisfies` 负责挡「多写了不存在的通道」，
 * `defineChannels` 的交叉类型负责挡「契约里有、这里漏了」——两侧漏一个都编译不过。
 */
import type { IpcChannel, IpcEventChannel, IpcSendChannel } from './contract'

type ExactChannels<All extends PropertyKey, L extends readonly PropertyKey[]> =
  Exclude<All, L[number]> extends never ? unknown : { 漏掉了通道: Exclude<All, L[number]> }

function defineChannels<All extends PropertyKey>() {
  return <const L extends readonly All[]>(list: L & ExactChannels<All, L>): L => list
}

export const INVOKE_CHANNELS = defineChannels<IpcChannel>()([
  'system:echo',
  'system:info',
  'system:worker-health',
  'window:get-state',

  'library:list',
  'library:get',
  'library:toggleFavorite',
  'library:setCategories',
  'library:remove',

  'roots:list',
  'roots:add',
  'roots:check',
  'roots:relocate',
  'roots:remove',

  'shelves:list',
  'shelves:create',
  'shelves:addBooks',
  'books:list',
  'books:count',
  'books:recent',
  'shelves:get',

  'import:pickFolder',
  'import:scan',
  'import:commit',
  'import:cancel',

  'reader:content',
  'reader:saveProgress',

  'source:import',
  'source:list',
  'source:toggle',
  'source:search',
  'source:refreshToc',

  'settings:get',
  'settings:patch'
])

export const EVENT_CHANNELS = defineChannels<IpcEventChannel>()([
  'window:state',
  'toast',
  'import:progress',
  'roots:changed'
])

export const SEND_CHANNELS = defineChannels<IpcSendChannel>()([
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'log:renderer'
])

/** preload 与主进程共用的 O(1) 白名单 */
export const INVOKE_CHANNEL_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
export const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)
export const SEND_CHANNEL_SET: ReadonlySet<string> = new Set(SEND_CHANNELS)
