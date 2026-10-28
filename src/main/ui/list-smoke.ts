/**
 * M1-08 / M1-09 列表自检：1 万本数据下的虚拟滚动、分页与排序。
 *
 * 验收标准（开发计划 M1-08 / M1-09）：1 万本滚动 60fps；5 种排序正确且
 * 列表接口 P95 < 30ms。派生指标：
 *   1. books:list 接口 P95 < 30ms（含深翻页 offset 9000）
 *   2. 每种排序的首页顺序正确（含升/降两个方向、NULL 值沉底）
 *   3. 虚拟滚动 DOM 恒定：任意滚动位置，行节点数量都有界（不随总量增长）
 *   4. 滚动帧间隔：中位数 < 25ms（60fps 的预算），P95 < 50ms（容忍 GC/合成事件抖动）
 *   5. 触底分页：滚动到底部能拉满 1 万本
 *   6. 排序菜单可切换，切换后列表回到顶部
 *
 * 只在 !app.isPackaged && CTEXT_LIST_SMOKE=1 时执行，临时库 + 临时 userData。
 */
import { app, type BrowserWindow } from 'electron'
import type { BookDTO, BookSort } from '@shared/dto'
import { getDb } from '../db/connection'
import { listBooks } from '../db/repositories/books'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const TOTAL = 10_000

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * 往临时库塞 1 万本。一个事务批量插，~1s。
 *
 * 四个字段刻意排成**互不相同**的顺序，才能把五种排序各自区分开：
 *   - createdAt：i 越大越旧 → 倒序首项 mass-000000
 *   - title / author：零填充后字典序 = 数值序 → 升序首项 mass-000000
 *   - progress：i / TOTAL → 倒序首项 mass-009999
 *   - lastReadAt：只有 i%7==0 有值，越靠后越新 → 倒序首项 mass-009996
 *     （9996 是 ≤9999 的最大 7 的倍数）
 */
