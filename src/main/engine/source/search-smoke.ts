/**
 * M4-08 自检：网络搜索聚合。
 *
 * 全程离线：起若干个 127.0.0.1 的本地服务器当「10 个书源站点」，用临时 `SourceRecord`
 * 直接喂给聚合器（不建库、不碰 userData）。
 *
 * 五块断言：
 *   1. URL 插值 / POST 选项 / 标题清洗 —— 纯函数，最先跑
 *   2. 并发池 —— 用可控延迟的任务量峰值，精确到「上限就是 8」
 *   3. 10 源并发总耗时 —— 计划验收那条（≤ 最慢源 +2s）
 *   4. 分源分组与字段提取（含 JS 规则、相对地址补全、请求头透传）
 *   5. 失败源清单 —— 500 / 超时 / 缺 searchUrl / 缺 bookList / 坏记录 / 非文本
 *
 * **每个模拟书源必须占一个独立端口**。HTTP 层按 `host:port` 节流（同站串行），
 * 10 个源挤在同一个端口上，测出来的一定是串行——那是节流器在起作用，不是并发池坏了。
 * 真实书源天然分布在不同域名，所以这里用不同端口复现那个前提。
 *
 * 本地服务器只监听 127.0.0.1，所以客户端必须 `ssrf: false`：那是自检专用开关，
 * 业务层默认拒绝回环地址（由 `verify:http` 单独证明）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SourceRecord } from '../../db/repositories/sources'
import { extractRegex } from '../extractors/regex'
import { createHttpClient } from '../http/client'
import { buildSearchUrl, cleanTitle, runPool, searchSources, toSearchSource } from './search'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

interface Stats {
  /** 收到请求的端口顺序，用于断言「哪些源被真的请求过」 */
  requests: string[]
  peak: number
  lastHeaders: Record<string, string | string[] | undefined>
}

type Behaviour = 'normal' | 'fail' | 'slow' | 'empty' | 'noauthor'

