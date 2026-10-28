/**
 * M1-10 搜索自检：FTS5 索引一致性 + 前缀命中口径 + 渲染层 200ms 防抖。
 *
 * 分两段：
 *   A. 主进程直查仓储（seedUiFixture 的 16 本书）——前缀命中、AND 组合、
 *      FTS 语法字符不致崩、更新/软删除后索引同步。
 *   B. 渲染层真实输入——逐字符打字只发一次请求、结果计数与离线角标、
 *      无结果空态、清除后回到全量。
 *
 * 只在 !app.isPackaged && CTEXT_SEARCH_SMOKE=1 时执行（临时库 + 临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { listBooks } from '../db/repositories/books'
import { keywordCalls } from '../ipc/books'
import { seedUiFixture } from './ui-fixture'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

function search(keyword: string): { ids: string[]; total: number } {
  const page = listBooks(getDb(), { keyword, offset: 0, limit: 50 })
  return { ids: page.items.map((book) => book.id), total: page.total }
}

/** A. 仓储层断言（不经过 UI，先把「检索口径」钉死） */
function runQueryChecks(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  check('空关键字 = 全量', search('').total === 16, `${search('').total} 本`)

  const title = search('三体')
  check('中文书名前缀命中', title.ids.join(',') === 'b08', title.ids.join(',') || '无结果')

  const author = search('刘慈欣')
  check('中文作者前缀命中', author.ids.join(',') === 'b08', author.ids.join(',') || '无结果')

  // 「置身事内：中国政府与经济发展」被标点切成两个 token，第二段同样能吃前缀
  const secondToken = search('中国')
  check('标点分段后的第二段可命中', secondToken.ids.join(',') === 'b01', secondToken.ids.join(',') || '无结果')

  // unicode61 不做分词，「经济」落在 token 中间 → 本版不命中（口径见 toFtsQuery 注释）
  const middle = search('经济')
  check('中间词不命中（unicode61 口径）', middle.total === 0, `${middle.total} 本`)

  const multi = search('三体 刘慈欣')
  check('多词 AND 可跨字段组合', multi.ids.join(',') === 'b08', multi.ids.join(',') || '无结果')

  // 用户可能打错引号/星号；这些字符在 FTS5 里是语法，不处理会让整条 SQL 报错
  const dirty = ['"三体', '*', 'a AND b', '-三体', 'title:三体', '  ', ':::']
  let crash = ''
  for (const raw of dirty) {
    try {
      search(raw)
    } catch (err) {
      crash = `${raw} → ${err instanceof Error ? err.message : String(err)}`
      break
    }
  }
  check('FTS 语法字符不导致查询报错', crash === '', crash || `${dirty.length} 种输入全部安全`)

  // 索引与 books 表一致：每本书用自己的标题前两个字都能找回自己
  const db = getDb()
  const rows = db.prepare('SELECT id, title FROM books WHERE deleted_at IS NULL').all() as {
    id: string
    title: string
  }[]
  const missed = rows.filter((row) => !search(row.title.slice(0, 2)).ids.includes(row.id)).map((row) => row.id)
  check('索引覆盖全部书籍（标题前两字可自命中）', missed.length === 0, missed.length ? `漏 ${missed.join(',')}` : `${rows.length} 本`)

  // 更新标题 → 触发器同步；旧词不再命中，新词命中。
  // 新标题必须**换掉前缀**：换成「沙丘之子」这类仍以「沙丘」开头的名字，
  // 前缀查询照样命中，「索引是否更新」就验不出来了。
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run('银河帝国：基地', 'b15')
  const oldWord = search('沙丘').ids
  const newWord = search('银河').ids
  check(
    '更新标题后索引同步',
    !oldWord.includes('b15') && newWord.includes('b15') && oldWord.length === 0,
    `旧词=${oldWord.join(',') || '无'} 新词=${newWord.join(',') || '无'}`
  )
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run('沙丘', 'b15')

  // 软删除 → 记录仍在 FTS 里，但列表必须过滤掉（这是 books 表过滤而不是索引删除）
  db.prepare('UPDATE books SET deleted_at = ? WHERE id = ?').run(Date.now(), 'b14')
  const gone = search('活着')
  check('软删除的书不出现在搜索结果里', gone.total === 0, `${gone.total} 本`)
  db.prepare('UPDATE books SET deleted_at = NULL WHERE id = ?').run('b14')
  check('恢复软删除后可再次搜到', search('活着').ids.join(',') === 'b14', search('活着').ids.join(',') || '无结果')

  return checks
}

