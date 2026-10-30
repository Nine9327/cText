/**
 * 书源 IPC（M4-07 / M4-08 / M4-09 / M4-10）。
 *
 * 十五个通道：导入 / 列表 / 启停 / 删除 / 排序 / 导出 / 选文件 / 搜索 / 加入书架 /
 * 刷新目录 / 缓存用量 / 清理缓存 / 打开缓存目录 / 规则调试 / 解除熔断。
 *
 * 三条职责边界：
 *   1. **导入结果原样返回，不抛**。批量导入 100 条里有 3 条坏数据是常态，
 *      抛异常会让 UI 只看到一个错误码，用户不知道是哪 3 条、为什么。
 *      只有「整批连文本都拿不到」（文件不存在 / URL 被拒 / JSON 根本不是 JSON）才抛。
 *   2. **导出写的是 `rule_json` 原文**。不重新拼装字段——用户导出的应该和他当初导入的
 *      完全是同一份规则，而不是被我们归一化过的东西。
 *   3. **删除不级联到书籍**。`books.source_id` 没有 `ON DELETE SET NULL`（等于 RESTRICT），
 *      所以删除前必须先把引用置空（见 `SourcesRepository.remove`）；书籍行保留，
 *      UI 上表现为「书源已移除，无法刷新」。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dialog, BrowserWindow, shell } from 'electron'
import { AppError, ERROR_CODES } from '@shared/errors'
import type { SourceDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { getNetworkBook } from '../db/repositories/network'
import { sourcesRepo, toSourceDTO } from '../db/repositories/sources'
import { createHttpClient } from '../engine/http/client'
import { breakerNote, isBreakerOpen } from '../engine/source/breaker'
import { searchSources } from '../engine/source/search'
import { NetworkFetchError } from '../engine/source/book'
import { importSources, SourceImportError, type ImportInput } from '../engine/source/import'
import { addNetworkBook, clearNetworkCacheDir, networkCacheDir, readNetworkCacheStats, refreshNetworkToc } from '../network/service'
import { runSourceDebug } from '../engine/source/debug'
import { createLogger } from '../log'
import { registerHandler } from './registry'

const log = createLogger('sources')

/**
 * 抓取异常 → 熔断状态机需要的 `{code, message}`。
 *
 * `AppError` 的码是应用级（`E_TIMEOUT` / `E_IO`），`NetworkFetchError` 的码是抓取级
 * （`E_REQUEST` / `E_HTTP`）。两者都带 `code`，但语义不同，这里统一收窄成抓取码：
 * 只有 `timeout` 要参与熔断计数，其余只需记一句原因。
 */
function failureOf(err: unknown): { code: string | null; message: string } {
  if (err instanceof NetworkFetchError) return { code: err.code, message: err.message }
  if (err instanceof AppError) {
    return {
      code: err.code === ERROR_CODES.timeout ? 'E_TIMEOUT' : err.code,
      message: err.message
    }
  }
  return { code: null, message: err instanceof Error ? err.message : String(err) }
}

/** 记录一次抓取结果；失败不影响主流程（熔断只是旁路状态） */
function noteOutcome(
  sourceId: string,
  failure: { code: string | null; message: string } | null,
  now: number
): void {
  try {
    const outcome = failure === null ? { ok: true } : { ok: false, ...failure }
    sourcesRepo().recordOutcome(sourceId, outcome, now)
  } catch (writeErr) {
    log.warn('熔断状态写入失败', { sourceId, message: failureOf(writeErr).message })
  }
}

function userError(err: unknown): never {
  if (err instanceof SourceImportError) {
    throw new AppError(ERROR_CODES.invalidArgument, err.userMessage)
  }
  throw err
}

