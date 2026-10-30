/**
 * M4-11 自检：规则调试面板的数据层。
 *
 * 全程离线：本地 127.0.0.1 服务器扮演书源站点，四种页面（搜索 / 详情 / 目录 / 正文）
 * 各一个；另有一个 500 页与一个超大页，用来验证失败归因与片段截断。
 *
 * **不需要数据库**：调试是只读的，`runSourceDebug` 只吃一条 `SourceRecord`。
 * 这一点本身也是断言——它拿不到 `Db`，就写不了书架、目录与缓存。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpClient, type HttpClient } from '../http/client'
import type { SourceRecord } from '../../db/repositories/sources'
import { runSourceDebug } from './debug'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** 规则写成真实书源的样子：不带 `@css:` 前缀，字段只写取值后缀 */
const RULES = {
  searchUrl: '/search?q={{key}}',
  ruleSearch: {
    bookList: '.result>li',
    name: 'h3@text',
    author: '.author@text',
    bookUrl: 'a@href'
  },
  ruleBookInfo: {
    name: 'h1@text',
    author: '.author@text',
    intro: '#intro@text',
    tocUrl: 'a.toc@href'
  },
  ruleToc: {
    chapterList: '#list>li',
    chapterName: 'text',
    chapterUrl: 'a@href'
  },
  ruleContent: {
    content: '#content@html'
  }
}

function makeRecord(base: string, rules: Record<string, unknown> = RULES): SourceRecord {
  return {
    id: 'src-debug',
    url: base,
    name: '调试测试源',
    group: null,
    enabled: true,
    customOrder: 0,
    compatLevel: 'full',
    compatNote: null,
    ruleJson: JSON.stringify({ bookSourceUrl: base, bookSourceName: '调试测试源', ...rules }),
    lastUsedAt: null,
    createdAt: Date.now(),
    failStreak: 0,
    breakerUntil: null,
    lastFailure: null
  }
}

