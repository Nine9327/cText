/**
 * XPath 取值器（M4-03）。
 *
 * 输入一段 HTML + 一条 XPath 规则，输出匹配到的值。不做网络、不跑 JS，
 * 链式由引擎逐段调用。
 *
 * 为什么不直接用 `xpath` 库配 `DOMParser.parseFromString(html)`：
 *   真实书源页面大量是「非良构 HTML」（`<br>` 不闭合、`<p>` 交叉嵌套、属性值没引号），
 *   送进 XML 解析器会整棵树解析失败。这里先用 cheerio（htmlparser2，容错解析）
 *   建树，再把树逐节点搬进 xmldom，等价于「jsoup 容错解析 + XPath 求值」，
 *   与 Legado 的处理路径一致。
 *
 * 取值语义：
 *   - `//a/@href`  → 属性节点，取 `value`
 *   - `//div/text()` → 文本节点，**只 trim 首尾**（保留正文里的换行，章节内容依赖它）
 *   - `//div`      → 元素，默认返回 outerHTML，供链式下一段重新解析
 *   - `count(//li)` / `string(//h1)` → 数字/字符串/布尔，直接转字符串
 *
 * 元素上的取值后缀（`@text @textNodes @ownText @html @href @src @content`）不是标准
 * XPath 写法，但真实书源里偶尔能见到 `@xpath:…@text`。解析期不剥（见 ruleParser），
 * 这里运行期兜底：切掉后缀并按 css 的语义取值，避免整条规则报「XPath 无效」。
 *
 * 未实现（刻意留白）：
 *   - 名称空间（`useNamespaces`）：v1 不收带 XML 名称空间的源；
 *   - XPath 2.0 函数（`matches()` 等）：`xpath` 库只支持 1.0，遇到会明确报错，不静默。
 */
