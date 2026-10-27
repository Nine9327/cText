/**
 * M1-04 链路自检：经 Python bridge 调 TXT 解析。
 *
 * 解析算法本身的准确性由 `python/smoke_parse.py` 覆盖（那边能造出 GBK/UTF-16 样本）。
 * 这里只验证**另一半**：Electron 主进程 → NDJSON → worker → 返回，整条链路通不通，
 * 包括中文路径、错误码透传。M1-06 的导入队列完全依赖这条链路。
 *
 * 只在 `!app.isPackaged && CTEXT_PARSE_SMOKE=1` 时执行。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getPythonBridge } from '../bridge'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(40)
  }
  return predicate()
}

interface OutlineResult {
  encoding: string
  detectedEncoding: string
  chapters: { idx: number; title: string; level: number; offset: number; length: number }[]
  lineHits: number
}

export async function runParseBridgeSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  const base = join(app.getPath('temp'), `ctext-parse-smoke-${Date.now()}`)
  // 路径里带中文与空格：NDJSON 是 UTF-8，但 Windows 上的路径编码最容易在这类地方翻车
  const dir = join(base, '中文 目录')
  const txtPath = join(dir, '斗破苍穹 第一章 - 天蚕土豆.txt')

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      txtPath,
      '第一章 开始\n正文甲。\n第二章 继续\n正文乙。\n第三章 结束\n正文丙。\n',
      'utf-8'
    )

    const bridge = getPythonBridge()
    bridge.start()

    // worker 冷启动要拉起 Python 进程并握手，15s 是给杀软扫描留的余量
    const ready = await waitFor(() => bridge.getStatus().state === 'ready', 15_000)
    check('worker 就绪', ready, bridge.getStatus().state)
    if (!ready) return checks

    const detect = await bridge.request<{ format: string; encoding: string; size: number }>('parse.detect', {
      path: txtPath
    })
    check('bridge 调用 parse.detect', detect.format === 'txt' && detect.encoding === 'utf-8', `${detect.format}/${detect.encoding}`)
    check('parse.detect 返回真实大小', detect.size > 0, `${detect.size} 字节`)

    const outline = await bridge.request<OutlineResult>('parse.txt.outline', {
      path: txtPath,
      encoding: 'auto'
    })
    check('bridge 调用 parse.txt.outline 得到 3 章', outline.chapters.length === 3, `${outline.chapters.length} 章`)
    check('章节目录保留中文标题', outline.chapters[0]?.title === '第一章 开始', outline.chapters[0]?.title ?? '无')
    check('章节偏移单调递增', outline.chapters.every((c, i) => i === 0 || c.offset > outline.chapters[i - 1].offset), '是')

    const meta = await bridge.request<{ title: string; author: string | null; lang: string | null }>('parse.meta', {
      path: txtPath,
      format: 'txt'
    })
    check('bridge 调用 parse.meta 取到书名', meta.title === '斗破苍穹 第一章', meta.title)
    check('parse.meta 从文件名取到作者', meta.author === '天蚕土豆', String(meta.author))
    check('中文文本判定为 zh', meta.lang === 'zh', String(meta.lang))

    try {
      await bridge.request('parse.detect', { path: join(base, 'does-not-exist.txt') })
      check('文件不存在时透传 E_NOT_FOUND', false, '未抛错')
    } catch (err) {
      const code = (err as { code?: string }).code
      check('文件不存在时透传 E_NOT_FOUND', code === 'E_NOT_FOUND', String(code))
    }

    try {
      // 必须是真实存在的文件：路径不存在会先被判成 E_NOT_FOUND，
      // 那样测到的是「存在性检查」而不是「格式白名单」
      const pdfPath = join(base, 'x.pdf')
      writeFileSync(pdfPath, '%PDF-1.4')
      await bridge.request('parse.detect', { path: pdfPath })
      check('不支持的格式透传 E_INVALID_ARGUMENT', false, '未抛错')
    } catch (err) {
      const code = (err as { code?: string }).code
      check('不支持的格式透传 E_INVALID_ARGUMENT', code === 'E_INVALID_ARGUMENT', String(code))
    }

    const health = await bridge.ping(5_000)
    check('health.ping 报告 parse 方法已注册', health.methods.includes('parse.txt.outline'), health.methods.join(','))
    check(
      '解析依赖就位',
      ['ebooklib', 'lxml', 'charset_normalizer', 'PIL'].every((name) => health.deps[name] === true),
      JSON.stringify(health.deps)
    )
    check('pdfminer 已从依赖清单移除（D1）', health.deps['pdfminer'] === undefined, JSON.stringify(Object.keys(health.deps)))
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // 临时目录删不掉不影响结论
    }
  }

  return checks
}
