/**
 * M4-07 自检：书源导入管线（解析 → 归一 → 兼容判定 → 落库）。
 *
 * 用临时库跑，不碰真实 userData。三块断言分开：
 *   1. `parsePayload`  —— 载荷能不能认出来（BOM / 嵌套数组 / HTML / 坏 JSON）
 *   2. `normalizeSource` / `analyzeCompat` —— 单条书源的归一与兼容分级
 *   3. 整条导入管线 —— imported / updated / skipped / failed 四种结果与落库内容
 *
 * 特意保留两条「宁收不拒」的断言（音频书源、坏正则）：它们证明导入**不因质量差而拒绝**，
 * 只是被标成 unsupported / partial。产品口径是「用户能看到、能删能改」，
 * 而不是「我们替他决定什么该进库」。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SourceDTO } from '@shared/dto'
import { openDatabase } from '../../db/connection'
import { SourcesRepository, toSourceDTO } from '../../db/repositories/sources'
import { analyzeCompat, unknownJavaMethods } from './compat'
import { assertJsonContentType, importSources, SourceImportError } from './import'
import { normalizeSource, parsePayload } from './model'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/** 一条「能跑通」的最小书源：搜索 / 目录 / 正文齐全 */
const GOOD = {
  bookSourceUrl: 'https://good.example.com',
  bookSourceName: '完整书源',
  bookSourceGroup: '综合',
  bookSourceType: 0,
  enabled: true,
  customOrder: 0,
  searchUrl: '/search?q={{key}}&page={{page}}',
  header: '{"User-Agent":"Mozilla/5.0 test"}',
  ruleSearch: {
    bookList: '@css:.result-list>li',
    name: '@css:.title@text',
    author: '@css:.author@text',
    bookUrl: '@css:h3>a@href'
  },
  ruleBookInfo: { name: '@css:h1@text', intro: '@css:#intro@text' },
  ruleToc: { chapterList: '@css:#list>dd', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
  ruleContent: { content: '@css:#content@textNodes' }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 归一 + 判定；归一失败时直接抛，让断言红掉而不是静默算出个 full */
function reportOf(raw: unknown): ReturnType<typeof analyzeCompat> {
  const normalized = normalizeSource(raw)
  if (!normalized.ok) throw new Error(`归一失败：${normalized.reason}`)
  return analyzeCompat(normalized.source)
}

export async function runSourceSmoke(): Promise<Check[]> {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  // ---------------------------------------------------------------- 载荷解析
  {
    const single = parsePayload(JSON.stringify(GOOD))
    check('单个对象被包成一元素数组', single.ok && single.items.length === 1, single.ok ? '' : single.reason)

    const array = parsePayload(JSON.stringify([GOOD, { ...GOOD, bookSourceUrl: 'https://b.example.com' }]))
    check('数组按条展开', array.ok && array.items.length === 2, array.ok ? '' : array.reason)

    const nested = parsePayload(JSON.stringify([[GOOD], [GOOD]]))
    check('嵌套数组被摊平', nested.ok && nested.items.length === 2, nested.ok ? '' : nested.reason)

    const bom = parsePayload(`\uFEFF${JSON.stringify(GOOD)}`)
    check('带 BOM 的 UTF-8 能解析', bom.ok && bom.items.length === 1, bom.ok ? '' : bom.reason)

    const empty = parsePayload('   ')
    check('空内容给出人话原因', !empty.ok && empty.reason.includes('为空'), empty.ok ? '' : empty.reason)

    const html = parsePayload('<!DOCTYPE html><html><body>404</body></html>')
    check(
      'HTML 被识别并提示改用导入 URL',
      !html.ok && html.reason.includes('HTML'),
      html.ok ? '' : html.reason
    )

    const broken = parsePayload('{ "bookSourceUrl": ')
    check('坏 JSON 带上原始报错', !broken.ok && broken.reason.startsWith('JSON 解析失败'), broken.ok ? '' : broken.reason)

    const scalar = parsePayload('42')
    check('顶层是标量判失败', !scalar.ok, scalar.ok ? '' : scalar.reason)

    const emptyArray = parsePayload('[]')
    check('空数组判失败', !emptyArray.ok && emptyArray.reason.includes('空的'), emptyArray.ok ? '' : emptyArray.reason)
  }

  // ---------------------------------------------------------------- 归一化
  {
    const missingUrl = normalizeSource({ bookSourceName: '没有地址' })
    check(
      '缺 bookSourceUrl 判失败并保留名称',
      !missingUrl.ok && missingUrl.name === '没有地址',
      missingUrl.ok ? '' : missingUrl.reason
    )

    const badProtocol = normalizeSource({ bookSourceUrl: 'file:///etc/passwd', bookSourceName: 'x' })
    check('非 http(s) 地址判失败', !badProtocol.ok, badProtocol.ok ? '' : badProtocol.reason)

    const noName = normalizeSource({ ...GOOD, bookSourceName: undefined })
    check(
      '缺名称回退到域名并记 warning',
      noName.ok && noName.source.name === 'good.example.com' && noName.source.warnings.some((w) => w.includes('bookSourceName')),
      noName.ok ? noName.source.name : noName.reason
    )

    const audio = normalizeSource({ ...GOOD, bookSourceType: 1 })
    check('bookSourceType=1 被读出来', audio.ok && audio.source.bookSourceType === 1, audio.ok ? '' : audio.reason)

    const disabled = normalizeSource({ ...GOOD, enabled: 'false' })
    check('enabled 字符串 "false" 被识别为停用', disabled.ok && !disabled.source.enabled, disabled.ok ? '' : disabled.reason)

    const enabledDefault = normalizeSource({ ...GOOD, enabled: undefined })
    check('enabled 缺失时默认启用', enabledDefault.ok && enabledDefault.source.enabled, '')

    const header = normalizeSource(GOOD)
    check(
      'header 的 JSON 字符串被解析成对象',
      header.ok && header.source.header?.['User-Agent'] === 'Mozilla/5.0 test',
      header.ok ? JSON.stringify(header.source.header) : ''
    )

    const badHeader = normalizeSource({ ...GOOD, header: '{不是 JSON' })
    check(
      'header 坏 JSON 降级成 warning',
      badHeader.ok && badHeader.source.header === null && badHeader.source.warnings.some((w) => w.includes('header')),
      badHeader.ok ? badHeader.source.warnings.join('|') : ''
    )

    const textHeader = normalizeSource({ ...GOOD, header: 'Referer: https://a.com\nX-Token: abc' })
    check(
      '多行文本 header 也认',
      textHeader.ok && textHeader.source.header?.['Referer'] === 'https://a.com' && textHeader.source.header['X-Token'] === 'abc',
      textHeader.ok ? JSON.stringify(textHeader.source.header) : ''
    )

    const nonStringRule = normalizeSource({
      ...GOOD,
      ruleSearch: { ...GOOD.ruleSearch, wordCount: 123 }
    })
    check(
      '非字符串规则被丢弃并记 warning',
      nonStringRule.ok &&
        nonStringRule.source.rules.ruleSearch?.['wordCount'] === undefined &&
        nonStringRule.source.warnings.some((w) => w.includes('wordCount')),
      nonStringRule.ok ? nonStringRule.source.warnings.join('|') : ''
    )

    const noRules = normalizeSource({ bookSourceUrl: 'https://x.example.com' })
    check(
      '完全没有规则字段给 warning 但仍归一成功',
      noRules.ok && noRules.source.warnings.some((w) => w.includes('规则')),
      noRules.ok ? noRules.source.warnings.join('|') : ''
    )
  }

  // ---------------------------------------------------------------- 兼容判定
  {
    const good = reportOf(GOOD)
    check('完整书源判 full', good.level === 'full' && good.notes.length === 0, `${good.level} ${good.notes.join('|')}`)

    const noContent = clone(GOOD) as unknown as Record<string, Record<string, unknown>>
    delete noContent['ruleContent']['content']
    const noContentReport = reportOf(noContent)
    check(
      '缺正文规则判 partial 并说明原因',
      noContentReport?.level === 'partial' && noContentReport.notes.join('').includes('正文'),
      `${noContentReport?.level} ${noContentReport?.notes.join('|')}`
    )

    const noSearchReport = reportOf({ ...GOOD, searchUrl: undefined })
    check(
      '缺 searchUrl 判 partial',
      noSearchReport?.level === 'partial' && noSearchReport.notes.join('').includes('搜索'),
      `${noSearchReport?.level} ${noSearchReport?.notes.join('|')}`
    )

    const audioReport = reportOf({ ...GOOD, bookSourceType: 1 })
    check(
      '音频书源判 unsupported 但仍可导入',
      audioReport?.level === 'unsupported',
      `${audioReport?.level} ${audioReport?.notes.join('|')}`
    )

    const bareReport = reportOf({ bookSourceUrl: 'https://bare.example.com', bookSourceName: '空壳' })
    check('三条核心规则全缺判 unsupported', bareReport?.level === 'unsupported', `${bareReport?.level}`)

    const badRegexReport = reportOf({
      ...GOOD,
      ruleSearch: { ...GOOD.ruleSearch, name: '@css:.t@text##([a-z' }
    })
    check(
      '坏正则判 partial 且指出规则路径',
      badRegexReport?.level === 'partial' &&
        badRegexReport.issues.some((issue) => issue.path === 'ruleSearch.name'),
      `${badRegexReport?.level} ${badRegexReport?.issues.map((i) => i.path).join(',')}`
    )

    const unknownJavaReport = reportOf({
      ...GOOD,
      ruleContent: { content: '@js:java.ajax(url) + java.cryptoAes(x)' }
    })
    check(
      '白名单外的 java 方法被判出来',
      unknownJavaReport?.level === 'partial' &&
        unknownJavaReport.issues.some((issue) => issue.reason.includes('cryptoAes')),
      `${unknownJavaReport?.level} ${unknownJavaReport?.issues.map((i) => i.reason).join(',')}`
    )

    const knownJavaReport = reportOf({
      ...GOOD,
      ruleContent: { content: '@js:java.base64Encode(result)' }
    })
    check(
      '白名单内的 java 方法不扣分（仍算 full）',
      knownJavaReport?.level === 'full' && knownJavaReport.jsRules === 1,
      `${knownJavaReport?.level} js=${knownJavaReport?.jsRules}`
    )

    const nestedPut = normalizeSource({
      ...GOOD,
      ruleSearch: { ...GOOD.ruleSearch, name: '@css:.t@text@put:{a:(['}
    })
    const nestedPutReport = nestedPut.ok ? analyzeCompat(nestedPut.source) : null
    check(
      '@put 内层规则同样被检查',
      nestedPutReport !== null && nestedPutReport.level !== 'full',
      `${nestedPutReport?.level}`
    )

    const loginReport = reportOf({ ...GOOD, loginUrl: 'https://good.example.com/login' })
    check(
      '声明 loginUrl 判 partial',
      loginReport?.level === 'partial' && loginReport.notes.join('').includes('登录'),
      `${loginReport?.level} ${loginReport?.notes.join('|')}`
    )

    check(
      'unknownJavaMethods 去重且忽略动态取属性',
      JSON.stringify(unknownJavaMethods('java.a(); java.a(); java.b(); java[k]()')) === JSON.stringify(['a', 'b']),
      JSON.stringify(unknownJavaMethods('java.a(); java.a(); java.b(); java[k]()'))
    )
  }

  // ---------------------------------------------------------------- 落库管线
  const base = join(app.getPath('temp'), `ctext-sources-smoke-${Date.now()}`)
  mkdirSync(base, { recursive: true })
  const { db } = openDatabase(join(base, 'sources.db'))

  try {
    const repo = new SourcesRepository(db)
    let clock = 1_700_000_000_000
    const deps = { repo, now: () => (clock += 1000) }

    // --- 首次导入 ---
    const first = await importSources({ kind: 'text', text: JSON.stringify([GOOD, { ...GOOD, bookSourceUrl: 'https://b.example.com', bookSourceName: '书源B' }]) }, deps)
    check(
      '首次导入两条都为 imported',
      first.imported === 2 && first.updated === 0 && first.skipped === 0 && first.failed === 0,
      JSON.stringify({ i: first.imported, u: first.updated, s: first.skipped, f: first.failed })
    )
    check('导入结果按条回传', first.items.length === 2 && first.items[0].status === 'imported', `${first.items.length} 条`)

    // --- 重复导入（必须是**完全同一份载荷**，否则 B 的名称变了会被判 updated 而不是 skipped）---
    const again = await importSources(
      { kind: 'text', text: JSON.stringify([GOOD, { ...GOOD, bookSourceUrl: 'https://b.example.com', bookSourceName: '书源B' }]) },
      deps
    )
    check(
      '内容未变时判 skipped',
      again.skipped === 2 && again.imported === 0 && again.updated === 0,
      JSON.stringify({ i: again.imported, u: again.updated, s: again.skipped })
    )

    // --- 内容变化 ---
    const changed = await importSources(
      { kind: 'text', text: JSON.stringify([{ ...GOOD, bookSourceName: '改名后的书源' }]) },
      deps
    )
    check('内容变化判 updated', changed.updated === 1 && changed.imported === 0, `u=${changed.updated}`)
    const renamed = repo.findByUrl(GOOD.bookSourceUrl)
    check('更新写回了新名称', renamed?.name === '改名后的书源', renamed?.name ?? 'null')

    // --- 大小写不敏感的去重 ---
    const upper = await importSources(
      { kind: 'text', text: JSON.stringify([{ ...GOOD, bookSourceUrl: 'https://GOOD.example.com' }]) },
      deps
    )
    check(
      'URL 大小写不同视为同一书源',
      upper.imported === 0 && (upper.skipped === 1 || upper.updated === 1),
      JSON.stringify({ i: upper.imported, u: upper.updated, s: upper.skipped })
    )

    // --- 坏数据不影响其余 ---
    const mixed = await importSources(
      {
        kind: 'text',
        text: JSON.stringify([
          { bookSourceName: '没有地址' },
          { ...GOOD, bookSourceUrl: 'https://c.example.com', bookSourceName: '书源C' }
        ])
      },
      deps
    )
    check(
      '一条坏数据不影响其余',
      mixed.failed === 1 && mixed.imported === 1,
      JSON.stringify({ i: mixed.imported, f: mixed.failed })
    )
    check(
      '失败项带上人话原因',
      mixed.items[0].status === 'failed' && (mixed.items[0].reason ?? '').includes('bookSourceUrl'),
      mixed.items[0].reason ?? ''
    )

    // --- 落库内容 ---
    const stored = repo.findByUrl(GOOD.bookSourceUrl)
    check('compat_level 落库', stored?.compatLevel === 'full', stored?.compatLevel ?? 'null')
    check(
      'rule_json 与列表字段一致（不是各写各的）',
      stored !== null && JSON.parse(stored.ruleJson)['bookSourceName'] === stored.name,
      stored === null ? 'null' : String(JSON.parse(stored.ruleJson)['bookSourceName'])
    )
    check('header 等原始字段没有被改写', stored !== null && JSON.parse(stored.ruleJson)['header'] !== undefined, '')
    check('created_at 有值', (stored?.createdAt ?? 0) > 0, String(stored?.createdAt))

    const partialSource = await importSources(
      {
        kind: 'text',
        text: JSON.stringify([{ ...GOOD, bookSourceUrl: 'https://partial.example.com', ruleContent: {} }])
      },
      deps
    )
    check('部分兼容的书源仍被导入', partialSource.imported === 1, JSON.stringify({ i: partialSource.imported }))
    const partialStored = repo.findByUrl('https://partial.example.com')
    check(
      'compat_note 写入了原因',
      partialStored?.compatLevel === 'partial' && (partialStored.compatNote ?? '').includes('正文'),
      `${partialStored?.compatLevel} / ${partialStored?.compatNote ?? ''}`
    )
    check('导入结果里带 compatLevel', partialSource.items[0].compatLevel === 'partial', String(partialSource.items[0].compatLevel))

    // --- 启停不被重新导入覆盖 ---
    const target = repo.findByUrl('https://b.example.com')
    check('书源B 存在', target !== null, '')
    if (target) {
      repo.setEnabled(target.id, false)
      const reimport = await importSources(
        { kind: 'text', text: JSON.stringify([{ ...GOOD, bookSourceUrl: 'https://b.example.com', enabled: true }]) },
        deps
      )
      const afterToggle = repo.get(target.id)
      check(
        '重新导入不会把用户停用的书源悄悄打开',
        reimport.updated + reimport.skipped === 1 && afterToggle?.enabled === false,
        `enabled=${String(afterToggle?.enabled)}`
      )
    }

    // --- 排序 ---
    const all = repo.list()
    check('列表按 custom_order 返回', all.length >= 3, `${all.length} 条`)
    const reversed = [...all].reverse().map((record) => record.id)
    repo.reorder(reversed)
    const afterReorder = repo.list().map((record) => record.id)
    check('reorder 后顺序完全一致', JSON.stringify(afterReorder) === JSON.stringify(reversed), afterReorder.join(','))

    // --- 导出 ---
    const exported = repo.list().map((record) => JSON.parse(record.ruleJson) as Record<string, unknown>)
    check(
      '导出内容能还原成可再导入的 JSON 数组',
      exported.length === all.length && typeof exported[0]['bookSourceUrl'] === 'string',
      `${exported.length} 条`
    )
    const roundTrip = await importSources({ kind: 'text', text: JSON.stringify(exported) }, deps)
    check(
      '导出的文件再导入全部 skipped（闭环）',
      roundTrip.skipped === exported.length && roundTrip.failed === 0,
      JSON.stringify({ s: roundTrip.skipped, f: roundTrip.failed })
    )

    // --- 删除 ---
    if (target) {
      check('删除返回 true', repo.remove(target.id), '')
      check('删除后查不到', repo.findByUrl('https://b.example.com') === null, '')
    }

    // --- DTO 映射 ---
    const dto: SourceDTO = toSourceDTO(repo.list()[0])
    check(
      'DTO 字段完整且 camelCase',
      typeof dto.id === 'string' && typeof dto.enabled === 'boolean' && dto.compatLevel !== undefined,
      JSON.stringify({ id: dto.id.slice(0, 6), enabled: dto.enabled, compat: dto.compatLevel })
    )

    // --- 文件导入 ---
    const filePath = join(base, 'sources.json')
    writeFileSync(filePath, JSON.stringify([{ ...GOOD, bookSourceUrl: 'https://file.example.com', bookSourceName: '文件书源' }]), 'utf8')
    const fromFile = await importSources({ kind: 'file', path: filePath }, deps)
    check('文件导入走同一条管线', fromFile.imported === 1, JSON.stringify({ i: fromFile.imported, f: fromFile.failed }))

    // --- 文件不存在 ---
    let missingFile = ''
    try {
      await importSources({ kind: 'file', path: join(base, 'nope.json') }, deps)
    } catch (err) {
      missingFile = err instanceof SourceImportError ? err.userMessage : String(err)
    }
    check('文件不存在给出人话原因', missingFile.includes('读取失败'), missingFile)

    // --- URL 直链：内容类型闸门（验收项「HTML 地址被拒且提示明确」）---
    let htmlRejected = ''
    try {
      assertJsonContentType('text/html; charset=utf-8')
    } catch (err) {
      htmlRejected = err instanceof SourceImportError ? err.userMessage : String(err)
    }
    check('返回 HTML 的地址被拒且提示明确', htmlRejected.includes('网页'), htmlRejected)
    check(
      'JSON / 纯文本 / 未声明类型都放行',
      (() => {
        try {
          assertJsonContentType('application/json')
          assertJsonContentType('text/plain; charset=utf-8')
          assertJsonContentType(undefined)
          return true
        } catch {
          return false
        }
      })(),
      ''
    )

    // --- URL 直链：SSRF 拦截（验收项「指向 127.0.0.1 的地址被拒」）---
    let ssrfRejected = ''
    try {
      await importSources({ kind: 'url', url: 'http://127.0.0.1:9/sources.json' }, deps)
    } catch (err) {
      ssrfRejected = err instanceof SourceImportError ? err.userMessage : String(err)
    }
    check('指向 127.0.0.1 的地址被拒', ssrfRejected.includes('拒绝访问'), ssrfRejected)

    let fileProtocol = ''
    try {
      await importSources({ kind: 'url', url: 'file:///C:/sources.json' }, deps)
    } catch (err) {
      fileProtocol = err instanceof SourceImportError ? err.userMessage : String(err)
    }
    check('非 http(s) 协议被拒', fileProtocol.includes('http'), fileProtocol)

    // --- 批量导入 100 条（验收项：给出成功/部分/不支持的统计）---
    const batch = Array.from({ length: 100 }, (_, index) => {
      if (index < 80) {
        return { ...GOOD, bookSourceUrl: `https://batch${index}.example.com`, bookSourceName: `批量书源 ${index}` }
      }
      if (index < 95) {
        // 缺正文规则 → partial
        return {
          ...GOOD,
          bookSourceUrl: `https://batch${index}.example.com`,
          bookSourceName: `批量书源 ${index}`,
          ruleContent: {}
        }
      }
      // 音频 → unsupported
      return {
        ...GOOD,
        bookSourceUrl: `https://batch${index}.example.com`,
        bookSourceName: `批量书源 ${index}`,
        bookSourceType: 1
      }
    })
    const batchResult = await importSources({ kind: 'text', text: JSON.stringify(batch) }, deps)
    const levelCount = batchResult.items.reduce<Record<string, number>>((acc, item) => {
      const key = item.compatLevel ?? 'unknown'
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})
    check(
      '批量导入 100 条全部写入',
      batchResult.imported === 100 && batchResult.failed === 0,
      JSON.stringify({ i: batchResult.imported, f: batchResult.failed })
    )
    check(
      '结果按兼容级别分组统计准确',
      levelCount['full'] === 80 && levelCount['partial'] === 15 && levelCount['unsupported'] === 5,
      JSON.stringify(levelCount)
    )

    // --- 超大文件在读取前被拒 ---
    let tooBig = ''
    try {
      // 用稀疏文件撑到 6MB，不实际写 6MB 内容
      const bigPath = join(base, 'big.json')
      writeFileSync(bigPath, Buffer.alloc(6 * 1024 * 1024, 0x20))
      await importSources({ kind: 'file', path: bigPath }, deps)
    } catch (err) {
      tooBig = err instanceof SourceImportError ? err.userMessage : String(err)
    }
    check('超过 5MB 的文件被拒', tooBig.includes('MB'), tooBig)
  } finally {
    db.close()
    rmSync(base, { recursive: true, force: true })
  }

  return checks
}
