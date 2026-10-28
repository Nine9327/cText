/**
 * 设置读写自检（M2-07）。
 *
 * 只跑主进程：设置是「SQL + JSON 合并」的纯逻辑，不需要渲染层参与。
 * 重点验四类容易出错的地方：
 *   1. **默认值兜底**：旧版本写进去的行缺字段，读出来不能是 undefined；
 *   2. **合并语义**：patch 一个字段不能把同分区其它字段冲掉；
 *   3. **分区隔离**：改 general 不该动 reader 的 `updated_at`；
 *   4. **坏数据容错**：手工写坏一行 JSON 不能让整个设置读不出来。
 *
 * 只在 `!app.isPackaged && CTEXT_SETTINGS_SMOKE=1` 时执行（临时库）。
 */
import { app } from 'electron'
import { ipcSchemas } from '@shared/ipc/schemas'
import { getDb } from '../db/connection'
import { DEFAULT_SETTINGS, loadSettings, patchSettings, resetSettings } from '../db/repositories/settings'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

export function runSettingsSmoke(): void {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok: !!ok, detail })
    console.log(`SMOKE SETTINGS ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  }
  const db = getDb()
  const raw = (key: string): string | undefined =>
    (db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined)
      ?.value_json

  // 1. 默认值
  const fresh = loadSettings(db)
  check(
    '首次读取给出完整默认值',
    fresh.reader.fontSize === 18 && fresh.reader.mode === 'auto' && fresh.general.closeAction === 'quit',
    `fontSize=${fresh.reader.fontSize} mode=${fresh.reader.mode} closeAction=${fresh.general.closeAction}`
  )
  check('默认值不会被写进库（读不该产生副作用）', raw('reader') === undefined, raw('reader') ?? '无行')

  // 2. 单字段 patch 不冲掉同分区其它字段
  const patched = patchSettings(db, { reader: { fontSize: 22 } })
  check(
    'patch 一个字段，其余字段保持默认',
    patched.reader.fontSize === 22 &&
      patched.reader.lineHeight === DEFAULT_SETTINGS.reader.lineHeight &&
      patched.reader.theme === 'day',
    `fontSize=${patched.reader.fontSize} lineHeight=${patched.reader.lineHeight}`
  )

  const stored = JSON.parse(raw('reader') ?? '{}') as Record<string, unknown>
  check('落库的是「合并后的整分区」', stored['fontSize'] === 22 && stored['lineHeight'] === 1.9, JSON.stringify(stored))

  // 3. 跨读取一致（同一个库再读一次，不依赖内存缓存）
  const reread = loadSettings(db)
  check('重读与写入结果一致', reread.reader.fontSize === 22, `${reread.reader.fontSize}px`)

  // 4. 分区隔离 + updated_at 只动被 patch 的分区
  const beforeGeneral = db.prepare("SELECT updated_at FROM settings WHERE key = 'general'").get() as
    | { updated_at: number }
    | undefined
  const later = Date.now() + 5000
  patchSettings(db, { general: { closeAction: 'tray' } }, later)
  const afterGeneral = db.prepare("SELECT updated_at FROM settings WHERE key = 'general'").get() as
    | { updated_at: number }
    | undefined
  const readerRow = db.prepare("SELECT updated_at FROM settings WHERE key = 'reader'").get() as
    | { updated_at: number }
    | undefined
  check(
    '分区隔离：改 general 不动 reader 的时间戳',
    afterGeneral?.updated_at === later && readerRow?.updated_at !== later && beforeGeneral === undefined,
    `general=${afterGeneral?.updated_at} reader=${readerRow?.updated_at}`
  )
  check(
    '分区隔离：改 general 不动 reader 的值',
    loadSettings(db).reader.fontSize === 22 && loadSettings(db).general.closeAction === 'tray',
    'reader 22 / general tray'
  )

  // 5. shortcuts 是合并而不是覆盖
  patchSettings(db, { shortcuts: { 'reader.next': 'ArrowRight' } })
  patchSettings(db, { shortcuts: { 'reader.toc': 'Ctrl+T' } })
  const keys = Object.keys(loadSettings(db).shortcuts).sort()
  check('shortcuts 逐键合并', keys.join(',') === 'reader.next,reader.toc', keys.join(','))

  // 6. 缺字段的旧行：其余字段回落到默认值
  db.prepare("UPDATE settings SET value_json = ? WHERE key = 'reader'").run(JSON.stringify({ fontSize: 26 }))
  const legacy = loadSettings(db)
  check(
    '旧行缺字段时回落到默认值',
    legacy.reader.fontSize === 26 && legacy.reader.margin === DEFAULT_SETTINGS.reader.margin,
    `fontSize=${legacy.reader.fontSize} margin=${legacy.reader.margin}`
  )

  // 7. 坏 JSON 不炸
  db.prepare("UPDATE settings SET value_json = '{oops' WHERE key = 'storage'").run()
  let brokenOk = true
  let brokenValue = ''
  try {
    brokenValue = JSON.stringify(loadSettings(db).storage)
  } catch (err) {
    brokenOk = false
    brokenValue = err instanceof Error ? err.message : String(err)
  }
  check(
    '坏 JSON 的行被忽略而不是让整个设置读不出来',
    brokenOk && brokenValue.includes('coverCacheLimitMb'),
    brokenValue
  )

  // 8. 入参校验（schema 是 IPC 的守门人，这里直接验它）
  const accept = ipcSchemas['settings:patch'].safeParse({ patch: { reader: { fontSize: 24 } } })
  const rejectRange = ipcSchemas['settings:patch'].safeParse({ patch: { reader: { fontSize: 99 } } })
  const rejectUnknown = ipcSchemas['settings:patch'].safeParse({ patch: { reader: { fontSizeX: 20 } } })
  const rejectColor = ipcSchemas['settings:patch'].safeParse({ patch: { reader: { customBg: 'red' } } })
  const rejectSection = ipcSchemas['settings:patch'].safeParse({ patch: { readerr: { fontSize: 20 } } })
  check(
    'schema 接受合法 patch',
    accept.success,
    accept.success ? 'ok' : JSON.stringify(accept.error.issues[0])
  )
  check(
    'schema 拒绝越界字号 / 未知字段 / 非法颜色 / 错分区名',
    !rejectRange.success && !rejectUnknown.success && !rejectColor.success && !rejectSection.success,
    `range=${rejectRange.success} key=${rejectUnknown.success} color=${rejectColor.success} section=${rejectSection.success}`
  )

  // 9. 自定义色是合法值（#rrggbb）
  const colorOk = ipcSchemas['settings:patch'].safeParse({
    patch: { reader: { customBg: '#102030', customText: '#eeeeee' } }
  })
  check('schema 接受 #rrggbb 自定义色', colorOk.success, colorOk.success ? '#102030' : '被误拒')

  // 10. 恢复默认
  const reset = resetSettings(db)
  check(
    '恢复默认：值回到出厂设置',
    reset.reader.fontSize === 18 && reset.reader.mode === 'auto' && reset.general.closeAction === 'quit',
    `${reset.reader.fontSize}px / ${reset.reader.mode}`
  )

  const failed = checks.filter((item) => !item.ok).length
  console.log(`SMOKE SETTINGS SUMMARY ${checks.length - failed}/${checks.length}`)
  app.exit(failed === 0 ? 0 : 1)
}