export async function runSearchSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 1. 纯函数
  const source: ReturnType<typeof toSearchSource> = {
    id: 's1',
    name: '测试源',
    url: 'https://www.example.com/',
    searchUrl: '/s?q={{key}}&page={{page}}',
    header: { 'X-Token': 'abc' },
    bookSourceType: 0,
    rules: {},
    broken: null
  }

  {
    const built = buildSearchUrl(source, '三体 & 黑暗森林', 2)
    check(
      'searchUrl 的 {{key}} 按 URL 编码代入',
      built.ok && built.request.url.includes('%E4%B8%89%E4%BD%93%20%26%20'),
      built.ok ? built.request.url : built.reason
    )
    check(
      '相对 searchUrl 按书源地址补全',
      built.ok && built.request.url.startsWith('https://www.example.com/s?'),
      built.ok ? built.request.url : built.reason
    )
    check('{{page}} 代入页码', built.ok && built.request.url.endsWith('page=2'))

    const post = buildSearchUrl(
      { ...source, searchUrl: '/s,{"method":"POST","body":"key={{key}}","headers":{"X-A":"1"}}' },
      '三体',
      1
    )
    check(
      'searchUrl 支持 POST 选项与 body 插值',
      post.ok && post.request.method === 'POST' && post.request.body === 'key=%E4%B8%89%E4%BD%93',
      post.ok ? String(post.request.body) : post.reason
    )
    check('searchUrl 选项里的 headers 被解析', post.ok && post.request.headers['X-A'] === '1')

    const missing = buildSearchUrl({ ...source, searchUrl: null }, 'x', 1)
    check('没有 searchUrl 时给出原因', !missing.ok && missing.reason.includes('searchUrl'))

    check('标题去掉站点括号', cleanTitle('三体(www.xx.com)') === '三体', cleanTitle('三体(www.xx.com)'))
    check('标题去掉「最新章节」尾巴', cleanTitle('三体 最新章节') === '三体', cleanTitle('三体 最新章节'))
    check('书名里的「(第二部)」不被当广告删掉', cleanTitle('三体(第二部)') === '三体(第二部)')
    check('纯空白标题不会被清成空串', cleanTitle('  ') === '')
  }

  // ---------------------------------------------------------------- 2. 并发池
  {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 20 }, (_, i) => i)
    const results = await runPool(tasks, 8, async (task) => {
      active++
      peak = Math.max(peak, active)
      await delay(30)
      active--
      return task * 2
    })
    check('并发池同时在途峰值正好等于上限 8', peak === 8, `peak=${peak}`)
    check('并发池结果按入参顺序返回', results.every((value, index) => value === index * 2))

    let serialPeak = 0
    let serialActive = 0
    await runPool(tasks.slice(0, 4), 1, async () => {
      serialActive++
      serialPeak = Math.max(serialPeak, serialActive)
      await delay(10)
      serialActive--
      return null
    })
    check('并发上限为 1 时严格串行', serialPeak === 1, `peak=${serialPeak}`)
  }

  // ---------------------------------------------------------------- 3~5. 端到端
  const stats: Stats = { requests: [], peak: 0, lastHeaders: {} }
  let active = 0
  const servers: Server[] = []

  const listen = async (behaviour: Behaviour): Promise<string> => {
    const server = createServer((req, res) => {
      const port = (server.address() as AddressInfo).port
      stats.requests.push(String(port))
      stats.lastHeaders = req.headers
      active++
      stats.peak = Math.max(stats.peak, active)

      // 逐跳读完请求体（POST 搜索请求带 body），再按行为回应
      req.on('data', () => undefined)
      req.on('end', async () => {
        const send = (status: number, html: string): void => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html)
        }
        if (behaviour === 'fail') {
          active--
          send(500, '<html>boom</html>')
          return
        }
        await delay(behaviour === 'slow' ? 1200 : 400)
        active--

        if (behaviour === 'empty') return send(200, '<html><body><div class="list"></div></body></html>')
        if (behaviour === 'noauthor') {
          return send(200, page([{ title: '无名氏', author: '' }], { dropBookUrl: true }))
        }
        send(200, page([{ title: '三体 最新章节', author: '刘慈欣' }]))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const http = createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 5_000 })

  const record = (id: string, base: string, rules: Record<string, string> | null = null, extra: Record<string, unknown> = {}): SourceRecord => ({
    id,
    url: base,
    name: `源${id}`,
    group: null,
    enabled: true,
    customOrder: 0,
    compatLevel: 'full',
    compatNote: null,
    ruleJson: JSON.stringify({
      bookSourceUrl: base,
      bookSourceName: `源${id}`,
      searchUrl: '/search?q={{key}}',
      ruleSearch: rules ?? defaultSearchRules(),
      header: '{"X-Token":"abc"}',
      ...extra
    }),
    lastUsedAt: null,
    createdAt: 0,
    failStreak: 0,
    breakerUntil: null,
    lastFailure: null
  })

  try {
    const normal = await Promise.all(Array.from({ length: 10 }, () => listen('normal')))
    const failBase = await listen('fail')
    const slowBase = await listen('slow')
    const emptyBase = await listen('empty')
    const noauthorBase = await listen('noauthor')

    // ---- 10 源并发
    const ten = normal.map((base, index) => record(`n${index}`, base))
    const parallel = await searchSources(ten, '三体', {}, http)

    check('10 源全部成功时给出 10 个分组', parallel.groups.length === 10, `${parallel.groups.length}`)
    check('失败源清单在全部成功时为空', parallel.failures.length === 0)
    check(
      '10 源并发总耗时 ≤ 最慢源 +2s',
      parallel.elapsedMs <= 400 + 2000,
      `${parallel.elapsedMs}ms（10 源串行下限约 4000ms）`
    )
    check(
      '10 源同时在途的请求数符合并发上限',
      stats.peak >= 6 && stats.peak <= 8,
      `peak=${stats.peak}`
    )

    const first = parallel.groups[0].items[0]
    check('书名去掉了广告尾巴', first?.title === '三体', first?.title ?? '无结果')
    check('作者提取正确', first?.author === '刘慈欣', first?.author ?? '无结果')
    check(
      '相对 bookUrl 补全成绝对地址',
      first?.bookUrl === `${normal[0]}/book/1`,
      first?.bookUrl ?? '无结果'
    )
    check('书源自带 header 被透传', stats.lastHeaders['x-token'] === 'abc')
    check('分组带源名与耗时', parallel.groups[0].sourceName === '源n0' && parallel.groups[0].elapsedMs >= 400)

    // ---- 同名合并
    const merged = await searchSources(ten.slice(0, 2), '三体', {}, http)
    const mergedItems = merged.groups.flatMap((group) => group.items)
    check('同名同作者跨源合并成一条', mergedItems.length === 1, `${mergedItems.length}`)
    check('合并后保留另一个来源的地址', mergedItems[0]?.alsoIn?.length === 1, `${mergedItems[0]?.alsoIn?.length}`)

    const unmerged = await searchSources(ten.slice(0, 2), '三体', { mergeSame: false }, http)
    check('关闭同名合并时两条都在', unmerged.groups.flatMap((group) => group.items).length === 2)

    // ---- 失败源清单
    const mixed = await searchSources(
      [
        record('ok', normal[0]),
        record('fail', failBase),
        record('slow', slowBase),
        record('nourl', normal[1], null, { searchUrl: '' }),
        record('norule', normal[2], { name: '@css:h3@text' }),
        record('badrule', normal[3], { ...defaultSearchRules(), bookList: '@xpath://*[' }),
        record('broken', normal[4], null, { bookSourceUrl: '' }),
        record('audio', normal[5], null, { bookSourceType: 1 }),
        record('empty', emptyBase)
      ],
      '三体',
      { timeoutMs: 600 },
      http
    )
    const codes = mixed.failures.map((failure) => `${failure.sourceId}:${failure.code}`).sort()
    check('HTTP 500 归为 E_HTTP', codes.includes('fail:E_HTTP'), codes.join(' '))
    check('慢源归为 E_TIMEOUT', codes.includes('slow:E_TIMEOUT'), codes.join(' '))
    check('缺 searchUrl 归为 E_NO_SEARCH_URL', codes.includes('nourl:E_NO_SEARCH_URL'), codes.join(' '))
    check('缺 bookList 归为 E_NO_RULE', codes.includes('norule:E_NO_RULE'), codes.join(' '))
    check('坏 bookList 规则归为 E_RULE', codes.includes('badrule:E_RULE'), codes.join(' '))
    check('坏记录归为 E_BAD_RECORD', codes.includes('broken:E_BAD_RECORD'), codes.join(' '))
    check('非文本类型归为 E_UNSUPPORTED', codes.includes('audio:E_UNSUPPORTED'), codes.join(' '))
    check(
      '「站点没有结果」不算失败',
      !codes.some((code) => code.startsWith('empty:')) && mixed.groups.some((g) => g.sourceId === 'empty'),
      codes.join(' ')
    )
    check('一源失败不影响其它源的分组', mixed.groups.length === 2, `${mixed.groups.length}`)

    // ---- 只查指定源
    stats.requests.length = 0
    const scoped = await searchSources(ten, '三体', { sourceIds: [ten[3].id] }, http)
    check(
      'sourceIds 只请求选中的源',
      scoped.groups.length === 1 && stats.requests.length === 1,
      `requests=${stats.requests.length}`
    )

    stats.requests.length = 0
    const skipped = await searchSources([{ ...ten[0], enabled: false }], '三体', {}, http)
    check('停用的源不被请求', skipped.groups.length === 0 && stats.requests.length === 0)

    // ---- 字段规则里的 @js
    const jsSource = record('js', normal[6], {
      ...defaultSearchRules(),
      author: '@js:result.match(/class="author">([^<]+)/)[1]'
    })
    const js = await searchSources([jsSource], '三体', {}, http)
    check('字段规则支持 @js', js.groups[0]?.items[0]?.author === '刘慈欣', js.groups[0]?.items[0]?.author ?? '无结果')

    // ---- 没有 bookUrl 的条目被丢弃
    const drop = await searchSources([record('drop', noauthorBase)], '三体', {}, http)
    check(
      '缺详情地址的条目被丢弃，但该源仍算成功',
      drop.groups.length === 1 && drop.groups[0].items.length === 0 && drop.failures.length === 0
    )

    // ---- 灾难性回溯：静态拦下，不真的去跑
    const startedAt = Date.now()
    const risky = extractRegex('a'.repeat(20_000), '(a+)+$')
    check(
      '嵌套无界量词规则被拒绝执行（不卡死）',
      risky.values.length === 0 && risky.error !== null && Date.now() - startedAt < 500,
      risky.error ?? '未报错'
    )
  } catch (err) {
    check('搜索自检未抛异常', false, messageOf(err))
  } finally {
    await http.close()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  }

  return checks
}

function defaultSearchRules(): Record<string, string> {
  return {
    bookList: '@css:li.item',
    name: '@css:h3>a@text',
    author: '@css:.author@text',
    intro: '@css:.intro@text',
    kind: '@css:.kind@text',
    lastChapter: '@css:.last@text',
    bookUrl: '@css:h3>a@href'
  }
}

function page(items: Array<{ title: string; author: string }>, options: { dropBookUrl?: boolean } = {}): string {
  const rows = items
    .map(
      (item) =>
        `<li class="item"><h3><a href="${options.dropBookUrl === true ? '' : '/book/1'}">${item.title}</a></h3>` +
        `<span class="author">${item.author}</span><p class="intro">简介</p>` +
        `<span class="kind">玄幻</span><span class="last">第9章</span></li>`
    )
    .join('')
  return `<html><body><ul class="list">${rows}</ul></body></html>`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
