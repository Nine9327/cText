/**
 * M5-01 设置页 UI 自检。
 *
 * 只验「界面 ↔ 主进程」的对齐：点一下开关，库里的值必须变；拖一下字号，
 * `settings.reader` 必须跟着变；恢复默认之后，三组值都要回到出厂设置。
 *
 * 不验像素：设置页的正确性几乎全是**状态同步**问题（界面显示了但没存上、
 * 存上了但界面没刷新），这些都能用「读库 + 读 DOM 文案」判定。
 * 唯一的例外是开关圆点的几何位置：它是纯 CSS 结果，状态怎么点都对，
 * 但圆点可能整个落在轨道外面（`left` 省略时绝对定位取居中静态位置导致），
 * 只能量 boundingBox。
 *
 * 只在 !app.isPackaged && CTEXT_SETTINGS_UI_SMOKE=1 时执行（临时 userData）。
 */
import { app, type BrowserWindow } from 'electron'
import { loadSettings } from '../db/repositories/settings'
import { getDb } from '../db/connection'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const SCRIPT = String.raw`
(async () => {
  const out = { problems: [], info: {}, text: {} }
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => Array.from(document.querySelectorAll(sel))
  const txt = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = fn()
      if (value) return value
      await sleep(50)
    }
    return null
  }
  const ipc = async (channel, input) => {
    const result = await window.api.invoke(channel, input)
    return result.ok ? result.data : null
  }

  try {
    location.hash = '#/settings'
    if (!(await waitFor(() => q('[data-settings-page]')))) {
      out.problems.push('设置页未渲染')
      return JSON.stringify(out)
    }
    await sleep(300)

    out.text.title = txt(q('[data-settings-title]'))
    out.info.navCount = qa('[data-settings-nav]').length
    out.text.navs = qa('[data-settings-nav]').map(txt).join('|')

    // 分组导航的文字必须贴在图标后面。按钮的 UA 样式是 text-align:center，
    // 而标签是 flex-1 撑满的 span，短标签会被居中，和图标之间空出一截。
    {
      const span = q('[data-settings-nav="reading"] span')
      if (span) {
        const range = document.createRange()
        range.selectNodeContents(span)
        out.info.navTextOffset = Math.round(
          range.getBoundingClientRect().left - span.getBoundingClientRect().left
        )
      }
    }

    // ---------------------------------------------------------------- 常规
    const minTray = q('[data-settings-minimize-tray]')
    out.info.minBefore = minTray.getAttribute('aria-checked')
    minTray.click()
    await sleep(300)
    out.info.minAfter = q('[data-settings-minimize-tray]').getAttribute('aria-checked')
    const afterMin = await ipc('settings:get')
    out.info.storedMinTray = afterMin ? afterMin.general.minimizeToTray : null

    // 开关圆点位置：M5-01 的开关里圆点是绝对定位的，只写 top 不写 left
    // 时起点取「按钮内容居中」的静态位置，再叠加 translate 会把圆点整个推到轨道外。
    // 这类问题状态断言看不出来，只能量几何：圆点必须整颗落在轨道内、且开关两态各贴一侧。
    out.info.knobs = qa('[data-settings-toggle]').map((btn) => {
      const br = btn.getBoundingClientRect()
      const th = btn.firstElementChild.getBoundingClientRect()
      return {
        on: btn.getAttribute('aria-checked') === 'true',
        width: Math.round(br.width),
        left: Math.round(th.left - br.left),
        right: Math.round(th.right - br.left)
      }
    })

    out.text.closeAction = txt(q('[data-settings-close-action]'))
    // 关窗行为改成托盘：主进程要据此建托盘（临时环境里图标可能不可用，
    // 这里只断言按钮状态，托盘是否存在由日志决定，不作为失败条件）
    const trayBtn = q('[data-close-action="tray"]')
    trayBtn.click()
    await sleep(300)
    const afterClose = await ipc('settings:get')
    out.info.storedCloseAction = afterClose ? afterClose.general.closeAction : null

    // ---------------------------------------------------------------- 阅读
    q('[data-settings-nav="reading"]').click()
    const range = await waitFor(() => q('[data-settings-range="fontSize"]'))
    if (!range) {
      out.problems.push('阅读组字号滑杆未渲染')
    } else {
      range.value = '24'
      range.dispatchEvent(new Event('input', { bubbles: true }))
      // reader store 的落库是 300ms 节流，多等一点
      await sleep(600)
      const afterFont = await ipc('settings:get')
      out.info.storedFontSize = afterFont ? afterFont.reader.fontSize : null
      out.text.fontLabel = txt(range.parentElement)
    }

    // ---------------------------------------------------------------- 快捷键
    q('[data-settings-nav="shortcuts"]').click()
    if (await waitFor(() => q('[data-settings-shortcut]'))) {
      out.info.shortcutCount = qa('[data-settings-shortcut]').length
      const record = q('[data-shortcut-record]')
      record.click()
      await sleep(150)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      await sleep(400)
      out.text.firstShortcut = txt(q('[data-shortcut-record]'))
      const afterKey = await ipc('settings:get')
      out.info.storedShortcut = afterKey ? (afterKey.shortcuts['reader.next'] || null) : null
    } else {
      out.problems.push('快捷键行未渲染')
    }

    // ---------------------------------------------------------------- 存储
    q('[data-settings-nav="storage"]').click()
    if (await waitFor(() => q('[data-settings-clear-covers]'))) {
      await sleep(500)
      out.text.storage = txt(q('[data-settings-group="storage"]'))
    } else {
      out.problems.push('存储组未渲染')
    }

    // ---------------------------------------------------------------- 关于
    q('[data-settings-nav="about"]').click()
    if (await waitFor(() => q('[data-settings-version]'), 12000)) {
      out.text.version = txt(q('[data-settings-version]'))
    } else {
      out.problems.push('关于组版本号未渲染')
    }

    // ---------------------------------------------------------------- 恢复默认
    q('[data-settings-reset]').click()
    if (!(await waitFor(() => q('[data-confirm-dialog]')))) {
      out.problems.push('恢复默认的确认框未出现')
    } else {
      out.text.resetDesc = txt(q('[data-confirm-dialog]'))
      q('[data-confirm-ok]').click()
      await sleep(900)
      const afterReset = await ipc('settings:get')
      out.info.afterReset = afterReset
        ? {
            fontSize: afterReset.reader.fontSize,
            minimizeToTray: afterReset.general.minimizeToTray,
            closeAction: afterReset.general.closeAction,
            shortcut: afterReset.shortcuts['reader.next'] || null
          }
        : null
    }
  } catch (err) {
    out.problems.push(String((err && err.message) || err))
  }
  return JSON.stringify(out)
})()
`

