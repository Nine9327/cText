/**
 * M1-01 自检：根目录登记 / 检测 / 掉线恢复 / 重定位 / 移除。
 *
 * 断言分两段：
 *   - **主进程侧**：建临时目录、删目录（模拟拔盘）、重建目录（模拟插回）
 *   - **渲染层侧**：通过 `window.api.invoke` 走完整 IPC 链路（契约 → zod → handler → 仓储），
 *     并订阅 `roots:changed` 收集事件
 *
 * 之所以把「拔盘」做成删目录：真拔 U 盘无法自动化，而 probePath 判定的正是
 * 「stat 能不能拿到且是目录」——删掉目录会让 stat 抛 ENOENT，与拔盘后的表现一致。
 *
 * 只在 `!app.isPackaged && CTEXT_ROOTS_SMOKE=1` 时由主进程调用。
 * 断言脚本必须用 `--user-data-dir=<临时目录>` 启动，否则会污染真实书库。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { getDb } from '../db/connection'
import { ulid } from '../utils/id'

interface SmokeItem {
  name: string
  ok: boolean
  detail?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 渲染层公共准备：结果收集器 + 事件订阅。只装一次 */
const SETUP = String.raw`
(() => {
  if (!window.__rootsOut) window.__rootsOut = []
  if (!window.__rootsEvents) window.__rootsEvents = []
  if (!window.__rootsReady) {
    window.api.on('roots:changed', (p) => window.__rootsEvents.push(p))
    window.__rootsReady = true
  }
  window.__push = (name, ok, detail) =>
    window.__rootsOut.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  return 'ok'
})()
`

/** 第一段：登记相关（含三类失败） */
const caseAdd = (dirA: string, dirAUpper: string, dirC: string, filePath: string, missing: string) =>
  String.raw`
(async () => {
  const push = window.__push
  const add = (p) => window.api.invoke('roots:add', { path: p, scanNow: false })

  const empty = await window.api.invoke('roots:list')
  push('初始根目录列表为空', empty.ok && Array.isArray(empty.data) && empty.data.length === 0,
    empty.ok ? '长度 ' + empty.data.length : empty.error.code)

  const a = await add(${JSON.stringify(dirA)})
  push('roots:add 成功', a.ok, a.ok ? 'id ' + a.data.id.slice(0, 8) : a.error.code)
  if (!a.ok) return 'abort'
  window.__rootAId = a.data.id
  push('新根目录状态为 online', a.data.state === 'online', a.data.state)
  push('显示名取目录名', a.data.label === ${JSON.stringify('smoke-root-a')}, a.data.label)
  push('书籍数初始为 0', a.data.bookCount === 0, String(a.data.bookCount))
  push('登记时尚未检测过', a.data.lastCheckAt === null, String(a.data.lastCheckAt))

  const dup = await add(${JSON.stringify(dirAUpper)})
  push('同目录大小写变体判为重复', !dup.ok && dup.error.code === 'E_CONFLICT',
    dup.ok ? '意外成功' : dup.error.code + ' ' + dup.error.message)

  const missing = await add(${JSON.stringify(missing)})
  push('不存在的目录被拒', !missing.ok && missing.error.code === 'E_NOT_FOUND',
    missing.ok ? '意外成功' : missing.error.code)

  const asFile = await add(${JSON.stringify(filePath)})
  push('路径指向文件而非目录时被拒', !asFile.ok && asFile.error.code === 'E_NOT_FOUND',
    asFile.ok ? '意外成功' : asFile.error.code)

  const blank = await add('')
  push('空路径被 zod 拒绝', !blank.ok && blank.error.code === 'E_INVALID_ARGUMENT',
    blank.ok ? '意外成功' : blank.error.code)

  const c = await add(${JSON.stringify(dirC)})
  push('第二个根目录登记成功', c.ok, c.ok ? 'label ' + c.data.label : c.error.code)
  window.__rootCId = c.ok ? c.data.id : ''

  const list = await window.api.invoke('roots:list')
  push('列表含两条记录', list.ok && list.data.length === 2, list.ok ? '长度 ' + list.data.length : list.error.code)
  push('sort 递增', list.ok && list.data[0].sort < list.data[1].sort,
    list.ok ? list.data.map((r) => r.sort).join(',') : '-')
  return 'ok'
})()
`