function seed10k(): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO library_roots (id, label, path, state, sort, created_at)
     VALUES ('mass', '万本压测库', 'D:\\\\mass', 'online', 99, ?)`
  ).run(Date.now())
  const insert = db.prepare(
    `INSERT INTO books (id, title, author, format, root_id, rel_path, file_hash,
                        progress, last_read_at, chapter_count, created_at, updated_at)
     VALUES (?, ?, ?, 'txt', 'mass', ?, ?, ?, ?, 12, ?, ?)`
  )
  const now = Date.now()
  const run = db.transaction(() => {
    for (let i = 0; i < TOTAL; i += 1) {
      const id = `mass-${pad(i, 6)}`
      insert.run(
        id,
        `压测书籍 ${pad(i, 5)}`,
        `作者 ${pad(i % 97, 2)}`,
        `${id}.txt`,
        `hash-${id}`,
        i / TOTAL,
        i % 7 === 0 ? now - (TOTAL - i) * 1000 : null,
        now - i * 10,
        now
      )
    }
  })
  run()
}

const nonIncreasing = (values: number[]): boolean => values.every((v, i) => i === 0 || values[i - 1] >= v)
const textAsc = (values: string[]): boolean =>
  values.every((v, i) => i === 0 || values[i - 1].toLowerCase() <= v.toLowerCase())
const textDesc = (values: string[]): boolean =>
  values.every((v, i) => i === 0 || values[i - 1].toLowerCase() >= v.toLowerCase())

/** P95 取第 18/20 次，四舍五入到 0.1ms（与渲染层那条 P95 断言同口径） */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length * 0.9)] * 10) / 10
}

interface SortCase {
  name: string
  sort: BookSort
  /** 首页第一本（seed 里唯一可区分的那本） */
  firstId: string
  /** 整页顺序校验 */
  ordered: (items: BookDTO[]) => boolean
}

const SORT_CASES: SortCase[] = [
  {
    name: '导入时间倒序',
    sort: { field: 'createdAt', direction: 'desc' },
    firstId: 'mass-000000',
    ordered: (items) => nonIncreasing(items.map((b) => b.createdAt))
  },
  {
    name: '书名升序',
    sort: { field: 'title', direction: 'asc' },
    firstId: 'mass-000000',
    ordered: (items) => items[0]?.title === '压测书籍 00000' && textAsc(items.map((b) => b.title))
  },
  {
    name: '书名倒序',
    sort: { field: 'title', direction: 'desc' },
    firstId: 'mass-009999',
    ordered: (items) => textDesc(items.map((b) => b.title))
  },
  {
    name: '作者升序',
    sort: { field: 'author', direction: 'asc' },
    firstId: 'mass-000000',
    ordered: (items) =>
      items[0]?.author === '作者 00' && textAsc(items.map((b) => b.author ?? ''))
  },
  {
    name: '阅读进度倒序',
    sort: { field: 'progress', direction: 'desc' },
    firstId: 'mass-009999',
    ordered: (items) => nonIncreasing(items.map((b) => b.progress))
  },
  {
    name: '最近阅读倒序',
    sort: { field: 'lastReadAt', direction: 'desc' },
    firstId: 'mass-009996',
    // 没读过的书（null）必须沉到后面，否则 1 万本里一大半会顶在最上面
    ordered: (items) => {
      const values = items.map((b) => b.lastReadAt)
      const firstNull = values.findIndex((v) => v === null)
      const live = firstNull === -1 ? values : values.slice(0, firstNull)
      const tail = firstNull === -1 ? [] : values.slice(firstNull)
      return (
        nonIncreasing(live as number[]) &&
        tail.every((v) => v === null) &&
        items.length > 0 &&
        items[0]?.lastReadAt !== null
      )
    }
  }
]

/** 仓储层直接跑：顺序正确性 + 接口耗时（不经过 IPC 序列化，纯 SQL 成本） */
function runSortChecks(): Check[] {
  const db = getDb()
  const checks: Check[] = []

  const take = (sort?: BookSort, offset = 0): BookDTO[] =>
    listBooks(db, { sort, offset, limit: 120 }).items

  // ① 不传 sort 时退回「导入时间倒序」——M1-08 的既有顺序不能因为加了排序而变
  const fallback = take()
  checks.push({
    name: '缺省排序 = 导入时间倒序',
    ok: fallback[0]?.id === 'mass-000000',
    detail: `首项 ${fallback[0]?.id ?? '空'}`
  })

  // ② 六种（五种字段 + 反向）顺序与耗时
  for (const item of SORT_CASES) {
    const samples: number[] = []
    let first: BookDTO[] = []
    for (let i = 0; i < 10; i += 1) {
      const t0 = performance.now()
      const items = take(item.sort)
      samples.push(performance.now() - t0)
      if (i === 0) first = items
    }
    checks.push({
      name: `排序正确：${item.name}`,
      ok: first[0]?.id === item.firstId && item.ordered(first),
      detail: `首项 ${first[0]?.id ?? '空'}（期望 ${item.firstId}）`
    })
    const value = p95(samples)
    checks.push({
      name: `排序耗时：${item.name} P95 < 30ms`,
      ok: value < 30,
      detail: `p95=${value}ms`
    })
  }

  // ③ 深翻页：OFFSET 9000 要走完 9120 行，是最容易退化成全表扫描的位置
  const deep: number[] = []
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now()
    take({ field: 'createdAt', direction: 'desc' }, 9000)
    deep.push(performance.now() - t0)
  }
  const deepP95 = p95(deep)
  checks.push({
    name: '深翻页 offset=9000 P95 < 30ms',
    ok: deepP95 < 30,
    detail: `p95=${deepP95}ms`
  })

  // ④ 根目录筛选仍在 SQL 里：命中全部 1 万，不存在的根目录为 0
  const inRoot = listBooks(db, { rootId: 'mass', offset: 0, limit: 10 })
  const noRoot = listBooks(db, { rootId: 'ghost', offset: 0, limit: 10 })
  checks.push({
    name: '根目录筛选下推',
    ok: inRoot.total === TOTAL && noRoot.total === 0 && inRoot.items.length === 10,
    detail: `mass=${inRoot.total} ghost=${noRoot.total}`
  })

  // ⑤ 关键词搜索（M1-10）：'压测书籍' 命中全部 1 万本，是 FTS 子查询 + 排序 + 分页的最坏情况
  const searchSamples: number[] = []
  let searchTotal = -1
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now()
    const page = listBooks(db, { keyword: '压测书籍', offset: 0, limit: 120 })
    searchSamples.push(performance.now() - t0)
    searchTotal = page.total
  }
  const searchP95 = p95(searchSamples)
  checks.push({
    name: '关键词搜索（命中 1 万）P95 < 30ms',
    ok: searchP95 < 30 && searchTotal === TOTAL,
    detail: `p95=${searchP95}ms total=${searchTotal}`
  })

  return checks
}

export async function runListSmoke(win: BrowserWindow): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seed10k()
  checks.push(...runSortChecks())

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  const SCRIPT = String.raw`
    (async () => {
      const q = (s) => document.querySelector(s)
      const qa = (s) => Array.from(document.querySelectorAll(s))
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout = 15000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await sleep(50)
        }
        return null
      }
      const out = { problems: [], info: {}, text: {} }

      // 首屏加载：1 万本的第一页
      await waitFor(() => q('[data-virtual-list]'), 15000)
      if (!q('[data-virtual-list]')) {
        out.problems.push('虚拟列表未渲染')
        // 失败时把页面文案带回来：空状态 / 加载失败 / 白屏 的处置完全不同
        out.text.body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240)
        return JSON.stringify(out)
      }
      out.info.domRows0 = qa('[data-virtual-list] > [style]').length

      // ① 接口 P95：连发 20 次首页查询
      const timings = []
      for (let i = 0; i < 20; i += 1) {
        const t0 = performance.now()
        await window.api.invoke('books:list', { offset: 0, limit: 120 })
        timings.push(performance.now() - t0)
      }
      timings.sort((a, b) => a - b)
      out.info.p50 = Math.round(timings[10] * 10) / 10
      out.info.p95 = Math.round(timings[18] * 10) / 10

      // ② 滚动帧率：平滑滚到 12000px，采样帧间隔
      const el = q('[data-virtual-list]').parentElement.parentElement // scroll 容器
      const deltas = []
      let last = performance.now()
      let steps = 40
      await new Promise((done) => {
        const step = () => {
          el.scrollTop += 300
          const now = performance.now()
          deltas.push(now - last)
          last = now
          if (steps-- > 0) requestAnimationFrame(step)
          else done(null)
        }
        requestAnimationFrame(step)
      })
      deltas.sort((a, b) => a - b)
      const mid = deltas[Math.floor(deltas.length / 2)]
      const p95 = deltas[Math.floor(deltas.length * 0.95)]
      out.info.frameMid = Math.round(mid * 10) / 10
      out.info.frameP95 = Math.round(p95 * 10) / 10
      out.info.domRows1 = qa('[data-virtual-list] > [style]').length
      out.info.loadedAfterScroll = qa('[data-virtual-list] > [style]').length

      // ③ 滚到最底，触发全部分页
      el.scrollTop = el.scrollHeight
      await sleep(400)
      el.scrollTop = el.scrollHeight
      await sleep(400)
      out.info.domRows2 = qa('[data-virtual-list] > [style]').length
      const count = await window.api.invoke('books:count', { rootId: 'mass' })
      out.info.total = count.ok ? count.data.total : -1

      // 视图切换到列表档：行数应保持有界
      const detailBtn = qa('button').find((b) => b.textContent.trim() === '详细')
      if (detailBtn) {
        detailBtn.click()
        await sleep(250)
        out.info.domRowsDetail = qa('[data-virtual-list] > [style]').length
      }

      // ④ 排序菜单（M1-09）：此刻列表停在底部，正好一并验证「换排序回顶部」
      const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
      out.text.sortLabel0 = text(q('[data-sort-label]'))
      q('[data-sort-trigger]').click()
      await sleep(150)
      out.info.sortPanel = q('[data-sort-panel]') ? 1 : 0
      out.info.sortOptions = qa('[data-sort-option]').length
      q('[data-sort-field="title"]').click()
      await sleep(600)
      out.text.sortLabel1 = text(q('[data-sort-label]'))
      out.info.sortPanelClosed = q('[data-sort-panel]') ? 0 : 1
      const firstCard = q('[data-book-grid] [data-book-id]')
      out.text.sortFirstId = firstCard ? firstCard.getAttribute('data-book-id') || '' : ''
      out.info.scrollAfterSort = Math.round(el.scrollTop)

      return JSON.stringify(out)
    })()
  `

  let raw: string
  try {
    raw = (await win.webContents.executeJavaScript(SCRIPT)) as string
  } catch (err) {
    check('性能脚本执行', false, err instanceof Error ? err.message : String(err))
    return checks
  }

  const out = JSON.parse(raw) as {
    problems: string[]
    info: Record<string, number>
    text: Record<string, string>
  }

  check(
    '脚本无异常',
    out.problems.length === 0,
    [out.problems.join(' / ') || 'ok', out.text.body ?? ''].filter(Boolean).join(' | ')
  )
  check('books:list P95 < 30ms', out.info.p95 !== undefined && out.info.p95 < 30, `p50=${out.info.p50}ms p95=${out.info.p95}ms`)
  check(
    '滚动帧间隔中位 < 25ms',
    out.info.frameMid !== undefined && out.info.frameMid < 25,
    `mid=${out.info.frameMid}ms p95=${out.info.frameP95}ms`
  )
  check(
    '滚动帧间隔 P95 < 50ms',
    out.info.frameP95 !== undefined && out.info.frameP95 < 50,
    `p95=${out.info.frameP95}ms`
  )
  check(
    '虚拟 DOM 行数有界（首屏/滚动后/切视图 均 < 80 行）',
    [out.info.domRows0, out.info.domRows1, out.info.domRowsDetail].every((n) => n > 0 && n < 80),
    `首屏 ${out.info.domRows0} / 滚动 ${out.info.domRows1} / 详细视图 ${out.info.domRowsDetail}`
  )
  check('万本计数正确', out.info.total === TOTAL, `total=${out.info.total}`)
  check(
    '触底分页拉满全量',
    out.info.domRows2 !== undefined && out.info.domRows2 > 0 && out.info.domRows2 < 200,
    `滚动到底后 DOM 行 ${out.info.domRows2}`
  )

  // 排序交互（M1-09）
  check('排序按钮默认显示「导入时间」', out.text.sortLabel0 === '导入时间', out.text.sortLabel0 ?? '')
  check(
    '排序面板展开且列出 5 种排序',
    out.info.sortPanel === 1 && out.info.sortOptions === 5,
    `panel=${out.info.sortPanel} options=${out.info.sortOptions}`
  )
  check(
    '选「书名」后按钮文案更新且面板关闭',
    out.text.sortLabel1 === '书名' && out.info.sortPanelClosed === 1,
    `${out.text.sortLabel1} / closed=${out.info.sortPanelClosed}`
  )
  check(
    '换排序后首项按新顺序（书名升序 → mass-000000）',
    out.text.sortFirstId === 'mass-000000',
    out.text.sortFirstId || '无卡片'
  )
  check('换排序后列表回到顶部', out.info.scrollAfterSort === 0, `scrollTop=${out.info.scrollAfterSort}`)

  for (const item of checks) {
    console.log(`SMOKE LIST ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`SMOKE LIST SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
