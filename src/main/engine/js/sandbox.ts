/**
 * QuickJS 沙箱执行器（M4-05）。
 *
 * 书源的 `@js:` 规则是**不可信代码**：可能是别人写的、可能是抄错一个字符的、也可能
 * 是故意想跑死你的。这里是它唯一能跑的地方。
 *
 * 四道闸门：
 *   1. **时间**：`setInterruptHandler` 挂在 deadline 上，每 N 条字节码回调一次，
 *      死循环在 800ms 左右被打断（实测 801ms）。
 *   2. **内存**：`setMemoryLimit(32MB)` + `setMaxStackSize(1MB)`。
 *   3. **能力**：沙箱里没有 `require`/`process`/`fetch`/`WebAssembly`/`eval` 之外
 *      任何宿主能力；跨边界只传**字符串**，不给任何宿主持久对象。网络只有 `java.ajax`。
 *   4. **重放预算**：`ajax` 要走异步网络，而 QuickJS 是同步的，所以采用「未命中即中止
 *      → 宿主张齐 → 整段重跑」的重放模型。轮次与请求数都有硬上限，防止一条
 *      `for(;;) java.ajax(...)` 式的规则把真实站点刷爆。
 *
 * **两个限必须同时挂**（§7.4 实测）：只挂内存上限时，一条内存炸弹规则会跑 4–6 秒才被
 * 拦住——那已经足够拖垮一次搜索（10 源并发）。只挂时间上限则恶意分配会把宿主堆吃光。
 *
 * 重放的代价：脚本在未命中前产生的**副作用会被重做**（`java.put` 幂等，`console.log`
 * 可能重复）。这是同步 VM 里换异步网络的必然代价，已在 §7.7 记录。
 */
import { getQuickJS, type QuickJSContext, type QuickJSWASMModule, type QuickJSHandle } from 'quickjs-emscripten'
import { installJavaApi, isAjaxMiss, type AjaxRequestOptions } from './javaApi'
import { isIdentifier, toJsLiteral, toRuleText } from './value'

export interface SandboxLimits {
  /** 单轮执行上限 */
  timeoutMs: number
  /** 堆上限 */
  memoryBytes: number
  stackBytes: number
  /** ajax 重放的最大轮次 */
  maxRounds: number
  /** 整条规则的墙钟预算（含所有轮次与网络等待） */
  totalBudgetMs: number
  /** 单轮最多补几个网络请求 */
  maxFetchesPerRound: number
  /** 整条规则最多发几个网络请求 */
  maxRequests: number
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 800,
  memoryBytes: 32 * 1024 * 1024,
  /**
   * **不能调到 512KB 以上**。实测（§7.7）：1MB/512KB 时 QuickJS 的递归会先撞穿宿主
   * V8 的栈，抛出的不是 QuickJS 的 `stack overflow`，而是宿主的
   * `Maximum call stack size exceeded`；这个异常穿出 wasm 后 runtime 就处于半崩溃状态，
   * 紧接着 `runtime.dispose()` 触发 `Assertion failed: list_empty(&rt->gc_obj_list)`，
   * 整个模块被 emscripten abort——后续所有规则都跑不了。
   *
   * 448KB 起才是安全的。这里取 256KB：实测可容 ~1200 层递归（书源里分页递归撑死几十层），
   * 又给宿主栈留了足够余量。
   */
  stackBytes: 256 * 1024,
  maxRounds: 16,
  totalBudgetMs: 8_000,
  maxFetchesPerRound: 8,
  maxRequests: 40
}

export type ScriptErrorKind =
  /** 超时 / 死循环 */
  | 'timeout'
  /** 内存或栈超限 */
  | 'memory'
  /** 脚本自身抛错、语法错误 */
  | 'script'
  /** 网络失败，或沙箱未开放网络 */
  | 'ajax'
  /** 重放轮次 / 请求数 / 总预算用尽 */
  | 'budget'

export interface ScriptError {
  kind: ScriptErrorKind
  message: string
}

export interface AjaxResponse {
  status: number
  url: string
  body: string
}

export interface RunScriptOptions {
  code: string
  /** 注入的全局变量；`result` 是 Legado 的「上一步结果」约定 */
  bindings?: Record<string, unknown>
  /** `java.put/get` 的共享存储；同一次书源抓取里传同一个实例 */
  variables?: Map<string, string>
  /** 注入的网络能力；不传则 `java.ajax` 直接失败（fail-closed） */
  ajax?: (url: string, options?: AjaxRequestOptions) => Promise<AjaxResponse>
  log?: (level: 'log' | 'warn' | 'error', message: string) => void
  /** `source.getKey()` 的返回值 */
  sourceKey?: string
  limits?: Partial<SandboxLimits>
}

export interface RunScriptResult {
  ok: boolean
  /** 归一后的文本，规则引擎直接用 */
  value: string
  /** 原始返回值（数字/数组等），供调用方判断类型 */
  raw: unknown
  error: ScriptError | null
  elapsedMs: number
  /** 实际跑了几轮（>1 表示发生过 ajax 重放） */
  rounds: number
  /** 本次触碰过的网络地址，供缓存与调试面板（M4-11） */
  ajaxUrls: string[]
}

