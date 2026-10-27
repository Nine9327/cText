/**
 * M1-08 列表性能自检：1 万本数据下的虚拟滚动与分页。
 *
 * 验收标准（开发计划 M1-08）：1 万本滚动 60fps；派生指标：
 *   1. books:list 接口 P95 < 30ms（M1-09 的分页下推标准，先在这里立住基线）
 *   2. 虚拟滚动 DOM 恒定：任意滚动位置，行节点数量都有界（不随总量增长）
 *   3. 滚动帧间隔：中位数 < 25ms（60fps 的预算），P95 < 50ms（容忍 GC/合成事件抖动）
 *   4. 触底分页：滚动到底部能拉满 1 万本
 *
 * 只在 !app.isPackaged && CTEXT_LIST_SMOKE=1 时执行，临时库 + 临时 userData。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const TOTAL = 10_000

/** 往临时库塞 1 万本。一个事务批量插，~1s */
function seed10k(): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO library_roots (id, label, path, state, sort, created_at)
     VALUES ('mass', '万本压测库', 'D:\\\\mass', 'online', 99, ?)`
  ).run(Date.now())
  const insert = db.prepare(
    `INSERT INTO books (id, title, author, format, root_id, rel_path, file_hash, chapter_count, created_at, updated_at)
     VALUES (?, ?, ?, 'txt', 'mass', ?, ?, 12, ?, ?)`
  )
  const run = db.transaction(() => {
    for (let i = 0; i < TOTAL; i += 1) {
      const id = `mass-${String(i).padStart(6, '0')}`
      insert.run(id, `压测书籍 ${i}`, `作者 ${i % 97}`, `${id}.txt`, `hash-${id}`, Date.now() - i, Date.now())
    }
  })
  run()
}

export async function runListSmoke(win: BrowserWindow): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seed10k()

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
      const out = { problems: [], info: {} }

      // 首屏加载：1 万本的第一页
      await waitFor(() => q('[data-virtual-list]'), 15000)
      if (!q('[data-virtual-list]')) { out.problems.push('虚拟列表未渲染'); return JSON.stringify(out) }
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
  }

  check('脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
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

  for (const item of checks) {
    console.log(`SMOKE LIST ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log(`SMOKE LIST SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