/** 第二段：掉线与恢复（删除目录后检测） */
const caseOffline = String.raw`
(async () => {
  const push = window.__push
  const before = window.__rootsEvents.length
  const r = await window.api.invoke('roots:check')
  if (!r.ok) { push('roots:check 成功', false, r.error.code); return 'abort' }
  push('roots:check 返回最新列表', r.ok && r.data.length === 2, '长度 ' + r.data.length)

  const a = r.data.find((x) => x.id === window.__rootAId)
  push('目录消失后状态变 offline', !!a && a.state === 'offline', a ? a.state : '未找到')
  push('离线记录保留书籍数', !!a && a.bookCount === 0, a ? String(a.bookCount) : '-')
  push('检测后写入 lastCheckAt', !!a && typeof a.lastCheckAt === 'number', a ? String(a.lastCheckAt) : '-')

  await new Promise((r2) => setTimeout(r2, 200))
  const events = window.__rootsEvents.slice(before)
  push('掉线广播 roots:changed', events.length === 1, '收到 ' + events.length + ' 条')
  const ev = events[0] || {}
  push('事件 rootId 正确', ev.rootId === window.__rootAId, String(ev.rootId).slice(0, 8))
  push('事件 state = offline', ev.state === 'offline', String(ev.state))
  return 'ok'
})()
`

/** 第三段：状态未变不重复广播 */
const caseStable = String.raw`
(async () => {
  const push = window.__push
  const before = window.__rootsEvents.length
  const r = await window.api.invoke('roots:check')
  await new Promise((r2) => setTimeout(r2, 200))
  const events = window.__rootsEvents.slice(before)
  push('状态未变时不广播', r.ok && events.length === 0, '收到 ' + events.length + ' 条')
  return 'ok'
})()
`

/** 第四段：恢复在线 */
const caseOnline = String.raw`
(async () => {
  const push = window.__push
  const before = window.__rootsEvents.length
  const r = await window.api.invoke('roots:check')
  if (!r.ok) { push('恢复后 roots:check 成功', false, r.error.code); return 'abort' }
  const a = r.data.find((x) => x.id === window.__rootAId)
  push('目录回来后恢复 online', !!a && a.state === 'online', a ? a.state : '未找到')

  await new Promise((r2) => setTimeout(r2, 200))
  const events = window.__rootsEvents.slice(before)
  push('恢复广播 roots:changed', events.length === 1, '收到 ' + events.length + ' 条')
  push('事件 state = online', events[0] && events[0].state === 'online', events[0] ? String(events[0].state) : '-')
  return 'ok'
})()
`

/** 第五段：重定位与移除 */
const caseRelocateRemove = (dirB: string, dirC: string, missing: string) =>
  String.raw`
(async () => {
  const push = window.__push
  const relocate = (rootId, newPath) => window.api.invoke('roots:relocate', { rootId, newPath })

  const moved = await relocate(window.__rootAId, ${JSON.stringify(dirB)})
  push('roots:relocate 成功', moved.ok, moved.ok ? 'matched ' + moved.data.matched : moved.error.code)
  push('空库重定位命中 0 缺 0', moved.ok && moved.data.matched === 0 && moved.data.missing === 0,
    moved.ok ? moved.data.matched + '/' + moved.data.missing : '-')

  const afterMove = await window.api.invoke('roots:list')
  const a = afterMove.ok ? afterMove.data.find((x) => x.id === window.__rootAId) : null
  push('重定位后 path 已更新', !!a && a.path.toLowerCase() === ${JSON.stringify(dirB)}.toLowerCase(),
    a ? a.path : '未找到')
  push('重定位后状态为 online', !!a && a.state === 'online', a ? a.state : '-')

  const occupied = await relocate(window.__rootAId, ${JSON.stringify(dirC)})
  push('重定位到已被占用的目录报 conflict', !occupied.ok && occupied.error.code === 'E_CONFLICT',
    occupied.ok ? '意外成功' : occupied.error.code)

  const toMissing = await relocate(window.__rootAId, ${JSON.stringify(missing)})
  push('重定位到不存在的目录被拒', !toMissing.ok && toMissing.error.code === 'E_NOT_FOUND',
    toMissing.ok ? '意外成功' : toMissing.error.code)

  const ghost = await relocate('NOPE', ${JSON.stringify(dirB)})
  push('重定位不存在的根目录报 notFound', !ghost.ok && ghost.error.code === 'E_NOT_FOUND',
    ghost.ok ? '意外成功' : ghost.error.code)

  const removed = await window.api.invoke('roots:remove', { rootId: window.__rootAId })
  push('roots:remove 成功', removed.ok, removed.ok ? 'ok' : removed.error.code)

  const afterRemove = await window.api.invoke('roots:list')
  push('移除后列表只剩一条', afterRemove.ok && afterRemove.data.length === 1,
    afterRemove.ok ? '长度 ' + afterRemove.data.length : afterRemove.error.code)
  const survivor = afterRemove.ok ? afterRemove.data[0] : null
  push('剩下的是另一个根目录', !!survivor && survivor.id === window.__rootCId,
    survivor ? survivor.label : '未找到')

  const ghostRemove = await window.api.invoke('roots:remove', { rootId: 'NOPE' })
  push('移除不存在的根目录报 notFound', !ghostRemove.ok && ghostRemove.error.code === 'E_NOT_FOUND',
    ghostRemove.ok ? '意外成功' : ghostRemove.error.code)
  return 'ok'
})()
`