let modulePromise: Promise<QuickJSWASMModule> | null = null

/**
 * wasm 模块被 emscripten abort 过就是废的：`getQuickJS()` 返回的是**共享单例**，
 * 一次 abort 之后所有 runScript 都会失败。这里记下来，后续调用直接给明确原因，
 * 而不是让每条规则各自撞一次 abort（那会让日志变成一片天书）。
 */
let modulePoisoned = false

/** 沙箱是否还能用（供设置页/诊断日志显示） */
export function isSandboxUsable(): boolean {
  return !modulePoisoned
}

/** 预热 wasm（约 21ms，一次性）。应用启动时调一次，别让第一次搜索吃这 21ms */
export function warmupSandbox(): Promise<void> {
  return loadModule().then(() => undefined)
}

function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS()
  return modulePromise
}

export async function runScript(options: RunScriptOptions): Promise<RunScriptResult> {
  if (modulePoisoned) {
    return {
      ok: false,
      value: '',
      raw: undefined,
      error: { kind: 'script', message: '沙箱已失效（wasm 曾异常中止），需重启应用' },
      elapsedMs: 0,
      rounds: 0,
      ajaxUrls: []
    }
  }
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const startedAt = Date.now()
  const cache = new Map<string, AjaxResponse>()
  const requestUrls: string[] = []
  const variables = options.variables ?? new Map<string, string>()

  let rounds = 0

  while (rounds < limits.maxRounds) {
    const remaining = limits.totalBudgetMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      return fail('budget', `js 规则总耗时超过 ${limits.totalBudgetMs}ms`, startedAt, rounds, requestUrls)
    }
    const misses: string[] = []
    rounds++

    const outcome = await evalRound({
      code: options.code,
      bindings: options.bindings,
      limits,
      budgetMs: Math.min(limits.timeoutMs, remaining),
      variables,
      sourceKey: options.sourceKey ?? '',
      log: options.log,
      ajax: (url) => {
        const hit = cache.get(url)
        if (hit !== undefined) return hit.body
        // 未命中**不抛异常**，先返回空串并把地址记下来，让本轮把要用的地址尽量暴露完：
        //   - 抛异常的话，一个 `for` 循环里的第 1 个地址就会中止脚本，
        //     20 页的循环要重放 20 轮、真发 20 个请求，才在轮次上限处失败
        //   - 返回空串则一轮就能收集齐 20 个地址，直接判定「单轮请求数超限」，
        //     一个真实请求都不发（自检里 `calls=0` 那条断言盯的就是这个）
        misses.push(url)
        return ''
      }
    })

    // 「未命中」优先于错误：缺数据时脚本本来就容易跟着报错（`''.match(...)` 为 null），
    // 那种错误是先补齐再重跑才谈得上的，不该直接当规则错误报出去
    if (misses.length > 0) {
      const pending = [...new Set(misses)]
      const room = Math.min(limits.maxFetchesPerRound, limits.maxRequests - requestUrls.length)
      if (room <= 0) {
        return fail('budget', `js 规则请求数超过上限 ${limits.maxRequests}`, startedAt, rounds, requestUrls)
      }
      if (pending.length > room) {
        return fail(
          'budget',
          `单轮需要补 ${pending.length} 个请求，超过单轮上限 ${limits.maxFetchesPerRound}`,
          startedAt,
          rounds,
          requestUrls
        )
      }
      if (options.ajax === undefined) {
        return fail('ajax', '该上下文未开放网络（java.ajax 不可用）', startedAt, rounds, requestUrls)
      }
      for (const url of pending) {
        try {
          const response = await options.ajax(url)
          cache.set(url, response)
          requestUrls.push(url)
        } catch (err) {
          return fail('ajax', `java.ajax 失败：${messageOf(err)}（${url}）`, startedAt, rounds, requestUrls)
        }
      }
      continue
    }

    if (outcome.error !== null) {
      // 脚本自身出错、超时、内存超限都不重放：重跑一遍只会得到同样的结果
      return {
        ok: false,
        value: '',
        raw: undefined,
        error: outcome.error,
        elapsedMs: Date.now() - startedAt,
        rounds,
        ajaxUrls: requestUrls
      }
    }

    return {
      ok: true,
      value: toRuleText(outcome.value),
      raw: outcome.value,
      error: null,
      elapsedMs: Date.now() - startedAt,
      rounds,
      ajaxUrls: requestUrls
    }
  }

  return fail(
    'budget',
    `js 规则重放轮次超过 ${limits.maxRounds}`,
    startedAt,
    rounds,
    requestUrls
  )
}

function fail(
  kind: ScriptErrorKind,
  message: string,
  startedAt: number,
  rounds: number,
  ajaxUrls: string[]
): RunScriptResult {
  return { ok: false, value: '', raw: undefined, error: { kind, message }, elapsedMs: Date.now() - startedAt, rounds, ajaxUrls }
}

