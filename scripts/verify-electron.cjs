/**
 * M0-00 环境自检（Electron 侧）。
 * 验证 better-sqlite3 的 N-API 二进制在 Electron 32 运行时内可加载，
 * 并确认 WAL / foreign_keys PRAGMA 可用（M0-03 建库前提）。
 *
 * 用法：pnpm check:env:electron
 */
const { app } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const results = []
const record = (name, ok, detail) => {
  results.push({ ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

app.whenReady().then(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ctext-probe-'))
  try {
    record('Electron 运行时', true, `electron ${process.versions.electron} / node ${process.versions.node}`)

    const Database = require('better-sqlite3')
    const db = new Database(join(dir, 'probe.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    const journal = db.pragma('journal_mode', { simple: true })
    const fk = db.pragma('foreign_keys', { simple: true })
    const ver = db.prepare('select sqlite_version() as v').get().v

    record('better-sqlite3 在 Electron 内加载', true, `sqlite ${ver}`)
    record('WAL 模式', String(journal).toLowerCase() === 'wal', String(journal))
    record('foreign_keys', Number(fk) === 1, String(fk))

    db.close()
  } catch (err) {
    record('better-sqlite3 在 Electron 内加载', false, err && err.message ? err.message : String(err))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — ${results.length - failed}/${results.length}`)
  // Electron 在 Windows 下 app.exit()/process.exit() 的退出码不可靠（实测返回 127 / 0xC0000409），
  // 退出码由 launcher 解析本行输出来决定。
  app.quit()
})
