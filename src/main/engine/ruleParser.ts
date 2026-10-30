/**
 * 书源规则字符串解析器（M4-01）。
 *
 * 只做一件事：把一条「阅读 3.0」规则字符串拆成可执行的表达式树。
 * **不做任何提取**——不碰 DOM、不发请求、不跑 JS。取值是 M4-02~05 的活。
 *
 * 语法（v1 子集，对齐产品文档 §2.7 的支持矩阵）：
 *
 *   优先级从低到高：  `||`  →  `&&`  →  `@`  →  `##`
 *
 *   - `a || b`          降级：a 取不到才用 b（**alternatives**）
 *   - `a && b`          并列：两段结果合并（**chains**）
 *   - `a @ b`           链式：b 作用在 a 的结果上（**steps**）
 *   - `rule##re##rep`   正则替换，可连写（**replaces**）
 *
 * 前缀决定默认取值方式，作用于整条规则；单个步骤也可以用前缀覆盖：
 *   `@css:` / `@xpath:`（或 `//` 开头）/ `@json:`（或 `$.` 开头）/ `@js:` / `<js>…</js>`
 *   无前缀 → 默认按「正则」解析（URL 字段可传 `defaultSyntax: 'template'`）
 *
 * 取值后缀（仅 css）挂在选择器末尾：`@text @textNodes @ownText @href @src @html @outerHtml @content`
 *
 * 变量插值 `{{key}}` 不在这里替换，只把变量名抽出来放进 `vars`，执行期再填。
 *
 * 已知边界（刻意不做，留给后续任务，不要在这里「顺手」补）：
 *   - css 的 `!索引`、`[起:止]` 区间语法原样留在 `expr` 里，由 M4-02 的 CSS 取值器解释；
 *   - `@js:` 出现在链式中段时，其后的 `@ / && / || / ##` 仍可能被误切（整条规则以 `@js:`/`<js>` 开头时不会）；
 *   - `@put:` 的值支持嵌套规则，但嵌套深度由用户书源决定，本解析器不设上限。
 */

export type RuleSyntax = 'css' | 'xpath' | 'json' | 'js' | 'regex' | 'template'
export type SelectorSyntax = 'css' | 'xpath' | 'json'
export type TakeKind = 'text' | 'textNodes' | 'ownText' | 'href' | 'src' | 'html' | 'outerHtml' | 'content'

export interface ReplaceOp {
  pattern: string
  replacement: string
}

export type RuleAtom =
  | { type: 'selector'; syntax: SelectorSyntax; expr: string; take: TakeKind | null; vars: string[] }
  | { type: 'js'; code: string }
  | { type: 'regex'; pattern: string; vars: string[] }
  | { type: 'template'; text: string; vars: string[] }
  | { type: 'get'; key: string }
  | { type: 'put'; key: string; value: ParsedRule | null }

export interface RuleStep {
  atom: RuleAtom
  replaces: ReplaceOp[]
}

/** `@` 链式：steps 依次作用于上一步的输出 */
export interface RuleChain {
  steps: RuleStep[]
}

/** `&&` 并列：chains 的结果合并 */
export interface RuleGroup {
  chains: RuleChain[]
}

/** `||` 降级：按顺序尝试，第一个非空结果胜出 */
export interface ParsedRule {
  raw: string
  syntax: RuleSyntax
  alternatives: RuleGroup[]
}

export interface ParseOptions {
  /**
   * 无前缀规则的默认解释。
   *
   * 引擎本身默认 `regex`（M4-01 的口径：字段规则按正则，URL 字段按模板），
   * 但「阅读 3.0」的详情/目录/正文规则默认是 **CSS**——真实书源里
   * `"chapterName": "text"`、`"chapterList": "#list dd"` 都不带前缀。
   * 所以业务层（`engine/source/book.ts`）显式传 `css`。
   */
  defaultSyntax?: RuleSyntax
}

const PREFIXES: ReadonlyArray<readonly [string, RuleSyntax]> = [
  ['@css:', 'css'],
  ['@xpath:', 'xpath'],
  ['@json:', 'json'],
  ['@js:', 'js'],
  /*
   * `:` = 正则，这是「阅读 3.0」的原生写法（`":href=\"(.*?)\""`）。
   * 阅读链路的默认语法是 CSS（真实书源详情/目录/正文都不写前缀），所以正则源必须有
   * 显式前缀才能跑——M4-12 合成样本里第一版没加，四条正则源全线 `Unmatched selector`。
   */
  [':', 'regex']
]

/** 取值后缀，长名在前，避免 `@text` 抢先命中 `@textNodes` */
const TAKE_SUFFIXES: readonly TakeKind[] = [
  'textNodes',
  'outerHtml',
  'ownText',
  'content',
  'text',
  'href',
  'src',
  'html'
]