interface RoundOptions {
  code: string
  bindings: Record<string, unknown> | undefined
  limits: SandboxLimits
  budgetMs: number
  variables: Map<string, string>
  sourceKey: string
  log: ((level: 'log' | 'warn' | 'error', message: string) => void) | undefined
  ajax: (url: string, options?: AjaxRequestOptions) => string
}

interface RoundOutcome {
  value: unknown
  error: ScriptError | null
}

async function evalRound(options: RoundOptions): Promise<RoundOutcome> {
  const module = await loadModule()
  const runtime = module.newRuntime()
  const deadline = Date.now() + options.budgetMs

  // 用标志位而不是事后比时间：中断后 dump/释放本身也要几毫秒，容易误判
  let interrupted = false
  runtime.setMemoryLimit(options.limits.memoryBytes)
  runtime.setMaxStackSize(options.limits.stackBytes)
  runtime.setInterruptHandler(() => {
    if (interrupted) return true
    if (Date.now() > deadline) interrupted = true
    return interrupted
  })

  const context = runtime.newContext()
  // 宿主级异常（wasm abort、栈被撞穿）之后 runtime 已不可安全释放：留着泄漏，
  // 也比 abort 掉整个模块、把后续所有规则一起带走要好
  let broken = false
  try {
    installBindings(context, options.bindings)
    installJavaApi(context, {
      ajax: options.ajax,
      log: (level, message) => options.log?.(level, message),
      getVariable: (key) => options.variables.get(key),
      setVariable: (key, value) => {
        options.variables.set(key, value)
      },
      sourceKey: options.sourceKey
    })

    const result = context.evalCode(options.code, 'rule.js')
    if (result.error) {
      const dumped = safeDump(context, result.error)
      result.error.dispose()
      return { value: undefined, error: classify(dumped, interrupted, options.limits) }
    }

    let value = safeDump(context, result.value)
    result.value.dispose()

    // 脚本以 `var x = ...` 结尾时完成值是 undefined，退回 Legado 的 `result` 约定
    if (value === undefined) {
      const handle = context.getProp(context.global, 'result')
      value = safeDump(context, handle)
      handle.dispose()
    }

    return { value, error: null }
  } catch (err) {
    broken = true
    modulePoisoned = true
    return { value: undefined, error: { kind: 'script', message: `沙箱异常（已停用，需重启应用）：${messageOf(err)}` } }
  } finally {
    if (!broken) {
      try {
        context.dispose()
        runtime.dispose()
      } catch (err) {
        // 释放阶段才炸，说明这次执行已经把运行时弄坏了；进程还活着，标记后不再使用
        modulePoisoned = true
        options.log?.('error', `沙箱释放异常：${messageOf(err)}`)
      }
    }
  }
}

function installBindings(context: QuickJSContext, bindings: Record<string, unknown> | undefined): void {
  if (bindings === undefined) return
  const lines: string[] = []
  for (const [name, value] of Object.entries(bindings)) {
    if (!isIdentifier(name)) continue
    lines.push(`var ${name} = ${toJsLiteral(value)};`)
  }
  if (lines.length === 0) return
  const result = context.evalCode(lines.join('\n'), 'bindings.js')
  // 绑定脚本必定成功；真有语法问题说明是内部 bug，释放掉句柄即可
  if (result.error) result.error.dispose()
  else result.value.dispose()
}

function safeDump(context: QuickJSContext, handle: QuickJSHandle): unknown {
  try {
    return context.dump(handle)
  } catch {
    // 循环引用等 dump 不了的值：给 undefined，让上层按「没取到」处理
    return undefined
  }
}

/** 把 QuickJS 抛出的错误翻译成调用方要的类别；顺序不能换（message 重叠） */
export function classify(
  dumped: unknown,
  timedOut: boolean,
  limits: Pick<SandboxLimits, 'memoryBytes' | 'stackBytes'> = DEFAULT_LIMITS
): ScriptError {
  const record = (dumped ?? {}) as { name?: unknown; message?: unknown }
  const name = typeof record.name === 'string' ? record.name : ''
  const message = typeof record.message === 'string' ? record.message : String(dumped ?? '')

  const miss = isAjaxMiss(message)
  if (miss !== null) return { kind: 'ajax', message: `java.ajax 未命中：${miss}` }

  if (/out of memory/i.test(message)) {
    return { kind: 'memory', message: `沙箱内存超限（${Math.round(limits.memoryBytes / 1024 / 1024)}MB）` }
  }
  if (/stack overflow/i.test(message)) {
    return { kind: 'memory', message: `沙箱栈溢出（${Math.round(limits.stackBytes / 1024)}KB）` }
  }
  if (name === 'InternalError' && /interrupt/i.test(message)) return { kind: 'timeout', message: '规则执行超时' }
  if (timedOut) return { kind: 'timeout', message: '规则执行超时' }
  if (name === 'SyntaxError') return { kind: 'script', message: `语法错误：${message}` }
  return { kind: 'script', message: name === '' ? message : `${name}: ${message}` }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
