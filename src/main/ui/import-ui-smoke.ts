/**
 * M1-07 导入交互自检。
 *
 * 跑在**真实窗口**里：真 DOM、真 Pinia store、真 IPC、真 SQLite（临时 userData）。
 * 与 M1-06 的 `import-smoke.ts` 分工明确——那边验主进程队列的正确性，
 * 这边验「用户能不能把这件事做成」：拖放 → 预览分类 → 导入 → 结果 → 重复导入不脏。
 *
 * 拖放用 CDP 的 `Input.dispatchDragEvent` 派发，**不是**合成 DOM 事件。
 * 合成事件拿不到真实磁盘路径（`webUtils.getPathForFile` 会抛），
 * 那样测出来的只是我们自己的回调，等于没测拖放。
 *
 * 只在 `!app.isPackaged && CTEXT_IMPORT_UI_SMOKE=1` 时执行。
 * 目录由 `scripts/verify-import-ui.mjs` 建好并通过 `CTEXT_IMPORT_UI_DIR` /
 * `CTEXT_IMPORT_UI_CANCEL_DIR` 传进来。
 */
import { app, type BrowserWindow } from 'electron'

export interface ImportUiSmokeContext {
  /** 小目录：5 本正常书 + 1 空文件 + 1 坏 EPUB + 1 不支持的 PDF */
  booksDir: string
  /** 大目录：60 本，用于取消场景 */
  cancelDir: string
}

interface SmokeItem {
  name: string
  ok: boolean
  detail: string
}

/**
 * 每段注入脚本都带上这几个助手，省得重复写。
 *
 * 注意它们**整体包在一个 async IIFE 里**：`executeJavaScript` 只能求值一个表达式，
 * 顶层写 `const` 会直接抛「Script failed to execute」。
 */
const PRELUDE = String.raw`
  const q = (s) => document.querySelector(s)
  const qa = (s) => Array.from(document.querySelectorAll(s))
  const txt = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim()
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
  const click = async (sel) => {
    const el = q(sel)
    if (!el) throw new Error('未找到元素 ' + sel)
    el.click()
    await sleep(120)
  }
`

function run(win: BrowserWindow, body: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`(async () => {\n${PRELUDE}\n${body}\n})()`)
}