type SepFinder = (input: string, index: number, start: number) => string | null

export function parseRule(raw: string, options: ParseOptions = {}): ParsedRule {
  const defaultSyntax = options.defaultSyntax ?? 'regex'
  const trimmed = raw.trim()
  if (trimmed === '') return { raw, syntax: defaultSyntax, alternatives: [] }

  const { syntax, body } = splitPrefix(trimmed, defaultSyntax)

  // `@js:` / `<js>` 覆盖整条规则：JS 里的 `@ && || ##` 不做切分
  if (syntax === 'js') {
    let code = body
    const open = body.indexOf('<js>')
    const close = body.lastIndexOf('</js>')
    if (open >= 0 && close > open) code = body.slice(open + 4, close)
    return {
      raw,
      syntax,
      alternatives: [{ chains: [{ steps: [{ atom: { type: 'js', code: code.trim() }, replaces: [] }] }] }]
    }
  }

  const alternatives = splitAt(body, (input, i) => (input.startsWith('||', i) ? '||' : null))
    .map((alt) => alt.trim())
    .filter((alt) => alt.length > 0)
    .map((alt) => {
      /*
       * 每个 `||` 分支各自判语法。
       *
       * 「阅读 3.0」里跨语法降级很常见：`:正则||.css`、`$.a||$.b`。整条规则只在开头
       * 剥一次前缀的话，第二个分支的 `:` / `$.` 会被当成模式的一部分，永远取不到值
       * （M4-12 合成样本 r3 就是这么暴露的）。
       */
      const split = splitPrefix(alt, syntax)
      return {
        chains: splitAt(split.body, (input, i) => (input.startsWith('&&', i) ? '&&' : null))
          .map((group) => group.trim())
          .filter((group) => group.length > 0)
          .map((group) => ({ steps: parseChain(group, split.syntax) }))
      }
    })

  return { raw, syntax, alternatives }
}

function splitPrefix(input: string, fallback: RuleSyntax): { syntax: RuleSyntax; body: string } {
  for (const [prefix, syntax] of PREFIXES) {
    if (input.startsWith(prefix)) return { syntax, body: input.slice(prefix.length) }
  }
  if (input.startsWith('<js>')) return { syntax: 'js', body: input }
  if (input.startsWith('//')) return { syntax: 'xpath', body: input }
  if (input.startsWith('$.')) return { syntax: 'json', body: input }
  return { syntax: fallback, body: input }
}

function parseChain(group: string, syntax: RuleSyntax): RuleStep[] {
  return splitAt(group, chainSeparator, true)
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
    .map((step) => parseStep(step, syntax))
}

function chainSeparator(input: string, index: number, start: number): string | null {
  if (input[index] !== '@') return null
  // 步骤开头的 `@` 是指令前缀（@css:/@get:…），不是分隔符
  if (input.slice(start, index).trim() === '') return null
  // 选择器末尾的 `@text` 之类是取值后缀，不是分隔符
  if (isTakeSuffix(input, index)) return null
  return '@'
}

function parseStep(step: string, ruleSyntax: RuleSyntax): RuleStep {
  let text = step.trim()
  let syntax: RuleSyntax = ruleSyntax

  if (text.startsWith('@')) {
    if (text.startsWith('@get:')) return { atom: parseGet(text.slice('@get:'.length)), replaces: [] }
    if (text.startsWith('@put:')) return { atom: parsePut(text.slice('@put:'.length)), replaces: [] }
    if (text.startsWith('@css:')) {
      syntax = 'css'
      text = text.slice('@css:'.length)
    } else if (text.startsWith('@xpath:')) {
      syntax = 'xpath'
      text = text.slice('@xpath:'.length)
    } else if (text.startsWith('@json:')) {
      syntax = 'json'
      text = text.slice('@json:'.length)
    } else if (text.startsWith('@js:')) {
      return { atom: { type: 'js', code: text.slice('@js:'.length).trim() }, replaces: [] }
    } else {
      // 链式分隔符被保留下来时，这里去掉它
      text = text.slice(1)
    }
  }

  const pieces = splitAt(text, (input, i) => (input.startsWith('##', i) ? '##' : null))
  const head = pieces[0].trim()

  const replaces: ReplaceOp[] = []
  for (let i = 1; i + 1 < pieces.length; i += 2) {
    replaces.push({ pattern: pieces[i], replacement: pieces[i + 1] ?? '' })
  }
  if ((pieces.length - 1) % 2 === 1) {
    replaces.push({ pattern: pieces[pieces.length - 1], replacement: '' })
  }

  return { atom: buildAtom(head, syntax), replaces }
}