/** 第六段：移除带书的根目录（不删书） */
const caseRemoveWithBooks = String.raw`
(async () => {
  const push = window.__push
  const removed = await window.api.invoke('roots:remove', { rootId: window.__rootCId })
  push('移除带书的根目录成功', removed.ok, removed.ok ? 'ok' : removed.error.code)

  const list = await window.api.invoke('roots:list')
  push('移除后根目录列表为空', list.ok && list.data.length === 0,
    list.ok ? '长度 ' + list.data.length : list.error.code)
  return 'ok'
})()
`

async function runScript(win: BrowserWindow, code: string): Promise<string> {
  const result = (await win.webContents.executeJavaScript(code)) as string | undefined
  return result ?? 'ok'
}

/**
 * 往临时库里塞一本书，挂到指定根目录上。
 * 只写最小必填列——目的是验证外键解绑，不是验证导入流程（那是 M1-06 的事）。
 */
function seedBook(rootId: string): string {
  const db = getDb()
  const id = ulid()
  const now = Date.now()
  db.prepare(
    `INSERT INTO books (id, title, format, root_id, rel_path, file_hash, size_bytes, source_type, created_at, updated_at)
     VALUES (?, ?, 'txt', ?, ?, ?, ?, 'local', ?, ?)`
  ).run(id, '冒烟测试书', rootId, 'smoke/book.txt', `smoke-${now}-${id.slice(-6)}`, 128, now, now)
  return id
}

export async function runRootsSmoke(win: BrowserWindow): Promise<number> {
  const results: SmokeItem[] = []
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

  const base = join(app.getPath('temp'), `ctext-roots-smoke-${Date.now()}`)
  const dirA = join(base, 'smoke-root-a')
  const dirAUpper = join(base, 'SMOKE-ROOT-A')
  const dirB = join(base, 'smoke-root-b')
  const dirC = join(base, 'smoke-root-c')
  const filePath = join(base, 'not-a-dir.txt')
  const missing = join(base, 'does-not-exist')

  try {
    for (const dir of [dirA, dirB, dirC]) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, 'x')

    // 等首个页面加载完成：window.api 由 preload 注入，渲染层脚本运行前必须就位
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) return resolve()
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', () => resolve())
    })
    await sleep(300)

    await runScript(win, SETUP)

    const phase1 = await runScript(win, caseAdd(dirA, dirAUpper, dirC, filePath, missing))
    if (phase1 === 'abort') {
      check('根目录登记阶段完成', false, 'add 失败，后续断言跳过')
    } else {
      // 删掉 A 目录 = 模拟拔盘
      rmSync(dirA, { recursive: true, force: true })
      await runScript(win, caseOffline)
      await runScript(win, caseStable)

      // 重建 A 目录 = 模拟插回
      mkdirSync(dirA, { recursive: true })
      await runScript(win, caseOnline)

      await runScript(win, caseRelocateRemove(dirB, dirC, missing))

      // 「移除根目录不删书」（产品文档 §2.3）：先挂一本书到 C，再移除 C
      const rootCId = (await win.webContents.executeJavaScript('window.__rootCId || ""')) as string
      if (!rootCId) {
        check('取到第二个根目录 id', false, '渲染层没有回传 __rootCId')
      } else {
        const bookId = seedBook(rootCId)
        await runScript(win, caseRemoveWithBooks)

        const row = getDb().prepare('SELECT id, root_id, deleted_at FROM books WHERE id = ?').get(bookId) as
          | { id: string; root_id: string | null; deleted_at: number | null }
          | undefined
        check('移除根目录后书籍仍在库中', !!row, row ? 'id ' + row.id.slice(0, 8) : '记录被删了')
        check('书籍未被软删除', row?.deleted_at === null, String(row?.deleted_at ?? 'missing'))
        check('书籍 root_id 已解绑为 NULL', row?.root_id === null, String(row?.root_id ?? 'missing'))
      }
    }

    // 把渲染层累积的断言搬回主进程
    const collected = (await win.webContents.executeJavaScript(
      'JSON.stringify(window.__rootsOut || [])'
    )) as string
    for (const item of JSON.parse(collected) as SmokeItem[]) {
      results.push(item)
    }
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`SMOKE ROOTS ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`)
  }
  console.log(`SMOKE ROOTS SUMMARY ${results.length - failed.length}/${results.length}`)

  return failed.length === 0 ? 0 : 1
}