import { load } from 'cheerio'
import type { AnyNode, Element as HtmlElement } from 'domhandler'
import { DOMParser } from '@xmldom/xmldom'
import type { Document as XmlDocument, Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom'
import { select } from 'xpath'
import { splitTakeSuffix, type TakeKind } from '../ruleParser'
import { collapseWhitespace } from './css'

export interface XPathExtractResult {
  /** 取到的值（空串已丢弃，便于上层做 `||` 降级判定） */
  values: string[]
  /** 规则无效时的原因；正常为空 */
  error: string | null
}

/** `xpath.select` 期望的上下文节点类型（DOM 的 Node），xmldom 的自有类型需转换 */
type XPathContext = Parameters<typeof select>[1]

export function extractXpath(
  html: string,
  exprInput: string,
  takeInput: TakeKind | null = null
): XPathExtractResult {
  const { expr, take } = normalizeRule(exprInput, takeInput)
  if (expr === '') return { values: [], error: null }

  const root = toXmlTree(html)

  let raw: unknown
  try {
    raw = select(expr, root as unknown as XPathContext)
  } catch (err) {
    return { values: [], error: `XPath 无效：${messageOf(err)}` }
  }

  const items = Array.isArray(raw) ? (raw as unknown[]) : [raw]
  const values: string[] = []
  for (const item of items) {
    const value = valueOf(item, take)
    if (value !== '') values.push(value)
  }
  return { values, error: null }
}

/** 允许直接传带前缀的整条规则，并兜底切掉非标准的取值后缀 */
function normalizeRule(exprInput: string, takeInput: TakeKind | null): { expr: string; take: TakeKind | null } {
  let text = exprInput.trim()
  if (text.startsWith('@xpath:')) text = text.slice('@xpath:'.length).trim()
  if (takeInput !== null) return { expr: text, take: takeInput }
  const split = splitTakeSuffix(text)
  return { expr: split.expr.trim(), take: split.take }
}

/**
 * HTML → 可做 XPath 求值的 XML 树。
 *
 * 根节点固定是 `<ctext-root>`，其下保持 cheerio 的 `<html><head><body>` 结构，
 * 所以 `//div` 与 `/html/body/div` 都能命中。
 */
function toXmlTree(html: string): XmlElement {
  /*
   * 表格类片段必须补上下文再解析。
   *
   * `<tr>` / `<td>` 只能出现在 `<table>` 里，parse5 单独解析它们时会**整段丢掉**——
   * 于是「列表规则取到 20 个 `<tr>`」之后，每个字段规则在空树上求值，永远拿到空串。
   * XPath 书源里用 `//table//tr` 取列表是常见写法，这个坑在 M4-12 合成样本里第一次暴露。
   */
  const text = html.trim()
  const tableRow = /^<(td|th)\b/i.test(text)
  const wrapped = tableRow
    ? `<table><tbody><tr>${text}</tr></tbody></table>`
    : /^<(tr|thead|tbody|tfoot)\b/i.test(text)
      ? `<table><tbody>${text}</tbody></table>`
      : html
  const $ = load(wrapped)
  const doc = new DOMParser().parseFromString('<ctext-root/>', 'text/xml')
  const root = doc.documentElement as XmlElement
  const sourceRoot = $.root()[0] as AnyNode & { children?: AnyNode[] }
  for (const child of sourceRoot.children ?? []) appendInto(doc, root, child)
  return root
}

function appendInto(doc: XmlDocument, parent: XmlElement, node: AnyNode): void {
  const type = (node as { type?: string }).type

  if (type === 'text') {
    parent.appendChild(doc.createTextNode((node as { data: string }).data))
    return
  }
  if (type === 'comment') {
    try {
      parent.appendChild(doc.createComment((node as { data: string }).data))
    } catch {
      // 非法注释内容（如 `--`）跳过即可，不影响取值
    }
    return
  }
  // doctype / directive 不进树：XPath 里用不到，且会污染 `/` 下的层级
  if (type !== 'tag' && type !== 'script' && type !== 'style') return

  const el = node as HtmlElement
  let created: XmlElement
  try {
    created = doc.createElement(el.name)
  } catch {
    // 非法标签名（如 `<1a>`）整枝丢弃，避免坏一个节点毁掉整棵树
    return
  }
  for (const [name, value] of Object.entries(el.attribs ?? {})) {
    try {
      created.setAttribute(name, value)
    } catch {
      // 非法属性名跳过
    }
  }
  parent.appendChild(created)
  for (const child of el.children ?? []) appendInto(doc, created, child)
}

/** 单个 XPath 结果 → 字符串；取不到返回空串 */
function valueOf(item: unknown, take: TakeKind | null): string {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item.trim()
  if (typeof item === 'number') return String(item)
  if (typeof item === 'boolean') return item ? 'true' : 'false'

  const node = item as XmlNode
  switch (node.nodeType) {
    case 2: // ATTRIBUTE_NODE
      return (node as unknown as { value?: string }).value ?? ''
    case 3: // TEXT_NODE
    case 4: // CDATA_SECTION_NODE
      return readText(node, take)
    case 1: // ELEMENT_NODE
      return readElement(node as unknown as XmlElement, take)
    default:
      return ''
  }
}

function readText(node: XmlNode, take: TakeKind | null): string {
  const raw = (node as unknown as { data?: string }).data ?? ''
  return take === 'text' ? collapseWhitespace(raw) : raw.trim()
}

function readElement(el: XmlElement, take: TakeKind | null): string {
  switch (take) {
    case 'text':
      return collapseWhitespace(readTextContent(el))
    case 'ownText':
      return collapseWhitespace(ownText(el))
    case 'textNodes':
      return textNodes(el)
    case 'html':
      return serializeChildren(el)
    case 'href':
      return attribute(el, 'href')
    case 'src':
      return attribute(el, 'src')
    case 'content':
      return attribute(el, 'content')
    default:
      // 没有取值后缀 → outerHTML，供链式下一段重新 load()
      return serialize(el)
  }
}

function readTextContent(node: XmlNode): string {
  const direct = (node as unknown as { textContent?: string }).textContent
  if (typeof direct === 'string') return direct
  const parts: string[] = []
  walk(node, (child) => {
    if (child.nodeType === 3 || child.nodeType === 4) parts.push((child as unknown as { data?: string }).data ?? '')
  })
  return parts.join('')
}

/** 只看直接文本子节点（对齐 jsoup `ownText()`） */
function ownText(el: XmlElement): string {
  const parts: string[] = []
  for (const child of childrenOf(el)) {
    if (child.nodeType === 3 || child.nodeType === 4) parts.push((child as unknown as { data?: string }).data ?? '')
  }
  return parts.join('')
}

/** 所有后代文本节点，各自 trim，去掉空节点，用换行拼接 */
function textNodes(el: XmlElement): string {
  const parts: string[] = []
  walk(el, (child) => {
    if (child.nodeType !== 3 && child.nodeType !== 4) return
    const value = ((child as unknown as { data?: string }).data ?? '').trim()
    if (value !== '') parts.push(value)
  })
  return parts.join('\n')
}

function serialize(el: XmlElement): string {
  try {
    return el.toString()
  } catch {
    return ''
  }
}

function serializeChildren(el: XmlElement): string {
  return childrenOf(el)
    .map((child) => {
      try {
        return child.toString()
      } catch {
        return ''
      }
    })
    .join('')
}

function attribute(el: XmlElement, name: string): string {
  try {
    return el.getAttribute(name) ?? ''
  } catch {
    return ''
  }
}

function childrenOf(node: XmlNode): XmlNode[] {
  const list = node.childNodes as unknown as ArrayLike<XmlNode>
  const out: XmlNode[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i])
  return out
}

function walk(node: XmlNode, visit: (node: XmlNode) => void): void {
  for (const child of childrenOf(node)) {
    visit(child)
    walk(child, visit)
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
