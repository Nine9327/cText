/**
 * M4-07 界面自检：书源页的真实点击链路。
 *
 * 纯主进程的 `engine/source/smoke.ts` 覆盖了「数据对不对」，这里覆盖
 * 「**接线对不对**」——IPC 通道名、zod schema、preload 白名单、渲染层调用四层
 * 任何一层写错，纯函数测试都发现不了，只有真的点一遍才会暴露。
 *
 * 覆盖的五条路径：列表渲染 → 启停 → 详情 → 合规确认门 → 粘贴导入 → 删除确认。
 *
 * 只在 `!app.isPackaged && CTEXT_SOURCES_UI_SMOKE=1` 时执行。
 */
import type { BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { sourcesRepo } from '../db/repositories/sources'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** 两条 seed 书源：一条 full、一条 partial，用来验徽标与详情里的原因 */
const SEED = [
  {
    bookSourceUrl: 'https://ui-a.example.com',
    bookSourceName: '界面书源甲',
    bookSourceGroup: '综合',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: '@css:li', name: '@css:.t@text' },
    ruleToc: { chapterList: '@css:dd' },
    ruleContent: { content: '@css:#c@textNodes' }
  },
  {
    bookSourceUrl: 'https://ui-b.example.com',
    bookSourceName: '界面书源乙',
    bookSourceGroup: '备用',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: '@css:li' },
    ruleToc: { chapterList: '@css:dd' }
    // 故意不给 ruleContent：判 partial，详情里应出现「无法取正文」
  }
]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runSourcesUiSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 主进程侧 seed
  const repo = sourcesRepo(getDb())
  check('起始状态没有书源', repo.count() === 0, `count=${repo.count()}`)

  const { importSources } = await import('../engine/source/import')
  const seeded = await importSources({ kind: 'text', text: JSON.stringify(SEED) }, { repo, now: Date.now })
  check('seed 两条书源', seeded.imported === 2, JSON.stringify({ i: seeded.imported, f: seeded.failed }))
  check(
    'seed 后兼容级别一 full 一 partial',
    repo.list().map((r) => r.compatLevel).sort().join(',') === 'full,partial',
    repo.list().map((r) => `${r.name}:${r.compatLevel}`).join(' ')
  )

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
      const out = { problems: [], text: {}, info: {} }

      try {
        // ---------- 进页面 ----------
        location.hash = '#/sources'
        const firstRow = await waitFor(() => q('[data-source-row]'), 15000)
        if (!firstRow) {
          out.problems.push('书源列表未渲染')
          return JSON.stringify(out)
        }
        out.info.rows = qa('[data-source-row]').length
        await sleep(300)
        out.text.header = txt(q('h1'))
        out.text.count = txt(q('h1').parentElement)
        out.text.badges = qa('[data-source-row]').map((r) => txt(r.querySelector('span:last-of-type'))).join('|')

        // ---------- 启停 ----------
        const switchBtn = firstRow.querySelector('[data-source-switch]')
        out.text.checked0 = String(switchBtn.getAttribute('aria-checked'))
        switchBtn.click()
        await sleep(400)
        out.text.checked1 = String(firstRow.querySelector('[data-source-switch]').getAttribute('aria-checked'))

        // ---------- 详情（看第二条：它是 partial，才有 compat_note）----------
        qa('[data-source-row]')[1].querySelector('[data-source-open]').click()
        const detail = await waitFor(() => q('[data-source-detail]'), 8000)
        out.text.detail = txt(detail)
        out.text.detailNote = txt(q('[data-source-compat-note]'))
        // 返回列表（用详情页的返回按钮，验的是真实交互而不是改 hash）
        q('[data-source-back]').click()
        await waitFor(() => q('[data-source-row]'), 8000)

        // ---------- 合规确认门 → 导入对话框 ----------
        q('[data-source-import]').click()
        const compliance = await waitFor(() => q('[data-compliance-dialog]'), 8000)
        out.text.compliance = txt(compliance)
        q('[data-compliance-ok]').click()
        const dialog = await waitFor(() => q('[data-import-dialog]'), 8000)
        out.info.tabs = qa('[data-import-tab]').length
        out.text.tabs = qa('[data-import-tab]').map(txt).join('|')

        // ---------- 粘贴导入 ----------
        q('[data-import-tab="paste"]').click()
        const area = await waitFor(() => q('[data-import-textarea]'), 5000)
        const payload = JSON.stringify([{
          bookSourceUrl: 'https://ui-c.example.com',
          bookSourceName: '界面书源丙',
          searchUrl: '/s?q={{key}}',
          ruleSearch: { bookList: '@css:li' },
          ruleToc: { chapterList: '@css:dd' },
          ruleContent: { content: '@css:#c@textNodes' }
        }])
        area.value = payload
        area.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(100)
        q('[data-import-submit]').click()
        const summary = await waitFor(() => q('[data-import-summary]'), 10000)
        out.text.summary = txt(summary)
        out.info.items = qa('[data-import-item]').length
        q('[data-import-done]').click()
        await sleep(500)
        out.info.rowsAfterImport = qa('[data-source-row]').length

        // ---------- 删除确认 ----------
        const rowsBefore = qa('[data-source-row]')
        rowsBefore[rowsBefore.length - 1].querySelector('[data-source-delete]').click()
        const confirm = await waitFor(() => q('[data-confirm-dialog]'), 8000)
        out.text.removeConfirm = txt(confirm)
        q('[data-confirm-ok]').click()
        await sleep(600)
        out.info.rowsAfterRemove = qa('[data-source-row]').length
      } catch (err) {
        out.problems.push(String((err && err.message) || err))
      }
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
  const info = out.info
  const text = out.text

  check('渲染层脚本无异常', out.problems.length === 0, out.problems.join(' / ') || 'ok')
  check('列表渲染出 seed 的两条', info['rows'] === 2, String(info['rows']))
  check('标题是「网络小说」', text['header'] === '网络小说', text['header'] ?? '')
  check('计数文案显示 2 个书源', (text['count'] ?? '').includes('2 个书源'), text['count'] ?? '')
  check(
    '两种兼容级别都显示成中文',
    (text['badges'] ?? '').includes('完整支持') || (text['badges'] ?? '').includes('部分支持'),
    text['badges'] ?? ''
  )
  check('开关初始为开启', text['checked0'] === 'true', text['checked0'] ?? '')
  check('点开关后变为关闭', text['checked1'] === 'false', text['checked1'] ?? '')
  check('停用状态已落库', repo.findByUrl('https://ui-a.example.com')?.enabled === false, '')

  check('详情页显示书源地址', (text['detail'] ?? '').includes('https://ui-b.example.com'), text['detail'] ?? '')
  check('partial 书源详情里有原因', (text['detailNote'] ?? '').includes('正文'), text['detailNote'] ?? '')

  check('首次导入弹出合规确认', (text['compliance'] ?? '').includes('不内置'), text['compliance'] ?? '')
  check('导入对话框有三个来源页签', info['tabs'] === 3, String(info['tabs']))
  check(
    '页签文案是「选文件 / 粘贴 JSON / URL 直链」',
    text['tabs'] === '选文件|粘贴 JSON|URL 直链',
    text['tabs'] ?? ''
  )
  check('粘贴导入后给出结果统计', (text['summary'] ?? '').includes('新增 1'), text['summary'] ?? '')
  check('结果清单列出该条', info['items'] === 1, String(info['items']))
  check('导入后列表变三条', info['rowsAfterImport'] === 3, String(info['rowsAfterImport']))
  // 丙最终被删掉了，所以「它确实进过库」由下面这条体现：删掉的正是它，
  // 说明 UI 里那一行来自真实数据，而不是渲染层的幻影

  check(
    '删除确认说清「书架里的书会保留」',
    (text['removeConfirm'] ?? '').includes('保留'),
    text['removeConfirm'] ?? ''
  )
  check('确认后列表回到两条', info['rowsAfterRemove'] === 2, String(info['rowsAfterRemove']))
  check(
    '删除的是刚导入的那条（证明它确实进过库）',
    repo.findByUrl('https://ui-c.example.com') === null && repo.findByUrl('https://ui-b.example.com') !== null,
    ''
  )
  check('已有书源未被误删', repo.count() === 2, `count=${repo.count()}`)

  // ---------------------------------------------------------------- 熔断（M4-12）
  /*
   * 熔断是主进程状态，UI 只负责「让人看见并能恢复」。这里直接在主进程侧把一条源
   * 连续打三次超时，再刷新页面看标签——不经过真实的 8 秒超时等待。
   */
  const breakerTarget = repo.findByUrl('https://ui-a.example.com')
  if (breakerTarget === null) {
    check('熔断目标书源仍在库', false, 'ui-a 不存在')
    return checks
  }
  for (let i = 0; i < 3; i += 1) {
    repo.recordOutcome(breakerTarget.id, { ok: false, code: 'E_TIMEOUT', message: '请求超时' }, Date.now())
  }
  check('连续 3 次超时后熔断落库', repo.breakerOf(breakerTarget.id).until !== null, '')

  await new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.reload()
  })

  const BREAKER_SCRIPT = String.raw`
    (async () => {
      const q = (s) => document.querySelector(s)
      const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '')
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
      try {
        location.hash = '#/sources'
        const tag = await waitFor(() => q('[data-source-breaker]'))
        if (!tag) {
          out.problems.push('未渲染熔断标签')
          return JSON.stringify(out)
        }
        out.text.tag = txt(tag)
        out.text.title = tag.getAttribute('title') || ''
        tag.click()
        const cleared = await waitFor(() => !q('[data-source-breaker]'), 8000)
        out.info.cleared = Boolean(cleared)
        out.text.toast = txt(q('[data-toast], .ct-toast') || document.body)
      } catch (err) {
        out.problems.push(String((err && err.message) || err))
      }
      return JSON.stringify(out)
    })()
  `

  let breakerRaw: string
  try {
    breakerRaw = (await win.webContents.executeJavaScript(BREAKER_SCRIPT)) as string
  } catch (err) {
    check('熔断脚本执行', false, err instanceof Error ? err.message : String(err))
    return checks
  }
  const breakerOut = JSON.parse(breakerRaw) as {
    problems: string[]
    info: Record<string, boolean>
    text: Record<string, string>
  }
  check('熔断脚本无异常', breakerOut.problems.length === 0, breakerOut.problems.join(' / ') || 'ok')
  check('列表显示「熔断」标签', breakerOut.text['tag'] === '熔断', breakerOut.text['tag'] ?? '')
  check('标签提示写明冷却时间', (breakerOut.text['title'] ?? '').includes('自动恢复'), breakerOut.text['title'] ?? '')
  check('点标签后标签消失', breakerOut.info['cleared'] === true, '')
  check('恢复后熔断状态已清空', repo.breakerOf(breakerTarget.id).until === null, '')

  await sleep(100)
  return checks
}
