/**
 * CSS 取值器（M4-02）。
 *
 * 输入一段 HTML + 一条 CSS 规则（`expr` 来自 M4-01 的解析结果），输出匹配到的值。
 * 只处理「选择器 + 取值后缀」，不做网络、不跑 JS、不拼链式——链式由引擎逐段调用。
 *
 * 兼容 Legado 的两种写法：
 *   1. 选择器简写：`tag.a` → `a`、`class.red` → `.red`、`id.main` → `#main`
 *   2. 取值后缀：`@text @textNodes @ownText @href @src @html @outerHtml @content`
 *
 * 语义对齐 jsoup（阅读 3.0 的实现），否则同一本书在两个软件里取到的东西会不一样：
 *   - `@text`      → `element.text()`，**折叠空白**（jsoup 的行为，不是原样返回）
 *   - `@ownText`   → 只看直接文本子节点，不递归
 *   - `@textNodes` → 所有后代文本节点各自 trim 后用 `\n` 拼接
 *   - `@html`      → innerHTML；`@outerHtml` → outerHTML
 *   - `@href/@src/@content` → 对应属性，缺失返回空串
 *
 * 索引与区间（M4-12 按 Legado 的语义补齐）：
 *   - `!N`        取第 N 个匹配（从 0 开始，负数从末尾数，`!-1` = 最后一个）
 *   - `[起:止]`   切片，`止` 不含；两端都可省略、可为负（`[1:]`、`[:-1]`）
 * 两者都只能出现在表达式的**末尾**（紧贴取值后缀之前），与 Legado 一致；
 * `[...]` 只有在内容形如 `数字:数字` 时才当区间，否则原样留给 cheerio——
 * 否则 `[data-id]` 这类属性选择器会被误吃。
 */
import { load, type CheerioAPI } from 'cheerio'
import type { AnyNode, Element, Text } from 'domhandler'
import type { TakeKind } from '../ruleParser'

export interface CssExtractResult {
  /** 取到的值（空串已被丢弃，便于上层做 `||` 降级判定） */
  values: string[]
  /** 选择器无效时的原因；正常为空 */
  error: string | null
}

/** Legado 选择器简写 → 标准 CSS 选择器 */
export function translateLegadoSelector(selector: string): string {
  return selector.replace(/(^|[\s>+~,])(tag|class|id)\./g, (_full, lead: string, kind: string) => {
    if (kind === 'tag') return lead
    return lead + (kind === 'class' ? '.' : '#')
  })
}

export interface IndexSuffix {
  /** 去掉索引/区间后的选择器 */
  selector: string
  index: number | null
  range: { start: number | null; end: number | null } | null
}

/**
 * 切出末尾的 `!N` / `[a:b]`。
 *
 * 只认末尾：真实书源里 `div.list!0`、`div.list[1:3]` 都是结尾写法，
 * 中间出现 `!` 的（比如 JS 片段里）不属于本层职责，交给解析器判「选择器无效」。
 */
export function splitIndexSuffix(expr: string): IndexSuffix {
  const text = expr.trim()

  const bang = /!(-?\d+)$/.exec(text)
  if (bang !== null) {
    return { selector: text.slice(0, bang.index).trim(), index: Number(bang[1]), range: null }
  }

  const range = /\[(-?\d*):(-?\d*)\]$/.exec(text)
  if (range !== null) {
    const start = range[1] === '' ? null : Number(range[1])
    const end = range[2] === '' ? null : Number(range[2])
    return { selector: text.slice(0, range.index).trim(), index: null, range: { start, end } }
  }

  return { selector: text, index: null, range: null }
}

/** 负索引折算成绝对下标；越界返回 null（与 Legado 的 `get(index)` 一致：取不到就是空） */
function resolveIndex(index: number, length: number): number | null {
  const absolute = index < 0 ? length + index : index
  return absolute >= 0 && absolute < length ? absolute : null
}

