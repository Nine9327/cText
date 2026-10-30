/**
 * M4-05 自检：QuickJS 沙箱。
 *
 * 五段：
 *   1. 取值：完成值 / `result` 兜底 / 数字·数组·对象归一
 *   2. 隔离：`require`/`process`/`fetch`/`WebAssembly` 不可达，构造器链也逃不出去
 *   3. 双限：死循环 800ms 内被打断、栈溢出、内存炸弹有时限（§7.4 的核心结论）
 *   4. `java.*`：base64 / md5 / timeFormat / htmlFormat / encodeURI / log / put·get / source.getKey
 *   5. ajax 重放：未命中中止→补齐→重跑，缓存生效，被 try/catch 吞掉也一样；上限能兜住
 *
 * 全程离线：`ajax` 注入的是假取数器，不碰网络。
 */
import { runScript, warmupSandbox, type RunScriptResult } from './sandbox'
import { base64Encode, md5, timeFormat } from './javaApi'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function runJsSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  const warmStart = Date.now()
  await warmupSandbox()
  check('wasm 模块加载', true, `${Date.now() - warmStart}ms`)

  const run = (code: string, extra: Partial<Parameters<typeof runScript>[0]> = {}): Promise<RunScriptResult> =>
    runScript({ code, ...extra })

  // ---------------------------------------------------------------- 1. 取值
  {
    const cases: Array<[string, string, string]> = [
      ['表达式完成值', '1+1', '2'],
      ['字符串方法链', "'三体'.slice(0, 1)", '三'],
      ['多语句取最后一条', 'var a = 1; a + 41', '42'],
      ['数字 0 不当空值', '0', '0'],
      ['布尔转文本', 'true', 'true'],
      ['模板字符串', 'var n = 2; `第${n}章`', '第2章'],
      ['数组转 JSON', '[1, 2]', '[1,2]'],
      ['对象转 JSON', '({name: "三体"})', '{"name":"三体"}'],
      ['null 转空串', 'null', ''],
      ['undefined 转空串', 'undefined', '']
    ]
    for (const [name, code, expected] of cases) {
      const r = await run(code)
      check(name, r.ok && r.value === expected, r.ok ? r.value : `${r.error?.kind}: ${r.error?.message}`)
    }

    // Legado 的约定：脚本可以改 `result`，也可以什么都不返回
    const kept = await run('var t = 1;', { bindings: { result: '上一步' } })
    check('无完成值时回退 result 绑定', kept.ok && kept.value === '上一步', kept.value)

    const replaced = await run('result = result + "!";', { bindings: { result: '上一步' } })
    check('脚本改写 result 生效', replaced.ok && replaced.value === '上一步!', replaced.value)

    const withBook = await run('book.name', { bindings: { book: { name: '沙丘' } } })
    check('对象绑定可深取', withBook.ok && withBook.value === '沙丘', withBook.value)

    const badVar = await run('typeof 非法名', { bindings: { '非法名': 1 } })
    check('非法变量名被丢弃而不是拼坏源码', badVar.ok && badVar.value === 'undefined', badVar.value)

    const lineSep = await run('x.length', { bindings: { x: 'a\u2028b' } })
    check('U+2028 不截断脚本', lineSep.ok && lineSep.value === '3', lineSep.value)
  }

  // ---------------------------------------------------------------- 2. 隔离
  {
    const probes: Array<[string, string]> = [
      ['require 不可达', 'typeof require'],
      ['process 不可达', 'typeof process'],
      ['fetch 不可达', 'typeof fetch'],
      ['XMLHttpRequest 不可达', 'typeof XMLHttpRequest'],
      ['WebAssembly 不可达', 'typeof WebAssembly'],
      ['importScripts 不可达', 'typeof importScripts'],
      ['Buffer 不可达', 'typeof Buffer'],
      ['setTimeout 不可达（不提供定时器）', 'typeof setTimeout']
    ]
    for (const [name, code] of probes) {
      const r = await run(code)
      check(name, r.ok && r.value === 'undefined', r.value)
    }

    // 经典逃逸写法：从函数构造器爬回宿主。沙箱里没有宿主，爬回去也是沙箱自己
    const viaCtor = await run("globalThis.constructor.constructor('return typeof process')()")
    check('构造器链拿不到 process', viaCtor.ok && viaCtor.value === 'undefined', viaCtor.value)

    const viaThis = await run("(function(){ return this })().constructor.constructor('return typeof require')()")
    check('函数内 this 构造器链拿不到 require', viaThis.ok && viaThis.value === 'undefined', viaThis.value)

    const noGlobals = await run('Object.keys(globalThis).sort().join(",")')
    const keys = noGlobals.value.split(',')
    const forbidden = ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebAssembly', 'Buffer', 'window', 'document']
    check(
      '全局只暴露白名单能力',
      noGlobals.ok && keys.includes('java') && keys.includes('source') && forbidden.every((k) => !keys.includes(k)),
      noGlobals.value
    )
  }

  // ---------------------------------------------------------------- 3. 双限
  {
    const loop = await run('while(true){}')
    check('死循环被中止', !loop.ok && loop.error?.kind === 'timeout', `${loop.error?.kind}: ${loop.error?.message}`)
    check('死循环 1.5s 内返回', loop.elapsedMs < 1_500, `${loop.elapsedMs}ms`)

    const busy = await run('var s = 0; for (var i = 0; i < 1e9; i++) s += i; s')
    check('长计算同样被中止', !busy.ok && busy.error?.kind === 'timeout', `${busy.elapsedMs}ms`)

    const deep = await run('function f(){ return f() } f()')
    check('无限递归归为内存/栈类', !deep.ok && deep.error?.kind === 'memory', `${deep.error?.kind}: ${deep.error?.message}`)

    // §7.4 的结论：内存上限单独存在时炸弹要跑 4–6s；双限之后必须 800ms 级返回
    const bomb = await run('var a = []; while (true) { a.push(new Array(10000).fill(1)) }')
    check(
      '内存炸弹被拦（timeout 或 memory 均可）',
      !bomb.ok && (bomb.error?.kind === 'timeout' || bomb.error?.kind === 'memory'),
      `${bomb.error?.kind}: ${bomb.error?.message}`
    )
    // 断言的实质是「不靠内存上限兜底」：§7.4 实测单挂内存上限要 4–6s。
    // 3s 的余量是给超时溢出的——中断只在字节码边界检查，单条 `new Array(10000).fill(1)`
    // 在 C 里要跑完才回到 JS 边界（实测 Node 1.2s / Electron 1.5s）
    check('内存炸弹 3s 内返回（靠的是时间上限）', bomb.elapsedMs < 3_000, `${bomb.elapsedMs}ms`)

    // 中止后必须能继续用：一条坏规则不该污染后面的规则
    const after = await run('1 + 1')
    check('中止后沙箱仍可用', after.ok && after.value === '2', after.value)

    // 自定义更小的预算也得生效
    const tiny = await run('while(true){}', { limits: { timeoutMs: 150 } })
    check('自定义 150ms 预算生效', !tiny.ok && tiny.elapsedMs < 900, `${tiny.elapsedMs}ms`)
  }

  // ---------------------------------------------------------------- 4. java.*
  {
    check('base64Encode 中文', (await run("java.base64Encode('三体')")).value === base64Encode('三体'), base64Encode('三体'))
    check('base64 是 encode 的别名', (await run("java.base64('abc')")).value === base64Encode('abc'), 'YWJj')
    check('base64Decode 往返', (await run(`java.base64Decode('${base64Encode('中文正文')}')`)).value === '中文正文', '')
    check('base64Decode 忽略空白', (await run(`java.base64Decode('${base64Encode('ab')}')`)).value === 'ab', '')

    check('md5Encode 对齐 RFC 1321 用例', (await run("java.md5Encode('abc')")).value === md5('abc'), md5('abc'))
    check('md5Encode 中文稳定', (await run("java.md5Encode('三体')")).value.length === 32, '')
    check('md5Encode16 取中 16 位', (await run("java.md5Encode16('abc')")).value === md5('abc').slice(8, 24), '')

    check('timeFormat 秒级时间戳', (await run("java.timeFormat(0, 'yyyy-MM-dd')")).value === '1970-01-01', '')
    check(
      'timeFormat 毫秒级时间戳',
      (await run("java.timeFormat(1700000000000, 'yyyy-MM-dd HH:mm')")).value ===
        timeFormat(1700000000000, 'yyyy-MM-dd HH:mm'),
      timeFormat(1700000000000, 'yyyy-MM-dd HH:mm')
    )
    check('timeFormat 默认模式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test((await run('java.timeFormat()')).value), '')

    check(
      'htmlFormat 去标签并解实体',
      (await run(`java.htmlFormat('<p>三体 &amp; 沙丘</p><br><b>刘慈欣</b>')`)).value === '三体 & 沙丘\n刘慈欣',
      ''
    )
    check('htmlEscape 转义尖括号', (await run("java.htmlEscape('<a>')")).value === '&lt;a&gt;', '')
    check('encodeURI 空格编成 +', (await run("java.encodeURI('a b&c')")).value === 'a+b%26c', '')

    const logs: string[] = []
    await run("java.log('规则日志', 1); console.warn('警告')", { log: (level, m) => logs.push(`${level}:${m}`) })
    check('java.log 进宿主日志', logs.includes('log:规则日志 1'), logs.join(' | '))
    check('console.warn 归到同一通道', logs.includes('warn:警告'), logs.join(' | '))

    const vars = new Map<string, string>()
    await run("java.put('token', 'abc')", { variables: vars })
    check('java.put 写入共享存储', vars.get('token') === 'abc', String(vars.get('token')))
    const read = await run("java.get('token')", { variables: vars })
    check('java.get 跨次读取', read.ok && read.value === 'abc', read.value)
    const missing = await run("java.get('nope')", { variables: vars })
    check('java.get 未设置返回 null', missing.ok && missing.value === '', missing.value)

    const key = await run('source.getKey()', { sourceKey: 'https://example.com/src' })
    check('source.getKey 注入源标识', key.ok && key.value === 'https://example.com/src', key.value)
  }

  // ---------------------------------------------------------------- 5. ajax 重放
  {
    const fetched: string[] = []
    const fakeAjax = async (url: string) => {
      fetched.push(url)
      return { status: 200, url, body: `<html>${url}</html>` }
    }

    const once = await run("java.ajax('http://a.test/1')", { ajax: fakeAjax })
    check('单次 ajax 取到正文', once.ok && once.value === '<html>http://a.test/1</html>', once.value)
    check('单次 ajax 需要 2 轮（先缺后补）', once.rounds === 2, `rounds=${once.rounds}`)
    check('只发一次请求', fetched.length === 1, fetched.join(','))

    fetched.length = 0
    const twice = await run("var a = java.ajax('http://a.test/2'); var b = java.ajax('http://a.test/2'); a + b", {
      ajax: fakeAjax
    })
    check('同一地址第二次命中缓存', twice.ok && fetched.length === 1, `fetched=${fetched.length}`)
    check('重复 ajax 结果正确', twice.value === '<html>http://a.test/2</html><html>http://a.test/2</html>', twice.value)

    fetched.length = 0
    const loop = await run(
      "var out = []; for (var i = 0; i < 3; i++) { out.push(java.ajax('http://a.test/p' + i)) } out.length",
      { ajax: fakeAjax }
    )
    check('循环里多次 ajax 也能收敛', loop.ok && loop.value === '3', `${loop.value} rounds=${loop.rounds}`)
    check('三个地址各取一次', fetched.length === 3, fetched.join(','))

    fetched.length = 0
    const swallowed = await run(
      "var t = ''; try { t = java.ajax('http://a.test/swallow') } catch (e) { t = 'err' } t",
      { ajax: fakeAjax }
    )
    check('把空结果兜住也能在重放后拿到正文', swallowed.ok && swallowed.value === '<html>http://a.test/swallow</html>', swallowed.value)

    const noNetwork = await run("java.ajax('http://a.test/x')")
    check('未注入 ajax 时 fail-closed', !noNetwork.ok && noNetwork.error?.kind === 'ajax', `${noNetwork.error?.kind}: ${noNetwork.error?.message}`)

    const failing = await run("java.ajax('http://a.test/boom')", {
      ajax: async () => {
        throw new Error('连接被重置')
      }
    })
    check('取数失败归为 ajax 错误', !failing.ok && failing.error?.kind === 'ajax', `${failing.error?.message}`)

    // 一条 `for` 扫 20 页的规则不能变成 20 个真实请求：单轮上限必须挡住
    let callCount = 0
    const flood = await run("for (var i = 0; i < 20; i++) { java.ajax('http://a.test/f' + i) }", {
      ajax: async (url: string) => {
        callCount++
        return { status: 200, url, body: '' }
      }
    })
    check('单轮请求数超限被拦住', !flood.ok && flood.error?.kind === 'budget', `${flood.error?.kind}: ${flood.error?.message}`)
    check('被拦住时一个真实请求都没发', callCount === 0, `calls=${callCount}`)
  }

  // ---------------------------------------------------------------- 6. 错误归类
  {
    const syntax = await run('function f( {')
    check('语法错误归为 script', !syntax.ok && syntax.error?.kind === 'script', `${syntax.error?.message}`)
    check('语法错误消息带前缀', syntax.error?.message.startsWith('语法错误') === true, syntax.error?.message ?? '')

    const thrown = await run("throw new Error('书源作者写的错')")
    check('脚本抛错归为 script', !thrown.ok && thrown.error?.kind === 'script', `${thrown.error?.message}`)
    check('错误消息保留原文', thrown.error?.message.includes('书源作者写的错') === true, thrown.error?.message ?? '')

    const refErr = await run('notDefinedAnywhere()')
    check('未定义函数归为 script', !refErr.ok && refErr.error?.kind === 'script', `${refErr.error?.message}`)
  }

  return checks
}