export async function runSearchSmoke(win: BrowserWindow): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  seedUiFixture(getDb())
  checks.push(...runQueryChecks())

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
      const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
      const waitFor = async (fn, timeout = 8000) => {
        const end = Date.now() + timeout
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await sleep(50)
        }
        return null
      }
      const out = { problems: [], info: {}, text: {} }

      // 返回「最后一次 input 事件」的时刻。必须在 dispatch 之后立刻取，
      // 不能等循环结束——循环末尾还有一次 sleep，会把基准时间往后推 60ms，
      // 于是防抖窗口被测成 140ms 而误判失败。
      const type = async (value, step = 60) => {
        const el = q('[data-search-input]')
        if (!el) return 0
        el.focus()
        let sent = ''
        let lastAt = Date.now()
        for (const ch of value) {
          sent += ch
          el.value = sent
          el.dispatchEvent(new Event('input', { bubbles: true }))
          lastAt = Date.now()
          await sleep(step)
        }
        return lastAt
      }

      await waitFor(() => q('[data-search-input]'), 15000)
      if (!q('[data-search-input]')) {
        out.problems.push('搜索框未渲染')
        return JSON.stringify(out)
      }
      await waitFor(() => txt(q('[data-book-count]')) === '16 本', 10000)
      out.text.count0 = txt(q('[data-book-count]'))

      // ① 防抖：逐字符打「万历」，只应发一次请求
      out.info.lastInputAt = await type('万历')
      await waitFor(() => txt(q('[data-book-count]')) === '1 本', 6000)
      out.text.count1 = txt(q('[data-book-count]'))
      out.text.firstId = (q('[data-book-grid] [data-book-id]') || { getAttribute: () => '' }).getAttribute('data-book-id')
      const card = out.text.firstId ? q('[data-book-id="' + out.text.firstId + '"]') : null
      out.text.cardText = txt(card)
      out.text.recentHidden = q('[data-recent]') ? '1' : '0'

      // ② 无结果：空态要明确说「没找到」而不是「书库是空的」
      await type('zzz', 40)
      await waitFor(() => !!q('[data-empty]'), 6000)
      out.text.emptyTitle = txt(q('[data-empty-title]'))
      out.info.count2 = qa('[data-book-grid] [data-book-id]').length

      // ③ 清除：输入框与列表都回到全量
      const clearBtn = q('[data-search-reset]') || q('[data-search-clear]')
      if (clearBtn) clearBtn.click()
      await waitFor(() => txt(q('[data-book-count]')) === '16 本', 6000)
      out.text.count3 = txt(q('[data-book-count]'))
      out.text.inputAfterClear = (q('[data-search-input]') || { value: '?' }).value

      return JSON.stringify(out)
    })()
  `

  let raw: string
  try {
    raw = (await win.webContents.executeJavaScript(SCRIPT)) as string
  } catch (err) {
    check('渲染层脚本执行', false, err instanceof Error ? err.message : String(err))
    return checks
  }

  const out = JSON.parse(raw) as {
    problems: string[]
    info: Record<string, number>
    text: Record<string, string>
  }

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check('首屏全量 16 本', out.text.count0 === '16 本', out.text.count0 ?? '')
  check('搜索「万历」命中 1 本', out.text.count1 === '1 本', out.text.count1 ?? '')
  check('搜索结果是离线根目录里的那本', out.text.firstId === 'b11', out.text.firstId || '无卡片')
  check('离线结果带「离线」标注', (out.text.cardText ?? '').includes('离线'), out.text.cardText ?? '')
  check('搜索时隐藏「最近阅读」', out.text.recentHidden === '0', `recent=${out.text.recentHidden}`)
  check(
    '无结果时给出「没有找到匹配的书籍」',
    (out.text.emptyTitle ?? '').includes('没有找到匹配') && out.info.count2 === 0,
    `${out.text.emptyTitle ?? ''} / 卡片 ${out.info.count2}`
  )
  check('清除搜索后回到 16 本', out.text.count3 === '16 本', out.text.count3 ?? '')
  check('清除后输入框已空', out.text.inputAfterClear === '', out.text.inputAfterClear ?? '')

  // 防抖：两次关键字（'万历'、'zzz'）各只发一次请求，且首条落在最后一次输入之后 ≥200ms
  const wl = keywordCalls.filter((call) => call.keyword === '万历')
  const zzz = keywordCalls.filter((call) => call.keyword === 'zzz')
  check(
    '逐字符输入只发一次请求（防抖）',
    wl.length === 1 && zzz.length === 1,
    `万历=${wl.length} 次 / zzz=${zzz.length} 次 / 共 ${keywordCalls.length} 次`
  )
  const delay = wl.length === 0 ? -1 : wl[0]!.at - (out.info.lastInputAt ?? 0)
  check('请求落在 200ms 防抖窗口之后', delay >= 190 && delay < 1500, `${delay}ms`)

  for (const item of checks) {
    console.log(`SMOKE SEARCH ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE SEARCH SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
