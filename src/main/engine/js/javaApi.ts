/**
 * `java.*` 兼容层（M4-05）。
 *
 * 「阅读 3.0」的书源 JS 里会调用一批 Java 侧的辅助方法。我们在 QuickJS 里**等实现**
 * 其中白名单子集（产品文档 §2.7）：`ajax / base64 / md5Encode / timeFormat /
 * htmlFormat / log / put / get`，外加 `source.getKey()`。
 *
 * 三条原则：
 *   1. **只给白名单**。宿主对象一律不通过 handle 传进去，所有跨边界数据都是**字符串**——
 *      哪怕哪天 QuickJS 的 handle 管理出漏洞，JS 侧也拿不到一个能调宿主方法的对象。
 *   2. **网络只有 `ajax` 一条路**，且实际发请求的不是这里：`host.ajax` 只查预取缓存，
 *      未命中就抛 `CTEXT_AJAX_MISS`，由执行器异步补齐后**整段重放**（见 sandbox.ts）。
 *      这样既不用在主进程里同步阻塞等网络，也不用把 Promise 桥接进同步的 QuickJS。
 *   3. **行为拿不准的不装作支持**。`java.getString(rule)` 这类需要规则引擎的方法没有
 *      实现——真调用会得到明确的 TypeError，比返回一个「看起来像正文」的错值好。
 */
import { createHash } from 'node:crypto'
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten'
import { toRuleText } from './value'

export interface AjaxRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export interface JavaApiHost {
  /**
   * 同步取已预取的响应。**未命中返回空串，不要抛异常**——抛异常会让脚本在第一个
   * 未命中处中止，一次只能暴露一个地址，20 页的循环就要重放 20 轮、真发 20 个请求。
   * 返回空串让本轮尽量把地址暴露完，执行器据此一次性判定并补齐（见 sandbox.ts）。
   */
  ajax(url: string, options?: AjaxRequestOptions): string
  log(level: 'log' | 'warn' | 'error', message: string): void
  /** `java.put/get` 的存储（同一次书源抓取内共享） */
  getVariable(key: string): string | undefined
  setVariable(key: string, value: string): void
  /** `source.getKey()` */
  sourceKey: string
}

/**
 * `java.*` 白名单的方法名。
 *
 * 导入期用它做静态检查（M4-07）：规则里 `java.foo(...)` 的 `foo` 不在表里，
 * 这个书源就标 partial —— 比等到运行时抛 `TypeError` 再回头查规则要好得多。
 * **加方法时两处一起改**：这里和 `installJavaApi` 的 `put(...)` 调用。
 */
export const JAVA_API_METHODS: readonly string[] = [
  'ajax',
  'base64',
  'base64Encode',
  'base64Decode',
  'md5Encode',
  'md5Encode16',
  'timeFormat',
  'htmlFormat',
  'htmlEscape',
  'encodeURI',
  'log',
  'put',
  'get'
]

/**
 * 未命中标记前缀。正常路径不再靠抛异常传递（见 `JavaApiHost.ajax` 的说明），
 * 保留这个判定是为了把「宿主实现方手滑抛了异常」这种情况也归到 ajax 类错误，
 * 而不是笼统报成 script 错误。
 */
export const AJAX_MISS_PREFIX = 'CTEXT_AJAX_MISS '

export function isAjaxMiss(message: string): string | null {
  if (!message.startsWith(AJAX_MISS_PREFIX)) return null
  return message.slice(AJAX_MISS_PREFIX.length).trim()
}

/** 把 `java` / `console` / `source` 三个对象挂到沙箱全局上 */
export function installJavaApi(ctx: QuickJSContext, host: JavaApiHost): void {
  installJava(ctx, host)
  installConsole(ctx, host)
  installSource(ctx, host)
}

function installJava(ctx: QuickJSContext, host: JavaApiHost): void {
  const java = ctx.newObject()

  put(ctx, java, 'ajax', (args) => {
    const url = toRuleText(ctx.dump(args[0])).trim()
    if (url === '') throw new Error('java.ajax 缺少地址')
    // 未传第二个参数时 args[1] 是 JS 的 undefined（不是 handle），直接 dump 会崩
    const options = args.length > 1 ? parseAjaxOptions(ctx.dump(args[1])) : undefined
    return ctx.newString(host.ajax(url, options))
  })

  put(ctx, java, 'base64Encode', (args) => ctx.newString(base64Encode(text(args, ctx))))
  // Legado 里 `java.base64` 是 encode 的别名
  put(ctx, java, 'base64', (args) => ctx.newString(base64Encode(text(args, ctx))))
  put(ctx, java, 'base64Decode', (args) => ctx.newString(base64Decode(text(args, ctx))))

  put(ctx, java, 'md5Encode', (args) => ctx.newString(md5(text(args, ctx))))
  put(ctx, java, 'md5Encode16', (args) => ctx.newString(md5(text(args, ctx)).slice(8, 24)))

  put(ctx, java, 'timeFormat', (args) => {
    // 不传时间戳时用当前时间（书源里 `java.timeFormat()` 的常见用法）
    const rawStamp = args.length > 0 ? toRuleText(ctx.dump(args[0])).trim() : ''
    const parsed = rawStamp === '' ? Date.now() : Number(rawStamp)
    const stamp = Number.isFinite(parsed) ? parsed : Date.now()
    const pattern = args.length > 1 ? toRuleText(ctx.dump(args[1])) : 'yyyy-MM-dd HH:mm:ss'
    return ctx.newString(timeFormat(stamp, pattern))
  })

  put(ctx, java, 'htmlFormat', (args) => ctx.newString(htmlFormat(text(args, ctx))))
  put(ctx, java, 'htmlEscape', (args) => ctx.newString(htmlEscape(text(args, ctx))))

  // Java 的 URLEncoder：空格编成 `+`，其余同 encodeURIComponent
  put(ctx, java, 'encodeURI', (args) => ctx.newString(encodeURI(text(args, ctx))))

  put(ctx, java, 'log', (args) => {
    const message = args.map((handle) => toRuleText(ctx.dump(handle))).join(' ')
    host.log('log', message)
    return ctx.undefined
  })

  put(ctx, java, 'put', (args) => {
    const key = args.length > 0 ? toRuleText(ctx.dump(args[0])) : ''
    const value = args.length > 1 ? toRuleText(ctx.dump(args[1])) : ''
    if (key !== '') host.setVariable(key, value)
    return ctx.undefined
  })

  put(ctx, java, 'get', (args) => {
    const key = args.length > 0 ? toRuleText(ctx.dump(args[0])) : ''
    const value = key === '' ? undefined : host.getVariable(key)
    return value === undefined ? ctx.null : ctx.newString(value)
  })

  ctx.setProp(ctx.global, 'java', java)
  java.dispose()
}