export async function runImportUiSmoke(win: BrowserWindow, ctx: ImportUiSmokeContext): Promise<number> {
  const items: SmokeItem[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    items.push({ name, ok: !!ok, detail })
  }

  const waitLoaded = new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once('did-finish-load', () => resolve())
    win.webContents.once('did-fail-load', () => resolve())
  })
  await waitLoaded

  const dbg = win.webContents.debugger
  let dragReady = false
  try {
    dbg.attach('1.3')
    dragReady = true
  } catch (err) {
    check('附加调试器以派发真实拖放', false, err instanceof Error ? err.message : String(err))
  }

  /**
   * 派发一次真实拖放事件。data 里的 files 是**磁盘路径列表**。
   *
   * CDP 只有 dragEnter / dragOver / drop / dragCancel 四种；没有 dragLeave，
   * 「拖出窗口」用 dragCancel 表达（渲染层收到的同样是 dragleave）。
   */
  const drag = async (type: 'dragEnter' | 'dragOver' | 'dragCancel' | 'drop', data: unknown): Promise<void> => {
    if (!dragReady) return
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type,
      x: 420,
      y: 320,
      data
    } as never)
    await new Promise((r) => setTimeout(r, 150))
  }

  const dirData = (files: string[]) => ({
    items: [],
    files,
    dragOperationsMask: 1
  })

  try {
    // ---------------------------------------------------------------- 1. 拖放高亮
    await run(win, `await waitFor(() => q('[data-sidebar]'))`)

    await drag('dragEnter', dirData([ctx.booksDir]))
    const shown = await run(win, `return !!q('[data-drop-overlay]')`)
    check('拖入文件夹时全窗高亮', shown === true, String(shown))

    // 「拖出窗口」由浏览器派发 dragleave；CDP 没有这个类型（只有 dragCancel，
    // 且它不落到渲染层），所以这里直接派发该事件验证处理分支。
    // dragleave 不带 dataTransfer，正好顺带验证「不能因为读不到数据就退出不了高亮」。
    const hidden = await run(win, `
      window.dispatchEvent(new Event('dragleave'))
      await sleep(150)
      return !!q('[data-drop-overlay]')
    `)
    check('拖出窗口后高亮消失', hidden === false, String(hidden))

    // 拖一段纯文本不该触发导入高亮
    await drag('dragEnter', { items: [{ mimeType: 'text/plain', data: 'hello' }], dragOperationsMask: 1 })
    const noFiles = await run(win, `return !!q('[data-drop-overlay]')`)
    check('拖入非文件不高亮', noFiles === false, String(noFiles))
    await run(win, `
      window.dispatchEvent(new Event('dragleave'))
      await sleep(100)
      return null
    `)

    // ---------------------------------------------------------------- 2. 放下 → 打开面板
    await drag('dragEnter', dirData([ctx.booksDir]))
    await drag('dragOver', dirData([ctx.booksDir]))
    await drag('drop', dirData([ctx.booksDir]))

    const opened = (await run(win, `
      await waitFor(() => q('[data-import-dialog]'), 5000)
      const el = q('[data-import-dialog]')
      const input = q('[data-import-path]')
      // input 的路径在 value 上，不在 textContent 里
      return el ? { stage: el.getAttribute('data-stage'), path: input ? input.value : '' } : null
    `)) as { stage: string; path: string } | null

    check('放下文件夹后打开导入面板', !!opened, opened ? opened.stage : '面板未出现')
    check('面板带入拖入的路径', !!opened && opened.path === ctx.booksDir, opened?.path ?? '')

    // ---------------------------------------------------------------- 3. 预览分类
    await run(win, `await click('[data-import-scan]')`)
    const stats = (await run(win, `
      await waitFor(() => q('[data-import-stats]') && q('[data-import-dialog]').getAttribute('data-stage') === 'preview', 20000)
      const read = (key) => { const el = q('[data-stat="' + key + '"]'); return el ? txt(el) : '' }
      const err = q('[data-import-error]')
      return {
        stage: q('[data-import-dialog]').getAttribute('data-stage'),
        new: read('new'), dup: read('duplicate'), unsup: read('unsupported'), empty: read('empty'),
        error: err ? txt(err) : ''
      }
    `)) as { stage: string; new: string; dup: string; unsup: string; empty: string; error: string } | null

    check('扫描后进入预览阶段', stats?.stage === 'preview', `${stats?.stage ?? '未进入'} ${stats?.error ?? ''}`.trim())
    // 6 = 5 本正常书 + 1 本坏 EPUB。预览只算指纹不做解析，
    // 所以坏 EPUB 在预览里是「新增」，直到导入阶段才落到失败清单——这是对的
    check('预览统计：新增 6（含 1 本坏 EPUB）', stats?.new === '新增 6', stats?.new ?? '')
    check('预览统计：已存在 0', stats?.dup === '已存在 0', stats?.dup ?? '')
    check('预览统计：不支持 1', stats?.unsup === '不支持 1', stats?.unsup ?? '')
    check('预览统计：跳过 1（空文件）', stats?.empty === '跳过 1', stats?.empty ?? '')

    // 分类页签：切到「不支持」只剩 1 行，且那条确实是 PDF
    const unsupportedRow = (await run(win, `
      const tabs = qa('button').filter((b) => txt(b) === '不支持')
      if (tabs.length) tabs[0].click()
      await sleep(200)
      const rows = qa('[data-import-row]')
      return { count: rows.length, status: rows.length ? rows[0].getAttribute('data-row-status') : null, text: rows.length ? txt(rows[0]) : '' }
    `)) as { count: number; status: string | null; text: string }

    check('「不支持」页签剩 1 条', unsupportedRow.count === 1, String(unsupportedRow.count))
    check('不支持的那条是 PDF', /\.pdf/i.test(unsupportedRow.text), unsupportedRow.text.slice(0, 60))

    // 空文件必须落在「跳过」而不是「不支持」——两者原因不同，混在一起会误导
    const skippedRow = (await run(win, `
      const tabs = qa('button').filter((b) => txt(b) === '跳过')
      if (tabs.length) tabs[0].click()
      await sleep(200)
      const rows = qa('[data-import-row]')
      return { count: rows.length, text: rows.length ? txt(rows[0]) : '' }
    `)) as { count: number; text: string }
    check('「跳过」页签只有空文件', skippedRow.count === 1 && /空文件\.txt/.test(skippedRow.text), skippedRow.text.slice(0, 40))
    await run(win, `
      const tabs = qa('button').filter((b) => txt(b) === '全部')
      if (tabs.length) tabs[0].click()
      await sleep(150)
      return null
    `)

    // ---------------------------------------------------------------- 4. 导入
    await run(win, `await click('[data-import-start]')`)
    const result = (await run(win, `
      await waitFor(() => q('[data-import-result]'), 40000)
      const read = (key) => { const el = q('[data-result="' + key + '"]'); return el ? Number(txt(el)) : -1 }
      return {
        stage: q('[data-import-dialog]').getAttribute('data-stage'),
        imported: read('imported'), updated: read('updated'), skipped: read('skipped'), failed: read('failed'),
        failures: qa('[data-import-failure]').map((el) => txt(el))
      }
    `)) as {
      stage: string
      imported: number
      updated: number
      skipped: number
      failed: number
      failures: string[]
    } | null

    check('导入完成后进入结果阶段', result?.stage === 'result', result?.stage ?? '未进入')
    check('结果统计：新增 5', result?.imported === 5, String(result?.imported))
    check('结果统计：跳过 1（空文件）', result?.skipped === 1, String(result?.skipped))
    check('结果统计：失败 1（坏 EPUB）', result?.failed === 1, String(result?.failed))
    check('坏书不影响其余导入', (result?.imported ?? 0) === 5, `imported=${result?.imported}`)
    check('失败清单列出 1 条', (result?.failures?.length ?? 0) === 1, String(result?.failures?.length))
    check(
      '失败清单给出可复制的相对路径',
      /坏书\.epub/.test(result?.failures?.[0] ?? ''),
      (result?.failures?.[0] ?? '').slice(0, 60)
    )

    // ---------------------------------------------------------------- 5. 重复导入不产生脏数据
    // 结果页没有「重新扫描」，要先「再导一个」回到选目录（路径保留），再扫一次
    await run(win, `
      await click('[data-import-again]')
      await waitFor(() => q('[data-import-dialog]').getAttribute('data-stage') === 'pick', 5000)
      await click('[data-import-scan]')
    `)
    const again = (await run(win, `
      await waitFor(() => q('[data-import-stats]') && q('[data-import-dialog]').getAttribute('data-stage') === 'preview', 20000)
      const read = (key) => { const el = q('[data-stat="' + key + '"]'); return el ? txt(el) : '' }
      return { new: read('new'), dup: read('duplicate') }
    `)) as { new: string; dup: string } | null

    check('再次扫描：新增降到 1', again?.new === '新增 1', again?.new ?? '')
    check('再次扫描：5 本已存在', again?.dup === '已存在 5', again?.dup ?? '')
    // 剩下那 1 本是上次导入失败的坏 EPUB——它没进库，所以仍是「新增」，
    // 开始导入保持可用，用户才能重试。这正是想要的：失败项可重试，成功项不重复。
    const startDisabled = await run(win, `return q('[data-import-start]').disabled`)
    check('仍有失败项可重试时「开始导入」可用', startDisabled === false, String(startDisabled))

    // ---------------------------------------------------------------- 6. 取消
    await run(win, `
      q('[data-import-close]').click()
      await sleep(200)
    `)
    await drag('dragEnter', dirData([ctx.cancelDir]))
    await drag('drop', dirData([ctx.cancelDir]))
    await run(win, `await click('[data-import-scan]')`)
    await run(win, `
      await waitFor(() => q('[data-import-dialog]').getAttribute('data-stage') === 'preview', 20000)
      await click('[data-import-start]')
    `)

    const midRun = (await run(win, `
      await waitFor(() => q('[data-import-progress]'), 15000)
      const done = q('[data-import-result]')
      return { running: !!q('[data-import-progress]'), finished: !!done, bar: q('[data-import-bar]') ? q('[data-import-bar]').style.width : '' }
    `)) as { running: boolean; finished: boolean; bar: string }
    check('导入中显示进度面板', midRun.running === true, String(midRun.running))
    check('进度面板有进度条', /%$/.test(midRun.bar), midRun.bar)

    await run(win, `await click('[data-import-cancel]')`)
    const cancelled = (await run(win, `
      await waitFor(() => q('[data-import-result]'), 20000)
      return { stage: q('[data-import-dialog]').getAttribute('data-stage'), text: txt(q('[data-import-result]')) }
    `)) as { stage: string; text: string } | null
    check('取消后进入结果阶段', cancelled?.stage === 'result', cancelled?.stage ?? '未进入')
    check('结果面板说明已取消', /已取消导入/.test(cancelled?.text ?? ''), (cancelled?.text ?? '').slice(0, 40))

    // ---------------------------------------------------------------- 7. 收尾
    await run(win, `await click('[data-import-finish]')`)
    const closed = await run(win, `await sleep(200); return !!q('[data-import-dialog]')`)
    check('点完成后面板关闭', closed === false, String(closed))
  } catch (err) {
    check('自检脚本执行', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (dragReady) {
      try {
        dbg.detach()
      } catch {
        // 已断开
      }
    }
  }

  for (const item of items) {
    console.log(`SMOKE IMPORTUI ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  }
  const failed = items.filter((item) => !item.ok).length
  console.log(`SMOKE IMPORTUI SUMMARY ${items.length - failed}/${items.length}`)

  win.destroy()
  app.exit(failed === 0 && items.length > 0 ? 0 : 1)
  return failed
}
