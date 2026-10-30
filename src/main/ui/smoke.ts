/**
 * M0-08 自检：在**真实渲染层**里点侧栏的五个入口，验证路由、选中态、过滤与折叠。
 *
 * 为什么不用截图像素比对：M0-08 的验收是「五个入口可切换，选中态与设计稿一致」，
 * 前者是行为（点击 → 路由 → 高亮唯一），后者是样式类（`.ct-nav-*-active`）。
 * 两者都能用 DOM 精确断言，比截图稳，也不会因为字体渲染差异误报。
 *
 * 只在 `!app.isPackaged && CTEXT_UI_SMOKE=1` 时由主进程调用。
 * 断言脚本要求**干净的 userData**（localStorage 里的折叠状态会影响结果），
 * 所以 verify-ui.mjs 每次都用 `--user-data-dir=<临时目录>` 启动。
 */
import { app, type BrowserWindow } from 'electron'

interface SmokeItem {
  name: string
  ok: boolean
  detail?: string
}

const UI_CASES = String.raw`
(async () => {
  const out = []
  const push = (name, ok, detail) => out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => Array.from(document.querySelectorAll(sel))
  const txt = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim()

  const waitFor = async (fn, timeout = 6000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = fn()
      if (value) return value
      await sleep(50)
    }
    return null
  }

  // 侧栏选中态的三种形态：展开态 nav / 折叠态 rail / 分区首页标题
  const ACTIVE = '.ct-nav-item-active, .ct-rail-item-active, .ct-section-active'
  // 折叠态图标栏里没有文字，只能读 aria-label / title
  const nameOf = (el) => txt(el) || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  const actives = () => qa(ACTIVE).map(nameOf)
  const route = () => location.hash.replace(/^#/, '')
  const click = async (sel) => {
    const el = q(sel)
    if (!el) throw new Error('未找到元素 ' + sel)
    el.click()
    // 路由切换 + Vue 重渲染 + 120ms 宽度过渡，220ms 够用且留了余量
    await sleep(220)
  }

  /** 每个入口切换后都检查一次：有且只有一个选中项，且文案对得上 */
  const checkActive = (label) => {
    const list = actives()
    push(
      '选中态唯一：' + label,
      list.length === 1 && list[0].includes(label),
      list.length === 0 ? '无选中项' : list.join(' / ')
    )
  }

  const checkRoute = (expected) => push('路由 = ' + expected, route() === expected, route())
  const visible = (el) => !!el && el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })

  try {
    const sidebar = await waitFor(() => q('[data-sidebar]'))
    if (!sidebar) {
      push('侧栏已渲染', false, '6s 内没有 [data-sidebar]')
      return JSON.stringify(out)
    }

    // ---------------------------------------------------------------- 1. 结构
    push('侧栏已渲染且默认展开', sidebar.getAttribute('data-collapsed') === '0' && sidebar.offsetWidth === 240, sidebar.offsetWidth + 'px')

    const entries = [
      ['书库切换器', '[data-library-switcher]'],
      ['全部书籍', '[data-nav="library"]'],
      ['收藏的书籍', '[data-nav="favorites"]'],
      ['我的书架', '[data-nav="shelves"]'],
      ['网络小说', '[data-nav="sources"]'],
      ['设置', '[data-nav="settings"]']
    ]
    const missing = entries.filter(([, sel]) => !q(sel)).map(([name]) => name)
    push('入口齐全（已实现的五个）', missing.length === 0, missing.length ? '缺少 ' + missing.join('、') : '书库切换器 + 5 个入口')
    // 书源清单不是侧栏入口，只有进到网络小说页才会渲染
    push('网络小说清单不在侧栏', !q('[data-source-item]'), 'data-source-item 不应出现在外壳')

    // M1-08 起列表是异步加载（IPC → SQL），计数要等到数据到位而不是元素出现
    const waitForCount = (expected) =>
      waitFor(() => route().startsWith('/library') || route().startsWith('/favorites') || route().startsWith('/shelves')
        ? (txt(q('[data-book-count]')) === expected ? expected : null)
        : null, 6000)
    await waitFor(() => route() === '/library' && waitForCount0())
    function waitForCount0() { return txt(q('[data-book-count]')) !== '0 本' && !!q('[data-book-count]') }
    await waitForCount('16 本')
    checkRoute('/library')
    checkActive('全部书籍')
    push('首屏书库计数 16', txt(q('[data-book-count]')) === '16 本', txt(q('[data-book-count]')))

    // ---------------------------------------------------------------- 2. 收藏
    await click('[data-nav="favorites"]')
    checkRoute('/favorites')
    checkActive('收藏的书籍')
    push('收藏页标题正确', txt(q('[data-page-title]')) === '收藏的书籍', txt(q('[data-page-title]')))
    push('收藏计数 5', (await waitForCount('5 本')) === '5 本', txt(q('[data-book-count]')))
    // 侧栏「全部书籍」计数挂的是独立的全量 count，不能跟着当前域变成 5
    push(
      '切到收藏页后侧栏全部书籍仍为 16',
      (await waitFor(() => txt(q('[data-nav-count]')) === '16', 6000)) === true,
      txt(q('[data-nav-count]'))
    )

    // ---------------------------------------------------------------- 3. 我的书架
    await click('[data-nav="shelves"]')
    checkRoute('/shelves')
    checkActive('我的书架')
    // 颜色有 120ms 过渡，直接读会拿到中间插值（表现为偶发失败）。
    // 等它收敛到终点色再断言，语义不变：**最终**要提亮到正文色
    const sectionColor = await waitFor(() => {
      const el = q('.ct-section-active')
      if (!el) return null
      const color = getComputedStyle(el).color
      return color === 'rgb(231, 233, 236)' ? color : null
    }, 2000)
    push(
      '分区首页选中态提亮到正文色',
      sectionColor === 'rgb(231, 233, 236)',
      sectionColor || '未收敛到正文色（可能没有 .ct-section-active）'
    )
    push('书架总览渲染 2 个书架', qa('[data-shelf-card]').length === 2, qa('[data-shelf-card]').length + ' 个')

    await click('[data-shelf-item]')
    checkRoute('/shelves/s1')
    checkActive('睡前读物')
    push('书架页标题是书架名', txt(q('[data-page-title]')) === '睡前读物', txt(q('[data-page-title]')))
    push('书架内含 4 本', (await waitForCount('4 本')) === '4 本', txt(q('[data-book-count]')))

    // ---------------------------------------------------------------- 4. 书库切换器
    await click('[data-nav="library"]')
    await click('[data-library-switcher]')
    push('切换器面板展开', !!q('[data-root-panel]'))
    push('面板列出 3 个根目录', qa('[data-root-option]').length === 3, qa('[data-root-option]').length + ' 个')

    await click('[data-root-id="r2"]')
    push('面板选择后自动关闭', !q('[data-root-panel]'))
    push('切换器显示新根目录', txt(q('[data-root-label]')) === '移动硬盘', txt(q('[data-root-label]')))
    push('切到离线目录后列表只剩 4 本', (await waitForCount('4 本')) === '4 本', txt(q('[data-book-count]')))
    push('离线根目录出现离线横幅', !!q('[data-offline-hint]'), txt(q('[data-offline-hint]')).slice(0, 40))
    push('离线目录里最近阅读整段隐藏', !q('[data-recent]'))
    push('收藏计数随根目录收敛为 1', (await waitFor(() => txt(q('[data-fav-count]')) === '1', 6000)) === true, txt(q('[data-fav-count]')))

    await click('[data-library-switcher]')
    await click('[data-root-id="all"]')
    push('切回全部书库后横幅消失', !q('[data-offline-hint]'))
    push('切回后恢复 16 本', (await waitForCount('16 本')) === '16 本', txt(q('[data-book-count]')))
    push('切回后最近阅读回来', !!q('[data-recent]'))

    /*
     * 行间距回归（本轮修的 bug）。
     *
     * 虚拟列表每一行都是绝对定位的独立容器，grid 的 rowGap 只在一行内部生效，
     * 行与行之间的空隙完全由「rowHeight = 内容高 + rowGap」提供。旧写法
     * 「measured ?? estimated + rowGap」一旦实测到行高就把行距丢掉了，表现为
     * 第二行封面压在上一行的「已读 x%」上。这里直接量两行的 translateY 差值。
     */
    const rowGapNow = () => {
      const rows = qa('[data-virtual-row]')
      if (rows.length < 2) return null
      const y = (el) => {
        const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform || '')
        return m ? Number(m[1]) : null
      }
      const y0 = y(rows[0])
      const y1 = y(rows[1])
      const h = rows[0].firstElementChild ? rows[0].firstElementChild.offsetHeight : 0
      return y0 === null || y1 === null || h === 0 ? null : Math.round(y1 - y0 - h)
    }
    const gapGrid = rowGapNow()
    push('封面视图行间留出间距（24px）', gapGrid === 24, 'gap=' + gapGrid)

    const viewBtn = (label) => qa('button').find((el) => txt(el) === label)
    const detailBtn = viewBtn('详细')
    if (detailBtn) detailBtn.click()
    await sleep(250)
    const gapDetail = rowGapNow()
    push('详细视图行间留出间距（12px）', gapDetail === 12, 'gap=' + gapDetail)
    const gridBtn = viewBtn('封面')
    if (gridBtn) gridBtn.click()
    await sleep(250)

    // 最近阅读卡片必须能点开（曾漏绑定 click，卡片看着可点、点了没反应）。
    // 只在路由层断言：阅读器内容渲染由 verify:reader 覆盖，这里要验的是「点了有去处」。
    const recentEl = q('[data-recent-item]')
    recentEl.click()
    const enteredReader = await waitFor(() => route().startsWith('/reader/'), 6000)
    push('点最近阅读能进阅读器', enteredReader === true, route())
    // 阅读器是全屏布局，侧栏不存在，回列表只能走路由（也是用户按 Esc 退出后的路径）
    location.hash = '#/library'
    push('从阅读器回到书库列表', (await waitForCount('16 本')) === '16 本', txt(q('[data-book-count]')))

    // ---------------------------------------------------------------- 5.5 排序（M1-09）
    // fixture 的 16 本书里：书名升序首项 = 万历十五年（U+4E07 才是最小码点，
    // 别按「三体」的直觉猜——三体的 U+4E09 比它大）、
    // 作者升序首项 = 深入理解计算机系统（作者是 ASCII，排在所有中文之前）、
    // 导入时间倒序首项 = 乡土中国（b16 的 created_at 最新）
    const firstBookId = () => {
      const el = q('[data-book-grid] [data-book-id]')
      return el ? el.getAttribute('data-book-id') : ''
    }
    const sortBy = async (field) => {
      await click('[data-sort-trigger]')
      await click('[data-sort-field="' + field + '"]')
      await sleep(120)
    }
    push('排序按钮默认「导入时间」', txt(q('[data-sort-label]')) === '导入时间', txt(q('[data-sort-label]')))
    await click('[data-sort-trigger]')
    push('排序面板列出 5 种排序', qa('[data-sort-option]').length === 5, qa('[data-sort-option]').length + ' 项')

    await click('[data-sort-field="title"]')
    push('选「书名」后面板关闭', !q('[data-sort-panel]'))
    push('排序文案更新为书名', txt(q('[data-sort-label]')) === '书名', txt(q('[data-sort-label]')))
    push(
      '书名升序首项是「万历十五年」',
      (await waitFor(() => (firstBookId() === 'b11' ? 'b11' : null), 6000)) === 'b11',
      firstBookId()
    )

    await sortBy('author')
    push(
      '作者升序首项是「深入理解计算机系统」',
      (await waitFor(() => (firstBookId() === 'b13' ? 'b13' : null), 6000)) === 'b13',
      firstBookId()
    )

    await sortBy('createdAt')
    push(
      '切回导入时间后首项是最新导入的「乡土中国」',
      (await waitFor(() => (firstBookId() === 'b16' ? 'b16' : null), 6000)) === 'b16',
      firstBookId()
    )

    // ---------------------------------------------------------------- 6. 分区折叠
    const shelfBody = () => q('[data-section="shelves"] [data-section-body]')
    await click('[data-section-toggle="shelves"]')
    push('折叠我的书架后子项不可见', !visible(shelfBody()), visible(shelfBody()) ? '仍可见' : '已折叠')
    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem('ctext.ui.v1') || '{}')
      } catch {
        return {}
      }
    })()
    push('折叠状态写入 localStorage', saved.sections && saved.sections.shelves === false, JSON.stringify(saved.sections || null))
    await click('[data-section-toggle="shelves"]')
    push('再次点击恢复展开', visible(shelfBody()))

    // ---------------------------------------------------------------- 7. 侧栏折叠
    await click('[data-sidebar-toggle]')
    const rail = q('[data-sidebar]')
    push('折叠后宽度 64px', rail && rail.getAttribute('data-collapsed') === '1' && rail.offsetWidth === 64, (rail ? rail.offsetWidth : 0) + 'px')
    push(
      '折叠态五个入口仍在',
      ['library', 'favorites', 'shelves', 'sources', 'settings'].every((key) => !!q('[data-nav="' + key + '"]'))
    )
    push('折叠态设置入口可读', (q('[data-nav="settings"]')?.getAttribute('aria-label') ?? '') === '设置')
    await click('[data-nav="favorites"]')
    checkRoute('/favorites')
    checkActive('收藏的书籍')
    await click('[data-sidebar-toggle]')
    push('展开后宽度恢复 240px', q('[data-sidebar]') && q('[data-sidebar]').offsetWidth === 240, (q('[data-sidebar]') ? q('[data-sidebar]').offsetWidth : 0) + 'px')

    // ---------------------------------------------------------------- 8. 空页面与未实现提示
    location.hash = '#/shelves/not-exist'
    await sleep(300)
    push('失效书架 id 显示空状态', !!q('[data-empty]') && txt(q('[data-empty-title]')) === '书架不存在', txt(q('[data-empty-title]')))

    // M3-02 起「新建书架」是真功能了（M0-08 时它只弹一句「将在 M3-02 提供」），
    // 这里改验它真的打开命名对话框，并确认取消能收回去
    location.hash = '#/shelves'
    await sleep(300)
    await click('[data-shelf-create]')
    const dialog = await waitFor(() => q('[data-shelf-dialog]'), 2000)
    push('新建书架打开命名对话框', !!dialog, dialog ? txt(q('[data-shelf-dialog-title]')) : '未出现对话框')
    if (dialog) {
      await click('[data-shelf-dialog-cancel]')
      await sleep(150)
      push('取消后对话框关闭', !q('[data-shelf-dialog]'))
    }
  } catch (err) {
    push('自检脚本执行', false, err && err.message ? err.message : String(err))
  }

  return JSON.stringify(out)
})()
`

export async function runUiSmoke(win: BrowserWindow): Promise<void> {
  // 关掉后台节流：自检窗口一旦被别的窗口遮住，Chromium 会把 rAF/定时器降到
  // 每秒一两次，所有「点击后等一帧」的断言都会随机超时（同一份代码时好时坏）。
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })

  let items: SmokeItem[] = []
  try {
    const raw = (await win.webContents.executeJavaScript(UI_CASES)) as string
    items = JSON.parse(raw) as SmokeItem[]
  } catch (err) {
    items = [{ name: '自检脚本执行', ok: false, detail: err instanceof Error ? err.message : String(err) }]
  }

  for (const item of items) {
    console.log(`SMOKE UI ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = items.filter((item) => !item.ok).length
  console.log(`SMOKE UI SUMMARY ${items.length - failed}/${items.length}`)

  win.destroy()
  app.exit(failed === 0 && items.length > 0 ? 0 : 1)
}