function buildAtom(head: string, syntax: RuleSyntax): RuleAtom {
  if (syntax === 'js') return { type: 'js', code: head }
  if (syntax === 'css') {
    const { expr, take } = splitTakeSuffix(head)
    return { type: 'selector', syntax: 'css', expr, take, vars: extractVars(expr) }
  }
  if (syntax === 'xpath') return { type: 'selector', syntax: 'xpath', expr: head, take: null, vars: extractVars(head) }
  if (syntax === 'json') return { type: 'selector', syntax: 'json', expr: head, take: null, vars: extractVars(head) }
  if (syntax === 'template') return { type: 'template', text: head, vars: extractVars(head) }
  return { type: 'regex', pattern: head, vars: extractVars(head) }
}

function parseGet(inner: string): RuleAtom {
  return { type: 'get', key: unbrace(inner).trim() }
}

function parsePut(inner: string): RuleAtom {
  const body = unbrace(inner)
  const colon = body.indexOf(':')
  if (colon < 0) return { type: 'put', key: body.trim(), value: null }
  const key = body.slice(0, colon).trim()
  const ruleText = body.slice(colon + 1)
  return { type: 'put', key, value: ruleText.trim() === '' ? null : parseRule(ruleText) }
}

function unbrace(input: string): string {
  const text = input.trim()
  if (text.startsWith('{') && text.endsWith('}')) return text.slice(1, -1)
  return text
}

/**
 * 把选择器末尾的 `@text` 之类取值后缀切下来。
 *
 * css 在 `buildAtom` 里就用它做分割；xpath 的取值后缀不在解析期剥（真实书源里
 * `@xpath:…` 后面跟 `@text` 属于非标准写法），由 M4-03 的取值器在运行期兜底调用。
 */
export function splitTakeSuffix(expr: string): { expr: string; take: TakeKind | null } {
  const match = /@([a-zA-Z]+)\s*$/.exec(expr)
  if (match) {
    const name = match[1] as TakeKind
    // 紧跟在 `/` 后面的 `@xxx` 是 XPath 属性轴（`//a/@href`），不是取值后缀
    const before = match.index > 0 ? expr[match.index - 1] : ''
    if (before !== '/' && TAKE_SUFFIXES.includes(name)) {
      return { expr: expr.slice(0, match.index).trim(), take: name }
    }
  }
  return { expr, take: null }
}

function isTakeSuffix(input: string, at: number): boolean {
  if (input[at] !== '@') return false
  const rest = input.slice(at + 1)
  for (const name of TAKE_SUFFIXES) {
    if (!rest.startsWith(name)) continue
    const after = rest[name.length]
    // 后缀后必须是分隔边界或结尾；`@textNodes` 之后的 `@` 也算边界
    if (after === undefined || after === '@' || after === '&' || after === '|' || after === '#' || /\s/.test(after)) {
      return true
    }
  }
  return false
}

function extractVars(text: string): string[] {
  const vars: string[] = []
  const re = /\{\{\s*([\w.$]+)\s*\}\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (!vars.includes(match[1])) vars.push(match[1])
  }
  return vars
}

/**
 * 按顶层分隔符切分：括号、方括号、花括号、引号、`<js>…</js>` 内部都不切。
 * `keepSep` 为真时把分隔符留在下一段开头（链式 `@` 需要它来判断指令前缀）。
 */
function splitAt(input: string, find: SepFinder, keepSep = false): string[] {
  const parts: string[] = []
  let start = 0
  let i = 0
  let paren = 0
  let bracket = 0
  let brace = 0
  let quote: string | null = null
  let js = false

  while (i < input.length) {
    const ch = input[i]

    if (js) {
      if (input.startsWith('</js>', i)) {
        i += '</js>'.length
        js = false
        continue
      }
      i++
      continue
    }
    if (quote) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (input.startsWith('<js>', i)) {
      js = true
      i += '<js>'.length
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i++
      continue
    }
    if (ch === '(') {
      paren++
      i++
      continue
    }
    if (ch === ')') {
      paren = Math.max(0, paren - 1)
      i++
      continue
    }
    if (ch === '[') {
      bracket++
      i++
      continue
    }
    if (ch === ']') {
      bracket = Math.max(0, bracket - 1)
      i++
      continue
    }
    if (ch === '{') {
      brace++
      i++
      continue
    }
    if (ch === '}') {
      brace = Math.max(0, brace - 1)
      i++
      continue
    }

    if (paren === 0 && bracket === 0 && brace === 0) {
      const sep = find(input, i, start)
      if (sep) {
        parts.push(input.slice(start, i))
        start = keepSep ? i : i + sep.length
        i += sep.length
        continue
      }
    }
    i++
  }

  parts.push(input.slice(start))
  return parts
}