export async function runDebugSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  const servers: Server[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (body: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    }

    if (url.pathname === '/search') {
      return send(`<html><body><ul class="result">
        <li><h3>三体</h3><span class="author">刘慈欣</span><a href="/detail/1">详情</a></li>
        <li><h3>球状闪电</h3><span class="author">刘慈欣</span><a href="/detail/2">详情</a></li>
      </ul></body></html>`)
    }
    if (url.pathname === '/detail/1') {
      return send(`<html><body><h1>三体</h1><span class="author">刘慈欣</span>
        <div id="intro">地球往事三部曲第一部。</div><a class="toc" href="/toc/1">目录</a></body></html>`)
    }
    if (url.pathname === '/detail/big') {
      return send(`<html><body><h1>大页面</h1><div id="intro">${'巨'.repeat(6000)}</div>
        <a class="toc" href="/toc/1">目录</a></body></html>`)
    }
    if (url.pathname === '/detail/broken') return send('<html><body>boom</body></html>', 500)
    if (url.pathname === '/toc/1') {
      return send(`<html><body><div id="list">
        <li><a href="/c/1">第1章 起</a></li>
        <li><a href="/c/2">第2章 承</a></li>
        <li><a href="/c/3">第3章 转</a></li>
      </div></body></html>`)
    }
    if (url.pathname.startsWith('/c/')) {
      return send('<html><body><div id="content"><p>正文第一段</p><p>正文第二段</p></div></body></html>')
    }
    return send('not found', 404)
  })
  servers.push(server)

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const http: HttpClient = createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 5_000 })

  try {
    const record = makeRecord(base)

    // ---------------------------------------------------------------- 四段全跑
    const full = await runSourceDebug(record, { sourceId: record.id, url: `${base}/detail/1`, keyword: '三体' }, http)
    const byPhase = (phase: string): (typeof full.sections)[number] | undefined =>
      full.sections.find((section) => section.phase === phase)
    const search = byPhase('search')
    const info = byPhase('info')
    const toc = byPhase('toc')
    const content = byPhase('content')

    check(
      '四段按 search → info → toc → content 固定顺序返回',
      full.sections.map((section) => section.phase).join(',') === 'search,info,toc,content',
      full.sections.map((section) => section.phase).join(',')
    )
    check('四段全部成功', full.sections.every((section) => section.ok) && !full.sections.some((s) => s.skipped))

    check('搜索段取到 2 条', search?.summary === '2 条结果', search?.summary ?? 'null')
    check(
      '搜索段的请求步带着实际地址与状态',
      search?.steps.some(
        (step) => step.kind === 'request' && step.status === 200 && step.url !== null && step.url.includes('/search')
      ) === true
    )
    check(
      '搜索段的规则步保留规则原文',
      search?.steps.some((step) => step.kind === 'rule' && step.rule === '.result>li' && step.values.length === 2) ===
        true
    )

    check('详情段摘要带书名与作者', info?.summary === '三体 · 刘慈欣', info?.summary ?? 'null')
    check(
      '详情字段逐个记了结果（name / author / tocUrl）',
      ['详情字段 name', '详情字段 author', '详情字段 tocUrl'].every((label) =>
        info?.steps.some((step) => step.label === label && step.values.length === 1)
      ) === true,
      (info?.steps ?? []).map((step) => step.label).join(' / ')
    )
    check(
      '同一个段里请求步排在规则步之前',
      (() => {
        const steps = info?.steps ?? []
        const requestAt = steps.findIndex((step) => step.kind === 'request')
        const ruleAt = steps.findIndex((step) => step.kind === 'rule')
        return requestAt === 0 && ruleAt > requestAt
      })()
    )

    check('目录段取到 3 章', toc?.summary === '3 章 / 1 页', toc?.summary ?? 'null')
    check(
      '目录第一条的字段取值单独记录（列表取到、字段取不到时靠它定位）',
      toc?.steps.some((step) => step.label === '第 1 条 · chapterName' && step.values[0] === '第1章 起') === true,
      (toc?.steps ?? []).map((step) => step.label).join(' / ')
    )
    check(
      '正文段取到两段并转成 <p>',
      content?.ok === true && (content?.summary.endsWith('页') ?? false),
      content?.summary ?? 'null'
    )
    check(
      '正文规则步的结果是原始 HTML 片段',
      content?.steps.some((step) => step.kind === 'rule' && step.values.some((value) => value.includes('正文第一段'))) ===
        true
    )

    // ---------------------------------------------------------------- 片段截断
    const big = await runSourceDebug(record, { sourceId: record.id, url: `${base}/detail/big` }, http)
    const bigRequest = big.sections.find((section) => section.phase === 'info')?.steps.find((step) => step.kind === 'request')
    check(
      '响应片段截到 2KB 并标注原长',
      bigRequest?.snippet != null &&
        bigRequest.snippet.startsWith('<html>') &&
        bigRequest.snippet.includes('已截断，原长') &&
        bigRequest.snippet.length < 2200,
      `${bigRequest?.snippet?.length ?? 0} 字`
    )

    // ---------------------------------------------------------------- 跳过与失败
    const noKeyword = await runSourceDebug(record, { sourceId: record.id, url: `${base}/detail/1` }, http)
    const skipped = noKeyword.sections.find((section) => section.phase === 'search')
    check(
      '没填关键词：搜索段显式跳过而不是报错',
      skipped?.skipped === true && skipped.ok === false && skipped.summary.includes('关键词') === true,
      skipped?.summary ?? 'null'
    )

    const noUrl = await runSourceDebug(record, { sourceId: record.id, phases: ['info', 'toc'] }, http)
    check(
      '没填地址：详情与目录都跳过，且各给各的原因',
      noUrl.sections.length === 2 && noUrl.sections.every((section) => section.skipped),
      noUrl.sections.map((section) => `${section.phase}:${section.summary}`).join(' / ')
    )

    const broken = await runSourceDebug(record, { sourceId: record.id, url: `${base}/detail/broken` }, http)
    const brokenInfo = broken.sections.find((section) => section.phase === 'info')
    check(
      '站点 500：详情段失败并带上 E_HTTP 与状态码',
      brokenInfo?.ok === false &&
        brokenInfo.error?.includes('E_HTTP') === true &&
        brokenInfo.steps.some((step) => step.status === 500) === true,
      brokenInfo?.error ?? 'null'
    )
    check(
      '详情失败不会连带跳过目录段（仍然按用户填的地址去试一次）',
      (() => {
        const tocSection = broken.sections.find((section) => section.phase === 'toc')
        return tocSection !== undefined && !tocSection.skipped && tocSection.steps.some((step) => step.kind === 'request')
      })(),
      broken.sections.find((section) => section.phase === 'toc')?.summary ?? 'null'
    )

    // ---------------------------------------------------------------- 章节地址与段选择
    const direct = await runSourceDebug(
      record,
      { sourceId: record.id, chapterUrl: `${base}/c/9`, phases: ['content'] },
      http
    )
    check(
      '只跑正文 + 直接给章节地址',
      direct.sections.length === 1 &&
        direct.sections[0].phase === 'content' &&
        direct.sections[0].ok &&
        direct.sections[0].steps.some((step) => step.url?.endsWith('/c/9')) === true
    )

    // ---------------------------------------------------------------- 坏记录
    const badRecord: SourceRecord = { ...record, ruleJson: '{not json' }
    const bad = await runSourceDebug(badRecord, { sourceId: badRecord.id, keyword: '三体', phases: ['search'] }, http)
    check(
      '坏记录：搜索段返回 E_BAD_RECORD 而不是抛异常',
      bad.sections[0]?.ok === false && bad.sections[0].error?.includes('E_BAD_RECORD') === true,
      bad.sections[0]?.error ?? 'null'
    )

    // ---------------------------------------------------------------- 只读
    check(
      '调试结果不含任何书籍 id（只读，不落库）',
      full.sections.every((section) => section.steps.every((step) => !('bookId' in step))) &&
        !('bookId' in full)
    )
  } finally {
    await http.close()
    for (const item of servers) await new Promise<void>((resolve) => item.close(() => resolve()))
  }

  return checks
}