export function registerSourcesIpc(): void {
  registerHandler('source:list', (): SourceDTO[] => sourcesRepo().list().map(toSourceDTO))

  registerHandler('source:import', async (input) => {
    let payload: ImportInput
    if ('url' in input) {
      payload = { kind: 'url', url: input.url.trim() }
    } else if ('filePath' in input) {
      payload = { kind: 'file', path: input.filePath }
    } else {
      payload = { kind: 'text', text: input.json }
    }

    try {
      const result = await importSources(payload, { repo: sourcesRepo(), now: Date.now })
      log.info('书源导入完成', {
        kind: payload.kind,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed
      })
      return result
    } catch (err) {
      // 载荷级别失败（拿不到文本 / 不是 JSON）：转成用户能读懂的文案
      userError(err)
    }
  })

  registerHandler('source:toggle', ({ id, enabled }) => {
    if (!sourcesRepo().setEnabled(id, enabled)) {
      throw new AppError(ERROR_CODES.notFound, '书源不存在，可能已被删除')
    }
  })

  registerHandler('source:remove', ({ id }) => {
    const repo = sourcesRepo()
    const record = repo.get(id)
    if (!record) throw new AppError(ERROR_CODES.notFound, '书源不存在，可能已被删除')
    repo.remove(id)
    log.info('删除书源', { sourceId: id, name: record.name })
  })

  registerHandler('source:reorder', ({ ids }) => {
    sourcesRepo().reorder(ids)
  })

  registerHandler('source:export', async ({ ids, path }) => {
    const repo = sourcesRepo()
    const records = repo.list()
    const selected = ids === undefined ? records : records.filter((record) => ids.includes(record.id))
    if (selected.length === 0) throw new AppError(ERROR_CODES.notFound, '没有可导出的书源')

    const payload = selected.map((record) => {
      // rule_json 是我们自己写进去的合法 JSON；万一被外部改坏，退化成「用最小字段重建」
      // 也比整个导出失败好——用户至少能拿到名称和地址。
      try {
        return JSON.parse(record.ruleJson) as unknown
      } catch {
        log.warn('rule_json 不是合法 JSON，已用最小字段重建', { sourceId: record.id })
        return { bookSourceUrl: record.url, bookSourceName: record.name }
      }
    })

    let target = path
    if (!target) {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: '导出书源',
        defaultPath: 'ctext-书源.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) return null
      target = picked.filePath
    }

    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    log.info('导出书源', { count: payload.length, path: target })
    return { path: target, count: payload.length }
  })

  registerHandler('source:pickFile', async (_input, ctx) => {
    const win = ctx.window ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: '选择书源文件',
      properties: ['openFile'],
      filters: [
        { name: '书源 JSON', extensions: ['json'] },
        { name: '文本', extensions: ['txt'] }
      ]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null
    return { path: picked.filePaths[0] }
  })

  /**
   * 聚合搜索。
   *
   * 每搜一次建一次连接池：书源搜索是「一次性并发 8 个站点」的场景，把连接池挂成
   * 应用级单例，换来的只是几个长期空闲的 socket 和一条不会释放的 host 队列。
   *
   * 成功的源才 bump `last_used_at`——失败的源写进去会让「最近使用」排序变成「最近试过」。
   */
  registerHandler('source:search', async ({ keyword, opts }) => {
    const text = keyword.trim()
    if (text === '') throw new AppError(ERROR_CODES.invalidArgument, '请输入要搜索的书名或作者')

    const repo = sourcesRepo()
    const now = Date.now()
    const enabled = repo.listEnabled()

    /*
     * 熔断中的源**不发请求**，直接在失败清单里给一条 `E_BREAKER`。
     *
     * 放在这里而不是引擎里：引擎只认「要不要搜这个源」，不知道冷却时间；
     * 而「跳过一条源」这件事必须出现在结果里，否则用户看到的是「一个源都没结果」
     * 却不知道为什么。
     */
    const usable = enabled.filter((record) => {
      const state = { streak: record.failStreak, until: record.breakerUntil, lastFailure: record.lastFailure }
      if (!isBreakerOpen(state, now)) return true
      log.info('书源熔断中，跳过', { sourceId: record.id, until: record.breakerUntil })
      return false
    })
    const skipped = enabled
      .map((record) => {
        const state = { streak: record.failStreak, until: record.breakerUntil, lastFailure: record.lastFailure }
        if (!isBreakerOpen(state, now)) return null
        return {
          sourceId: record.id,
          sourceName: record.name,
          code: 'E_BREAKER',
          message: breakerNote(state, now) ?? '该源已被临时停用'
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    const http = createHttpClient()
    try {
      const result = await searchSources(usable, text, opts ?? {}, http)
      for (const group of result.groups) {
        repo.touch(group.sourceId, now)
        noteOutcome(group.sourceId, null, now)
      }
      for (const failure of result.failures) {
        noteOutcome(failure.sourceId, { code: failure.code, message: failure.message }, now)
      }
      if (skipped.length > 0) result.failures.push(...skipped)
      log.info('书源搜索完成', {
        keyword: text,
        groups: result.groups.length,
        failures: result.failures.length,
        skipped: skipped.length,
        elapsedMs: result.elapsedMs
      })
      return result
    } finally {
      await http.close()
    }
  })

  /**
   * 加入书架（M4-09）。
   *
   * `title` 只用搜索结果的标题兜底：详情规则写了 `name` 就以详情页为准，
   * 因为搜索结果里的书名常带站点广告尾巴。
   */
  registerHandler('source:addBook', async ({ sourceId, bookUrl, title }) => {
    try {
      const result = await addNetworkBook(getDb(), { sourceId, bookUrl, fallbackTitle: title })
      sourcesRepo().touch(sourceId, Date.now())
      noteOutcome(sourceId, null, Date.now())
      return result
    } catch (err) {
      noteOutcome(sourceId, failureOf(err), Date.now())
      throw err
    }
  })

  /**
   * 刷新目录（M4-09）。失败时同样推进熔断——这条链路与搜索发的是同一个站点，
   * 站点挂了两个入口都会挂，只统计搜索会让「点刷新目录 → 超时」无限重试。
   */
  registerHandler('source:refreshToc', async ({ bookId }) => {
    const sourceId = getNetworkBook(getDb(), bookId)?.source_id ?? null
    try {
      const result = await refreshNetworkToc(getDb(), bookId)
      if (sourceId !== null) noteOutcome(sourceId, null, Date.now())
      return result
    } catch (err) {
      if (sourceId !== null) noteOutcome(sourceId, failureOf(err), Date.now())
      throw err
    }
  })

  /**
   * 缓存治理（M4-10）。
   *
   * 用量每次现扫一遍目录而不是维护一张索引表：章节文件总量在几万个以内，一次
   * `readdir + stat` 几十毫秒；而索引表要在写入、清理、目录刷新的每条路径上同步，
   * 三条路里漏一条就是「界面显示 200MB，实际占 2GB」。
   */
  registerHandler('source:cacheStats', () => readNetworkCacheStats(getDb()))

  registerHandler('source:clearCache', async ({ bookId }) => {
    const result = await clearNetworkCacheDir(getDb(), bookId)
    log.info('清理正文缓存', { bookId: bookId ?? 'all', ...result })
    return result
  })

  /**
   * 手动解除熔断（M4-12）。不重新发请求——用户点「恢复」之后自己会再搜一次，
   * 这里替他发一次只会让「恢复」按钮变成第二个搜索入口。
   */
  registerHandler('source:resetBreaker', ({ sourceId }) => {
    const repo = sourcesRepo()
    if (!repo.get(sourceId)) throw new AppError(ERROR_CODES.notFound, '书源不存在，可能已被移除')
    repo.resetBreaker(sourceId)
    const record = repo.get(sourceId)
    if (!record) throw new AppError(ERROR_CODES.notFound, '书源不存在，可能已被移除')
    log.info('手动解除熔断', { sourceId })
    return toSourceDTO(record)
  })

  registerHandler('source:openCacheDir', async () => {
    const dir = networkCacheDir()
    // 还没缓存过任何章节时目录不存在，openPath 会直接失败
    await mkdir(dir, { recursive: true })
    const message = await shell.openPath(dir)
    if (message !== '') throw new AppError(ERROR_CODES.io, `无法打开缓存目录：${message}`)
  })

  /**
   * 规则调试（M4-11）。
   *
   * 只读：不写 books / chapters / 缓存。每次调用建一个新的连接池，跑完关掉——
   * 调试是一锤子买卖，让一个连接池挂在主进程里等下次点击没有意义。
   */
  registerHandler('source:debug', async (input) => {
    const record = sourcesRepo().get(input.sourceId)
    if (record === null) throw new AppError(ERROR_CODES.notFound, '书源不存在或已被删除')

    const http = createHttpClient()
    try {
      const result = await runSourceDebug(record, input, http)
      log.info('规则调试完成', {
        sourceId: record.id,
        elapsedMs: result.elapsedMs,
        sections: result.sections.map((section) => `${section.phase}:${section.ok ? 'ok' : section.skipped ? 'skip' : 'fail'}`)
      })
      return result
    } finally {
      await http.close()
    }
  })
}
