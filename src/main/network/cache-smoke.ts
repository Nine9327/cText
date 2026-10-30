/**
 * M4-10 自检：正文缓存治理（磁盘缓存 / TTL / 断网回退 / 清理 / 封面 / 预取）。
 *
 * 全程离线：起一个 127.0.0.1 的本地服务器当书源站点，缓存与封面写到临时目录，
 * 数据库也用临时 SQLite。不碰 userData，跑完即删。
 *
 * 断言覆盖六块：
 *   1. 落盘与命中：读一章写一个文件，再读（先清内存）不发请求
 *   2. TTL：过期后联网重抓、内容更新；抓不到时回退到过期缓存（断网可读）
 *   3. 目录刷新：URL 变了的章节缓存被 prune，没变的不动
 *   4. 用量与清理：统计数字对得上；清单本 / 清全部都不动车架与目录
 *   5. 封面：下载到 covers 目录、按内容哈希命名；非位图拒绝、重复下载复用
 *   6. 预取：读第 N 章后后台抓第 N+1 章，翻过去不再发请求；最后一章不预取
 *
 * 服务器必须 `ssrf: false` 才能连 127.0.0.1；`minIntervalMs: 0` 关掉同站 1s 间隔。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { AppError, ERROR_CODES } from '@shared/errors'
import { openDatabase } from '../db/connection'
import { SourcesRepository, type SourceRecord } from '../db/repositories/sources'
import { createHttpClient, type HttpClient } from '../engine/http/client'
import { chapterFile, chapterFileName } from '../network/cache'
import { downloadCover } from '../network/cover'
import {
  clearNetworkCache,
  clearNetworkCacheDir,
  flushPrefetch,
  getNetworkChapterContent,
  networkCacheDir,
  readNetworkCacheStats,
  refreshNetworkToc,
  addNetworkBook,
  type NetworkDeps
} from './service'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const RULES = {
  ruleBookInfo: {
    name: 'h1@text',
    coverUrl: 'img.cover@src',
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

const DAY_MS = 24 * 60 * 60 * 1000
/** 一张 1×1 的 PNG，用来冒充站点封面 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

export async function runCacheSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  const hits: string[] = []
  let offline = false
  /** 目录版本：2 时第 2 章的地址从 `/c/2` 变成 `/c/2b` */
  let tocVersion = 1
  /** 正文版本：改一次就换一版文本，用来证明「过期后真的重抓了」 */
  let contentVersion = 1

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push(url.pathname)
    if (offline) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>站点维护中</body></html>')
      return
    }

    const send = (body: string, type = 'text/html; charset=utf-8'): void => {
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    }

    if (url.pathname === '/detail/1') {
      return send(`<html><body>
        <h1>缓存之书</h1>
        <img class="cover" src="/cover.png">
        <a class="toc" href="/toc/1">目录</a>
      </body></html>`)
    }

    if (url.pathname === '/toc/1') {
      const second = tocVersion === 1 ? '/c/2' : '/c/2b'
      return send(`<html><body><div id="list">
        <li><a href="/c/1">第1章 甲</a></li>
        <li><a href="${second}">第2章 乙</a></li>
        <li><a href="/c/3">第3章 丙</a></li>
      </div></body></html>`)
    }

    if (url.pathname === '/cover.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
      return
    }

    if (url.pathname === '/cover.svg') {
      return send('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml')
    }

    if (url.pathname.startsWith('/c/')) {
      const name = url.pathname.slice(3)
      return send(`<html><body><div id="content"><p>正文 v${contentVersion} 第 ${name} 章</p></div></body></html>`)
    }

    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('not found')
  })

  const servers: Server[] = [server]
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const http: HttpClient = createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 5_000 })

  const scratch = join(app.getPath('temp'), `ctext-cache-smoke-${Date.now()}`)
  const cacheRoot = join(scratch, 'cache')
  const coversRoot = join(scratch, 'covers')
  mkdirSync(scratch, { recursive: true })
  const { db } = openDatabase(join(scratch, 'cache.db'))

  const deps: NetworkDeps = {
    http,
    cacheRoot,
    coversRoot,
    ttlDays: 30,
    // 大部分断言要「读一章只发一个请求」，预取单独开一组
    prefetch: false,
    prefetchDelayMs: 0,
    prefetchHttp: () => createHttpClient({ ssrf: false, minIntervalMs: 0, timeoutMs: 5_000 })
  }

  try {
    const repo = new SourcesRepository(db)
    const record: SourceRecord = repo.upsert({
      url: `${base}/source-1`,
      name: '缓存书源',
      group: null,
      enabled: true,
      compatLevel: 'full',
      compatNote: null,
      ruleJson: JSON.stringify({ bookSourceUrl: `${base}/source-1`, bookSourceName: '缓存书源', ...RULES }),
      customOrder: 0,
      now: Date.now()
    }).record

    const added = await addNetworkBook(db, { sourceId: record.id, bookUrl: `${base}/detail/1` }, deps)
    const bookId = added.bookId
    check('加入书架成功（3 章）', added.chapterCount === 3 && added.reused === false, JSON.stringify(added))

    // ---------------------------------------------------------------- 5. 封面
    const coverRow = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(bookId) as
      | { cover_path: string | null }
      | undefined
    const coverName = coverRow?.cover_path ?? ''
    let coverBytes = 0
    try {
      coverBytes = (await stat(join(coversRoot, coverName))).size
    } catch {
      coverBytes = -1
    }
    check(
      '封面下载到 covers 目录并按内容哈希命名',
      /^cover_[a-f0-9]{16}\.png$/.test(coverName) && coverBytes === PNG.length,
      `${coverName} ${coverBytes}B`
    )

    const svg = await downloadCover(http, `${base}/cover.svg`, coversRoot)
    check('SVG 封面被拒绝（避免脚本面）', svg === null)

    const again = await downloadCover(http, `${base}/cover.png`, coversRoot)
    check('同一张封面重复下载复用已有文件', again !== null && again.reused === true && again.name === coverName)

    // ---------------------------------------------------------------- 1. 落盘与命中
    clearNetworkCache()
    const beforeRead = hits.length
    const first = await getNetworkChapterContent(db, bookId, 0, deps)
    check(
      '读第 1 章：内容正确、有下一章、没有上一章',
      first.html.includes('正文 v1 第 1 章') && first.hasNext && !first.hasPrev,
      `hasNext=${first.hasNext} hasPrev=${first.hasPrev}`
    )
    check('读一次只发一个正文请求', hits.length - beforeRead === 1, `${hits.length - beforeRead}`)

    const file0 = chapterFile({ root: cacheRoot }, bookId, 0, `${base}/c/1`)
    let file0Size = 0
    try {
      file0Size = (await stat(file0)).size
    } catch {
      file0Size = -1
    }
    check('正文按章落盘（<idx>-<urlHash>.html）', file0Size > 0 && file0.endsWith(chapterFileName(0, `${base}/c/1`)), `${file0Size}B`)

    clearNetworkCache()
    const beforeHit = hits.length
    const cached = await getNetworkChapterContent(db, bookId, 0, deps)
    check(
      '同一章再读走磁盘缓存（清掉内存也不发请求）',
      hits.length === beforeHit && cached.html === first.html,
      `requests=${hits.length - beforeHit}`
    )

    // ---------------------------------------------------------------- 3. 目录刷新后 prune
    clearNetworkCache()
    await getNetworkChapterContent(db, bookId, 1, deps)
    const oldFile1 = chapterFile({ root: cacheRoot }, bookId, 1, `${base}/c/2`)
    const hadOld1 = await exists(oldFile1)

    tocVersion = 2
    const refreshed = await refreshNetworkToc(db, bookId, deps)
    const newFile1 = chapterFile({ root: cacheRoot }, bookId, 1, `${base}/c/2b`)
    check(
      '刷新目录后章节数与内容都更新',
      refreshed.total === 3 && (await exists(newFile1)) === false && (await exists(oldFile1)) === false,
      `old=${hadOld1} new=${await exists(newFile1)}`
    )
    check(
      'URL 没变的章节缓存保留（不会因为刷新目录全部作废）',
      (await exists(file0)) === true
    )

    // ---------------------------------------------------------------- 2. TTL 与断网回退
    contentVersion = 2
    await age(file0, 40)
    clearNetworkCache()
    const beforeRefetch = hits.length
    const reFetched = await getNetworkChapterContent(db, bookId, 0, deps)
    check(
      '缓存过期后联网重抓，内容是新的',
      reFetched.html.includes('正文 v2 第 1 章') && hits.length - beforeRefetch === 1,
      `requests=${hits.length - beforeRefetch}`
    )
    const refreshedAge = Date.now() - (await stat(file0)).mtimeMs
    check('重抓后文件时间被刷新', refreshedAge < 5_000, `${Math.round(refreshedAge / 1000)}s`)

    // 断网：过期缓存必须还能读
    await age(file0, 40)
    offline = true
    clearNetworkCache()
    let fallback: string | null = null
    let fallbackError = ''
    try {
      fallback = (await getNetworkChapterContent(db, bookId, 0, deps)).html
    } catch (err) {
      fallbackError = err instanceof Error ? err.message : String(err)
    }
    check(
      '过期缓存 + 站点不可用：回退到已缓存内容而不是报错',
      fallback?.includes('正文 v2 第 1 章') === true,
      fallback === null ? fallbackError : ''
    )

    // 断网且没有缓存：必须报错，不能返回空白正文
    await clearNetworkCacheDir(db, bookId, deps)
    clearNetworkCache()
    const noCacheOffline = await expectError(async () => getNetworkChapterContent(db, bookId, 0, deps))
    check(
      '断网且没有缓存时报 E_IO（不是空白正文）',
      noCacheOffline.code === ERROR_CODES.io,
      `${noCacheOffline.code} ${noCacheOffline.message}`
    )
    offline = false

    // ---------------------------------------------------------------- 4. 用量与清理
    clearNetworkCache()
    await getNetworkChapterContent(db, bookId, 0, deps)
    await getNetworkChapterContent(db, bookId, 1, deps)
    const stats1 = await readNetworkCacheStats(db, deps)
    check(
      '缓存统计：文件数、字节数、书籍数与磁盘一致',
      stats1.files === 2 && stats1.bytes > 0 && stats1.totalBooks === 1 && stats1.books[0]?.title === '缓存之书',
      JSON.stringify({ files: stats1.files, bytes: stats1.bytes, books: stats1.totalBooks })
    )
    check(
      '统计目录与真实缓存根目录一致',
      stats1.dir === networkCacheDir(deps) && stats1.ttlDays === 30,
      `${stats1.dir} ttl=${stats1.ttlDays}`
    )

    await age(file0, 40)
    const stats2 = await readNetworkCacheStats(db, deps)
    check('过期章节单独计数，但仍留在盘上', stats2.expiredFiles === 1 && stats2.files === 2, `${stats2.expiredFiles}/${stats2.files}`)

    const clearedBook = await clearNetworkCacheDir(db, bookId, deps)
    const bookAlive = db.prepare('SELECT COUNT(*) AS n FROM books WHERE id = ?').get(bookId) as { n: number }
    const chaptersAlive = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(bookId) as { n: number }
    check(
      '清一本书的缓存：文件没了，书架记录与目录还在',
      clearedBook.files === 2 && clearedBook.bytes > 0 && bookAlive.n === 1 && chaptersAlive.n === 3,
      `files=${clearedBook.files} books=${bookAlive.n} chapters=${chaptersAlive.n}`
    )
    check('清理后统计归零', (await readNetworkCacheStats(db, deps)).files === 0)

    await getNetworkChapterContent(db, bookId, 0, deps)
    const clearedAll = await clearNetworkCacheDir(db, undefined, deps)
    check(
      '清全部缓存：文件清空，书架不动',
      clearedAll.files === 1 && (await readNetworkCacheStats(db, deps)).files === 0,
      `files=${clearedAll.files}`
    )

    // ---------------------------------------------------------------- 路径安全
    const traversal = await expectError(async () => {
      chapterFile({ root: cacheRoot }, '../evil', 0, `${base}/c/1`)
    })
    check('非法书籍 ID 直接拒绝（挡路径穿越）', traversal.code !== 'NO_ERROR', traversal.message)

    // ---------------------------------------------------------------- 6. 预取
    const prefetchDeps: NetworkDeps = { ...deps, prefetch: true }
    await clearNetworkCacheDir(db, bookId, deps)
    clearNetworkCache()
    const beforePrefetch = hits.length
    await getNetworkChapterContent(db, bookId, 0, prefetchDeps)
    await flushPrefetch()
    const prefetched = await exists(chapterFile({ root: cacheRoot }, bookId, 1, `${base}/c/2b`))
    check(
      '读完第 1 章后后台预取第 2 章（自己发了一次请求）',
      prefetched && hits.length - beforePrefetch === 2,
      `requests=${hits.length - beforePrefetch} prefetched=${prefetched}`
    )

    clearNetworkCache()
    const beforeHitPrefetched = hits.length
    // 这一步用关掉预取的 deps：否则它会顺手预取第 3 章，干扰下一组计数
    const secondContent = await getNetworkChapterContent(db, bookId, 1, { ...prefetchDeps, prefetch: false })
    check(
      '翻到预取过的那一章不再发请求',
      // 目录已切到 v2，第 2 章的地址是 /c/2b，正文里带的就是 2b
      hits.length - beforeHitPrefetched === 0 && secondContent.html.includes('正文 v2 第 2b 章'),
      `requests=${hits.length - beforeHitPrefetched}`
    )

    clearNetworkCache()
    const beforeLast = hits.length
    await getNetworkChapterContent(db, bookId, 2, prefetchDeps)
    await flushPrefetch()
    check(
      '最后一章不预取（没有下一章）',
      hits.length - beforeLast === 1,
      `requests=${hits.length - beforeLast}`
    )
  } catch (err) {
    check('缓存自检未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    await http.close()
    await Promise.all(servers.map((item) => new Promise<void>((resolve) => item.close(() => resolve()))))
    db.close()
    rmSync(scratch, { recursive: true, force: true })
  }

  return checks
}

/** 把文件 mtime 往前拨 N 天，模拟「很久以前抓的」 */
async function age(file: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * DAY_MS)
  await utimes(file, when, when)
}

async function exists(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile()
  } catch {
    return false
  }
}

async function expectError(task: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await task()
    return { code: 'NO_ERROR', message: '没有抛错' }
  } catch (err) {
    const code = err instanceof AppError ? err.code : ((err as { code?: string }).code ?? 'UNKNOWN')
    return { code, message: err instanceof Error ? err.message : String(err) }
  }
}