export function extractCss(html: string, expr: string, take: TakeKind | null): CssExtractResult {
  const parsed = splitIndexSuffix(expr)
  const selector = translateLegadoSelector(parsed.selector)
  if (selector === '') return { values: [], error: null }

  let $: CheerioAPI
  try {
    $ = load(html)
  } catch (err) {
    return { values: [], error: messageOf(err) }
  }

  let nodes: Element[]
  try {
    nodes = $(selector).toArray() as Element[]
  } catch (err) {
    return { values: [], error: `选择器无效：${messageOf(err)}` }
  }

  if (parsed.index !== null) {
    const at = resolveIndex(parsed.index, nodes.length)
    // 越界 = 没有值，不是错误：书源里 `!1` 遇到只有一条结果的页面是常态
    nodes = at === null ? [] : [nodes[at] as Element]
  } else if (parsed.range !== null) {
    const from = parsed.range.start === null ? 0 : parsed.range.start
    const to = parsed.range.end === null ? nodes.length : parsed.range.end
    // 负下标先折算；`slice` 自己会处理越界与倒序（倒序返回空，与 Java subList 不同，
    // 但书源里不会写反区间，这里选不抛错的实现）
    const start = from < 0 ? Math.max(0, nodes.length + from) : from
    const end = to < 0 ? Math.max(0, nodes.length + to) : to
    nodes = nodes.slice(start, end)
  }

  const values = nodes.map((el) => (take ? readTake($, el, take) : outerHtml($, el)))
  return { values: values.filter((value) => value !== ''), error: null }
}

/**
 * 只写取值后缀（`text` / `href` / `html`）时，直接从**片段自身的根元素**取值。
 *
 * 与 `extractCss` 分开：`extractCss` 里「空选择器 = 空结果」是 M4-02 定下的语义
 * （调用方靠它判断规则没写选择器），而这里要的恰好是「对当前元素取值」。
 * 真实书源的目录字段大多写成 `"chapterName": "text"`，走的就是这条路径。
 */
export function extractSelf(html: string, take: TakeKind): CssExtractResult {
  let $: CheerioAPI
  try {
    $ = load(html)
  } catch (err) {
    return { values: [], error: messageOf(err) }
  }

  const node = $('body').children().first()
  const el = node.get(0)
  if (el === undefined) {
    // 片段里没有元素（纯文本片段）：文本类取值仍可用，其余没有对象
    if (take === 'text' || take === 'ownText' || take === 'textNodes') {
      const text = collapseWhitespace($('body').text())
      return { values: text === '' ? [] : [text], error: null }
    }
    return { values: [], error: null }
  }

  const value = readTake($, el, take)
  return { values: value === '' ? [] : [value], error: null }
}

function readTake($: CheerioAPI, el: Element, take: TakeKind): string {
  const node = $(el)
  switch (take) {
    case 'text':
      return collapseWhitespace(node.text())
    case 'ownText':
      return collapseWhitespace(ownText(el))
    case 'textNodes':
      return textNodes(el)
    case 'html':
      return node.html() ?? ''
    case 'outerHtml':
      return outerHtml($, el)
    case 'href':
      return node.attr('href') ?? ''
    case 'src':
      return node.attr('src') ?? ''
    case 'content':
      return node.attr('content') ?? ''
    default:
      return ''
  }
}

function outerHtml($: CheerioAPI, el: Element): string {
  return $.html(el) ?? ''
}

/** jsoup `text()`：连续空白折叠成一个空格并 trim（xpath 取值器复用同一语义） */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** jsoup `ownText()`：只取直接文本子节点 */
function ownText(el: Element): string {
  return el.children
    .filter((child): child is Text => child.type === 'text')
    .map((child) => child.data)
    .join('')
}

/** 所有后代文本节点，各自 trim、去掉空节点，用换行拼接 */
function textNodes(el: Element): string {
  const parts: string[] = []
  walkText(el, (text) => {
    const value = text.data.trim()
    if (value !== '') parts.push(value)
  })
  return parts.join('\n')
}

function walkText(node: AnyNode, visit: (text: Text) => void): void {
  if (node.type === 'text') {
    visit(node)
    return
  }
  const children = (node as { children?: AnyNode[] }).children
  if (children) for (const child of children) walkText(child, visit)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