export async function runSettingsUiSmoke(win: BrowserWindow): Promise<Check[]> {
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  let payload: {
    problems: string[]
    info: Record<string, unknown>
    text: Record<string, string>
  }
  try {
    const raw = (await win.webContents.executeJavaScript(SCRIPT)) as string
    payload = JSON.parse(raw) as typeof payload
  } catch (err) {
    checks.push({
      name: '设置页脚本执行',
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    })
    return finish(checks, win)
  }

  const info = payload.info
  const text = payload.text

  check('设置页脚本无异常', payload.problems.length === 0, payload.problems.join(' / ') || 'ok')

  type Knob = { on: boolean; width: number; left: number; right: number }
  const knobs = (info['knobs'] ?? []) as Knob[]
  const knobDetail = knobs.map((k) => `${k.on ? '开' : '关'} ${k.left}–${k.right}/${k.width}`).join(' · ')
  check(
    '开关圆点不越出轨道',
    knobs.length >= 2 && knobs.every((k) => k.left >= 1 && k.right <= k.width - 1),
    knobDetail || '未找到开关'
  )
  const offKnob = knobs.find((k) => !k.on)
  const onKnob = knobs.find((k) => k.on)
  check(
    '开关关态贴左、开态贴右',
    offKnob !== undefined && onKnob !== undefined && offKnob.left <= 3 && onKnob.width - onKnob.right <= 3,
    knobDetail || '未找到开关'
  )
  check('进入设置页默认「常规」', text['title'] === '常规', text['title'] ?? '')
  check('七组导航齐全', info['navCount'] === 7, `${info['navCount'] ?? 0} 组`)
  check(
    '分组名称与顺序正确',
    (text['navs'] ?? '') === '常规|阅读|书库目录|网络书源|存储|快捷键|关于',
    text['navs'] ?? ''
  )
  check(
    '分组导航文字紧跟图标左对齐',
    typeof info['navTextOffset'] === 'number' && Math.abs(info['navTextOffset']) <= 1,
    `文字相对标签框左移 ${String(info['navTextOffset'] ?? 'null')}px`
  )

  check('最小化到托盘：界面先关后开', info['minBefore'] === 'false' && info['minAfter'] === 'true', `${info['minBefore']} → ${info['minAfter']}`)
  check('最小化到托盘已落库', info['storedMinTray'] === true, String(info['storedMinTray']))
  check('关窗行为可切到托盘并落库', info['storedCloseAction'] === 'tray', String(info['storedCloseAction']))
  check('关窗行为选项文案正确', (text['closeAction'] ?? '').includes('退出应用') && (text['closeAction'] ?? '').includes('最小化到托盘'), text['closeAction'] ?? '')

  check('字号拖动后落库 24px', info['storedFontSize'] === 24, `${info['storedFontSize']}px`)
  check('字号数值同步显示', (text['fontLabel'] ?? '').includes('24px'), text['fontLabel'] ?? '')

  check('快捷键行数 = 动作数（12）', info['shortcutCount'] === 12, `${info['shortcutCount'] ?? 0} 行`)
  check('录制 Ctrl+K 后写入库', info['storedShortcut'] === 'Ctrl+K', String(info['storedShortcut']))
  check('录制结果显示为「Ctrl + K」', (text['firstShortcut'] ?? '') === 'Ctrl + K', text['firstShortcut'] ?? '')

  check(
    '存储组显示两个缓存的用量',
    (text['storage'] ?? '').includes('个文件') && (text['storage'] ?? '').includes('张'),
    (text['storage'] ?? '').slice(0, 120)
  )

  check(
    '关于组显示当前版本',
    (text['version'] ?? '') === `v${app.getVersion()}`,
    `${text['version'] ?? ''} / 期望 v${app.getVersion()}`
  )

  check('恢复默认前有确认文案', (text['resetDesc'] ?? '').includes('恢复全部默认设置'), text['resetDesc'] ?? '')
  const after = info['afterReset'] as
    | { fontSize: number; minimizeToTray: boolean; closeAction: string; shortcut: string | null }
    | null
  check(
    '恢复默认后库回到出厂值',
    after !== null && after.fontSize === 18 && after.minimizeToTray === false && after.closeAction === 'quit',
    after === null ? 'null' : `${after.fontSize}px / tray=${after.minimizeToTray} / close=${after.closeAction}`
  )
  check('恢复默认会清空自定义键位', after !== null && after.shortcut === null, String(after?.shortcut ?? 'null'))

  // 主进程侧兜底：库里的值必须与界面最后一次提交一致
  const stored = loadSettings(getDb())
  check(
    '落库最终状态与界面一致',
    stored.reader.fontSize === 18 && stored.general.closeAction === 'quit',
    `${stored.reader.fontSize}px / ${stored.general.closeAction}`
  )

  return finish(checks, win)
}

function finish(checks: Check[], win: BrowserWindow): Check[] {
  for (const item of checks) {
    console.log(`SMOKE SETTINGS-UI ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE SETTINGS-UI SUMMARY ${checks.length - failed}/${checks.length}`)
  win.destroy()
  app.exit(failed === 0 ? 0 : 1)
  return checks
}
