/**
 * 书源导入管线（M4-07）。
 *
 * 三种输入走**同一条**校验管线：本地 `.json` 文件 / 粘贴的 JSON 文本 / URL 直链。
 * 差异只在「怎么拿到文本」这一步，拿到之后完全一样——这是刻意的：
 * 三条路各写一套校验，迟早会出现「文件导入能用、粘贴导入报错」这种鬼问题。
 *
 * 逐条处理，单条失败不影响其余（批量导入 100 条时一条坏数据不该让整批回滚）。
 * 返回值就是 `SourceImportResultDTO`，UI 直接拿去渲染结果清单。
 */
import { readFileSync, statSync } from 'node:fs'
import type { CompatLevel, SourceImportItemDTO, SourceImportResultDTO } from '@shared/dto'
import type { SourcesRepository } from '../../db/repositories/sources'
import { createHttpClient } from '../http/client'
import { decodeBody } from '../http/charset'
import { HttpError } from '../http/ssrf'
import { analyzeCompat } from './compat'
import { normalizeSource, parsePayload } from './model'

/** 与产品文档 §2.7 一致：≤5MB、总超时 15s */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000

export interface ImportDeps {
  repo: SourcesRepository
  now: () => number
}

export type ImportInput = { kind: 'text'; text: string } | { kind: 'file'; path: string } | { kind: 'url'; url: string }

export class SourceImportError extends Error {
  constructor(
    /** 直接给用户看的文案，已经过翻译，不再往上包装 */
    readonly userMessage: string
  ) {
    super(userMessage)
    this.name = 'SourceImportError'
  }
}

/** 读取文件并限长；超长在**读之前**判断，避免把一个 2GB 文件读进内存 */
function readTextFile(path: string): string {
  let size: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new SourceImportError('所选路径不是文件')
    size = stat.size
  } catch (err) {
    if (err instanceof SourceImportError) throw err
    throw new SourceImportError('文件读取失败：路径不存在或没有权限')
  }
  if (size > MAX_PAYLOAD_BYTES) {
    throw new SourceImportError(`文件超过 ${Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024)}MB，请拆分后再导入`)
  }
  try {
    return decodeBody(readFileSync(path)).text
  } catch {
    throw new SourceImportError('文件读取失败：路径不存在或没有权限')
  }
}

/**
 * URL 直链导入（产品文档 §2.7 / 决策 D2）。
 *
 * 三条接受条件，缺一不可：
 *   1. http(s) 且解析到公网（由 M4-06 的 `assertUrlAllowed` 保证，SSRF 防护复用同一套）；
 *   2. 响应 `Content-Type` 不是 `text/html`——给个网页地址是很常见的误操作，
 *      不拦下来就会得到「JSON 解析失败：Unexpected token <」，用户看不懂；
 *   3. 体积 ≤5MB、总超时 15s、最多 3 跳重定向。
 *
 * **不做订阅**：不轮询、不自动更新已导入的书源。要更新就再导入一次。
 */
/**
 * URL 直链的内容类型闸门。
 *
 * 独立成纯函数是为了能被自检直接断言——真正要连一个返回 `text/html` 的公网地址
 * 才能覆盖这段逻辑的话，测试就变成了外部依赖，跑 CI 时一定会挂。
 */
export function assertJsonContentType(contentType: string | undefined): void {
  const normalized = (contentType ?? '').toLowerCase()
  if (normalized.includes('text/html') || normalized.includes('application/xhtml')) {
    throw new SourceImportError('该地址返回的是网页，请改用「导入文件」或「粘贴 JSON」')
  }
}

async function fetchJsonUrl(url: string): Promise<string> {
  const client = createHttpClient({
    timeoutMs: FETCH_TIMEOUT_MS,
    headersTimeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    maxBodyBytes: MAX_PAYLOAD_BYTES
  })
  try {
    const response = await client.fetch(url, { headers: { accept: 'application/json, text/plain, */*' } })
    if (response.status < 200 || response.status >= 300) {
      throw new SourceImportError(`地址返回 HTTP ${response.status}，没有拿到书源内容`)
    }
    assertJsonContentType(response.headers['content-type'])
    return response.body
  } catch (err) {
    if (err instanceof SourceImportError) throw err
    if (err instanceof HttpError) {
      // HttpError 的 message 已经是中文业务文案（被 SSRF 拦、协议不允许、超时…）
      throw new SourceImportError(err.message)
    }
    throw new SourceImportError(`拉取失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await client.close()
  }
}

async function readInput(input: ImportInput): Promise<string> {
  switch (input.kind) {
    case 'text':
      return input.text
    case 'file':
      return readTextFile(input.path)
    case 'url':
      return fetchJsonUrl(input.url)
  }
}

/**
 * 导入主流程。
 *
 * 注意 `ruleJson` 存的是 `JSON.stringify(raw)`——即**解析后再序列化**的结果，
 * 而不是文件原文。这样同一个书源从文件导入和从粘贴导入得到完全相同的字符串，
 * 重复导入才能稳定判成 `skipped`（缩进、字段顺序不同都不影响）。
 */
export async function importSources(input: ImportInput, deps: ImportDeps): Promise<SourceImportResultDTO> {
  const text = await readInput(input)
  const parsed = parsePayload(text)
  if (!parsed.ok) throw new SourceImportError(parsed.reason)

  const items: SourceImportItemDTO[] = []
  let imported = 0
  let updated = 0
  let skipped = 0
  let failed = 0

  const now = deps.now()

  for (const raw of parsed.items) {
    const normalized = normalizeSource(raw)
    if (!normalized.ok) {
      failed += 1
      items.push({
        name: normalized.name,
        url: normalized.url,
        status: 'failed',
        compatLevel: null,
        reason: normalized.reason
      })
      continue
    }

    const source = normalized.source
    const compat = analyzeCompat(source)
    const note = mergeNotes(compat.notes, source.warnings)

    try {
      const { outcome } = deps.repo.upsert({
        url: source.url,
        name: source.name,
        group: source.group,
        enabled: source.enabled,
        compatLevel: compat.level,
        compatNote: note === '' ? null : note,
        ruleJson: JSON.stringify(source.raw),
        customOrder: source.customOrder,
        now
      })

      if (outcome === 'imported') imported += 1
      else if (outcome === 'updated') updated += 1
      else skipped += 1

      items.push({
        name: source.name,
        url: source.url,
        status: outcome,
        compatLevel: compat.level,
        reason: outcome === 'skipped' ? '内容与已导入的一致' : trimNote(note)
      })
    } catch (err) {
      // 仓储写失败（唯一约束被并发撞穿、库被锁）只影响这一条
      failed += 1
      items.push({
        name: source.name,
        url: source.url,
        status: 'failed',
        compatLevel: null,
        reason: `写入失败：${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  return { imported, updated, skipped, failed, items }
}

/** 兼容判定给的是「为什么不能算 full」，归一化给的是「这书源哪里不规整」，两边都要留着 */
function mergeNotes(compatNotes: string[], warnings: string[]): string {
  const all = [...compatNotes, ...warnings]
  return [...new Set(all)].join('；')
}

function trimNote(note: string): string | null {
  return note === '' ? null : note
}

/**
 * 给 UI 用的等级描述。放在主进程是为了让「级别 → 文案」只有一份，
 * 渲染层不用自己拼（拼错了会出现「部分兼容」和「部分支持」两种说法）。
 */
export const COMPAT_LABEL: Record<CompatLevel, string> = {
  full: '完整支持',
  partial: '部分支持',
  unsupported: '不支持'
}