/** 书源里偶尔会写 `console.log` 调试，接到同一条日志通道，避免直接 TypeError */
function installConsole(ctx: QuickJSContext, host: JavaApiHost): void {
  const consoleObj = ctx.newObject()
  for (const level of ['log', 'warn', 'error'] as const) {
    put(ctx, consoleObj, level, (args) => {
      host.log(level, args.map((handle) => toRuleText(ctx.dump(handle))).join(' '))
      return ctx.undefined
    })
  }
  // `console.info/debug` 也归到 log，减少无谓的规则失败
  for (const alias of ['info', 'debug'] as const) {
    put(ctx, consoleObj, alias, (args) => {
      host.log('log', args.map((handle) => toRuleText(ctx.dump(handle))).join(' '))
      return ctx.undefined
    })
  }
  ctx.setProp(ctx.global, 'console', consoleObj)
  consoleObj.dispose()
}

function installSource(ctx: QuickJSContext, host: JavaApiHost): void {
  const source = ctx.newObject()
  put(ctx, source, 'getKey', () => ctx.newString(host.sourceKey))
  put(ctx, source, 'getTag', () => ctx.newString(''))
  ctx.setProp(ctx.global, 'source', source)
  source.dispose()
}

/**
 * 建函数、挂到目标对象上。
 *
 * **必须用箭头函数 + 固定位置参数，不能用 `(...args)`**：quickjs-emscripten 以
 * `fn.apply(thisHandle, argHandles)` 调用宿主函数，实测在这种调用形态下 rest 参数
 * 收不到任何实参（`java.base64Encode('三体')` 里 args 长度是 0，规则会静默返回空串）。
 * 箭头函数同时避开 `this` 是 handle 这件事。
 */
function put(
  ctx: QuickJSContext,
  target: QuickJSHandle,
  name: string,
  fn: (args: QuickJSHandle[]) => QuickJSHandle
): void {
  const handle = ctx.newFunction(name, (a0?: QuickJSHandle, a1?: QuickJSHandle, a2?: QuickJSHandle) =>
    fn([a0, a1, a2].filter((item): item is QuickJSHandle => item !== undefined))
  )
  ctx.setProp(target, name, handle)
  // 释放的是宿主侧引用；JS 对象仍由目标属性持有，C 侧在对象被回收时才释放 hostRef
  handle.dispose()
}

function text(args: QuickJSHandle[], ctx: QuickJSContext): string {
  return args.length === 0 ? '' : toRuleText(ctx.dump(args[0]))
}

function parseAjaxOptions(value: unknown): AjaxRequestOptions | undefined {
  const raw = typeof value === 'string' ? tryJson(value.trim()) : value
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const headers: Record<string, string> = {}
  if (record['headers'] !== null && typeof record['headers'] === 'object') {
    for (const [key, item] of Object.entries(record['headers'] as Record<string, unknown>)) {
      if (typeof item === 'string') headers[key] = item
    }
  }
  const method = record['method'] === 'POST' ? 'POST' : 'GET'
  const body = typeof record['body'] === 'string' ? record['body'] : undefined
  return { method, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(body === undefined ? {} : { body }) }
}

function tryJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function base64Encode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64')
}

export function base64Decode(input: string): string {
  const cleaned = input.replace(/\s+/g, '')
  if (cleaned === '') return ''
  return Buffer.from(cleaned, 'base64').toString('utf8')
}

export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/**
 * 时间格式化。书源里传的常是**秒**（`System.currentTimeMillis()/1000`），
 * 也可能已经是毫秒；小于 1e11 视为秒。
 */
export function timeFormat(stamp: number, pattern = 'yyyy-MM-dd HH:mm:ss'): string {
  const ms = Math.abs(stamp) < 1e11 ? stamp * 1000 : stamp
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds())
  }
  // 先替换长 token，避免 `MM` 里又被 `M` 命中
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => map[token] ?? token)
}

/**
 * HTML → 纯文本。Legado 里 `java.htmlFormat` 的确切语义没有权威文档可对，
 * 这里按「调试/摘要用途」实现：块级标签转换行、去标签、解实体、折叠空白。
 * 正文提取仍应走 css/xpath，**不要**用 htmlFormat 抓正文。
 */
export function htmlFormat(input: string): string {
  const withBreaks = input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section)>/gi, '\n')
  return htmlUnescape(withBreaks.replace(/<[^>]*>/g, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function htmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°'
}

export function htmlUnescape(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 与 Java 的 `URLEncoder.encode(str, "UTF-8")` 对齐：空格变成 `+` */
export function encodeURI(input: string): string {
  return encodeURIComponent(input).replace(/%20/g, '+')
}
