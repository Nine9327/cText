/**
 * M4-01 自检：书源规则解析器。
 *
 * 纯主进程，不碰网络 / DB / DOM，改解析器时能高频跑。
 * 断言覆盖 §2.7 支持矩阵里 v1 承诺的每一类语法，重点是那几个「看着像分隔符
 * 其实不是」的地方：`@text` 后缀 vs `@` 链式、`@href` 在 xpath 里是属性、
 * `&&`/`||`/`##` 落在引号或括号里不能被切。
 */
import { parseRule, type ParsedRule, type RuleAtom, type RuleStep } from './ruleParser'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

function firstStep(rule: ParsedRule): RuleStep | undefined {
  return rule.alternatives[0]?.chains[0]?.steps[0]
}

function atomOf(raw: string, options?: Parameters<typeof parseRule>[1]): RuleAtom | undefined {
  return firstStep(parseRule(raw, options))?.atom
}

function describe(atom: RuleAtom | undefined): string {
  return atom ? JSON.stringify(atom) : 'undefined'
}

function isSelector(atom: RuleAtom | undefined): atom is Extract<RuleAtom, { type: 'selector' }> {
  return atom?.type === 'selector'
}

export function runRuleParserSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  try {
    // ---------------------------------------------------------------- 前缀
    const css = atomOf('@css:.result-list>li')
    check(
      '@css: 识别为 CSS 选择器',
      isSelector(css) && css.syntax === 'css' && css.expr === '.result-list>li' && css.take === null,
      describe(css)
    )

    const shorthand = atomOf('@css:tag.a')
    check('CSS 的 tag. 简写原样保留', isSelector(shorthand) && shorthand.expr === 'tag.a', describe(shorthand))

    const xpath = atomOf('@xpath://div[@class="x"]//a/@href')
    check(
      '@xpath: 识别为 XPath，且 @href 作为属性保留',
      isSelector(xpath) && xpath.syntax === 'xpath' && xpath.expr === '//div[@class="x"]//a/@href' && xpath.take === null,
      describe(xpath)
    )

    const xpathShort = parseRule('//div//a')
    check(
      '// 开头等价于 @xpath:',
      xpathShort.syntax === 'xpath' && isSelector(firstStep(xpathShort)?.atom),
      xpathShort.syntax
    )

    const json = atomOf('@json:$.data.list[*].name')
    check(
      '@json: 识别为 JSONPath',
      isSelector(json) && json.syntax === 'json' && json.expr === '$.data.list[*].name',
      describe(json)
    )

    const jsonShort = parseRule('$.data.name')
    check('$. 开头等价于 @json:', jsonShort.syntax === 'json', jsonShort.syntax)

    const js = atomOf('@js:result.match(/\\d+/)')
    check('@js: 整条规则作为 JS', js?.type === 'js' && js.code === 'result.match(/\\d+/)', describe(js))

    const jsTag = atomOf('<js>java.ajax(url)</js>')
    check('<js> 包裹识别为 JS 且去掉标签', jsTag?.type === 'js' && jsTag.code === 'java.ajax(url)', describe(jsTag))

    const jsTagGuard = atomOf('<js>a && b</js>')
    check('<js> 内部的 && 不被切分', jsTagGuard?.type === 'js' && jsTagGuard.code === 'a && b', describe(jsTagGuard))

    const jsAt = atomOf('@js:java.ajax("http://x/@y")')
    check('@js: 内部的 @ 不被切分', jsAt?.type === 'js' && jsAt.code === 'java.ajax("http://x/@y")', describe(jsAt))

    const regex = atomOf('\\d+章')
    check('无前缀按正则解析', regex?.type === 'regex' && regex.pattern === '\\d+章', describe(regex))

    // ---------------------------------------------------------------- 取值后缀
    const takeText = atomOf('@css:.title@text')
    check('@text 取值后缀', isSelector(takeText) && takeText.expr === '.title' && takeText.take === 'text', describe(takeText))

    const takeSrc = atomOf('@css:img@src')
    check('@src 取值后缀', isSelector(takeSrc) && takeSrc.expr === 'img' && takeSrc.take === 'src', describe(takeSrc))

    const takeNodes = atomOf('@css:#content@textNodes')
    check('@textNodes 不被 @text 抢先匹配', isSelector(takeNodes) && takeNodes.take === 'textNodes', describe(takeNodes))

    const takeHtml = atomOf('@css:.a@html')
    check('@html 取值后缀', isSelector(takeHtml) && takeHtml.take === 'html', describe(takeHtml))

    const takeOuter = atomOf('@css:.a@outerHtml')
    check('@outerHtml 取值后缀', isSelector(takeOuter) && takeOuter.take === 'outerHtml', describe(takeOuter))

    const xpathHref = atomOf('@xpath://a/@href')
    check(
      'XPath 的 @href 不被当取值后缀剥掉',
      isSelector(xpathHref) && xpathHref.expr === '//a/@href' && xpathHref.take === null,
      describe(xpathHref)
    )

    // ---------------------------------------------------------------- 链式 @
    const chain = parseRule('@css:.list@tag.li@tag.a@text')
    const chainSteps = chain.alternatives[0]?.chains[0]?.steps ?? []
    check(
      '链式 @ 切成三步（@text 不算分隔符）',
      chainSteps.length === 3 &&
        isSelector(chainSteps[0]?.atom) &&
        chainSteps[0].atom.expr === '.list' &&
        isSelector(chainSteps[1]?.atom) &&
        chainSteps[1].atom.expr === 'tag.li' &&
        isSelector(chainSteps[2]?.atom) &&
        chainSteps[2].atom.expr === 'tag.a' &&
        chainSteps[2].atom.take === 'text',
      chainSteps.map((s) => describe(s.atom)).join(' -> ')
    )

    const chainMidTake = parseRule('@css:.a@text@tag.b')
    const midSteps = chainMidTake.alternatives[0]?.chains[0]?.steps ?? []
    check(
      '链式中间步骤的取值后缀不拆步',
      midSteps.length === 2 && isSelector(midSteps[0]?.atom) && midSteps[0].atom.take === 'text' && isSelector(midSteps[1]?.atom) && midSteps[1].atom.expr === 'tag.b',
      midSteps.map((s) => describe(s.atom)).join(' -> ')
    )

    // ---------------------------------------------------------------- && / ||
    const union = parseRule('@css:.a@text && @css:.b@text')
    check(
      '&& 并列合并为两组',
      union.alternatives.length === 1 && union.alternatives[0].chains.length === 2,
      `alternatives=${union.alternatives.length} chains=${union.alternatives[0]?.chains.length}`
    )

    const fallback = parseRule('@css:.a@text || @css:.b@text')
    check(
      '|| 降级拆成两个备选',
      fallback.alternatives.length === 2,
      `alternatives=${fallback.alternatives.length}`
    )

    const precedence = parseRule('@css:.a && .b@tag.i || .c')
    check(
      '优先级：@ 紧于 &&，&& 紧于 ||',
      precedence.alternatives.length === 2 &&
        precedence.alternatives[0].chains.length === 2 &&
        precedence.alternatives[0].chains[1].steps.length === 2 &&
        precedence.alternatives[1].chains.length === 1,
      `alt=${precedence.alternatives.length} alt0.chains=${precedence.alternatives[0]?.chains.length}`
    )

    const precedence2 = parseRule('@css:a@b && c')
    check(
      '链式优先于并列',
      precedence2.alternatives[0]?.chains.length === 2 &&
        precedence2.alternatives[0].chains[0].steps.length === 2,
      `chains=${precedence2.alternatives[0]?.chains.length}`
    )

    const spaced = parseRule('@css:.a  ||   @css:.b')
    check('分隔符两侧空白被裁掉', spaced.alternatives.length === 2, `alternatives=${spaced.alternatives.length}`)

    // ---------------------------------------------------------------- ## 替换
    const replace = firstStep(parseRule('@css:.a@text##第(\\d+)章##第$1节'))
    check(
      '## 正则替换解析为 pattern/replacement',
      isSelector(replace?.atom) &&
        replace.atom.expr === '.a' &&
        replace.atom.take === 'text' &&
        replace.replaces.length === 1 &&
        replace.replaces[0].pattern === '第(\\d+)章' &&
        replace.replaces[0].replacement === '第$1节',
      JSON.stringify(replace)
    )

    const multiReplace = firstStep(parseRule('@css:.a##x##y##z##w'))
    check(
      '多个 ## 替换成对出现',
      multiReplace?.replaces.length === 2 &&
        multiReplace.replaces[0].pattern === 'x' &&
        multiReplace.replaces[0].replacement === 'y' &&
        multiReplace.replaces[1].pattern === 'z' &&
        multiReplace.replaces[1].replacement === 'w',
      JSON.stringify(multiReplace?.replaces)
    )

    const hashInQuote = firstStep(parseRule('@css:.a[title="##"]'))
    check(
      '引号内的 ## 不被当替换分隔符',
      isSelector(hashInQuote?.atom) && hashInQuote.atom.expr === '.a[title="##"]' && hashInQuote.replaces.length === 0,
      JSON.stringify(hashInQuote)
    )

    // ---------------------------------------------------------------- {{}} 插值
    const template = atomOf('/search?q={{key}}&page={{page}}', { defaultSyntax: 'template' })
    check(
      '模板抽出 {{key}}/{{page}} 变量',
      template?.type === 'template' &&
        template.text === '/search?q={{key}}&page={{page}}' &&
        template.vars.join(',') === 'key,page',
      describe(template)
    )

    const templateDedupe = atomOf('{{key}}/{{key}}', { defaultSyntax: 'template' })
    check(
      '重复变量只保留一次',
      templateDedupe?.type === 'template' && templateDedupe.vars.join(',') === 'key',
      describe(templateDedupe)
    )

    const regexVars = atomOf('{{baseUrl}}/b/{{id}}')
    check(
      '正则规则同样抽取插值变量',
      regexVars?.type === 'regex' && regexVars.vars.join(',') === 'baseUrl,id',
      describe(regexVars)
    )

    const pipeInQuote = parseRule('@json:$.a[?(@.b==\'x||y\')]')
    check(
      '括号与引号内的 || 不被切分',
      pipeInQuote.alternatives.length === 1 && isSelector(firstStep(pipeInQuote)?.atom),
      `alternatives=${pipeInQuote.alternatives.length}`
    )

    // ---------------------------------------------------------------- @put / @get
    const get = atomOf('@get:{k}')
    check('@get:{key} 解析为取值变量', get?.type === 'get' && get.key === 'k', describe(get))

    const put = atomOf('@put:{k:@css:.a@text}')
    const putValueStep = put?.type === 'put' ? put.value?.alternatives[0]?.chains[0]?.steps[0] : undefined
    check(
      '@put:{key:rule} 解析并递归解析内层规则',
      put?.type === 'put' &&
        put.key === 'k' &&
        put.value !== null &&
        isSelector(putValueStep?.atom) &&
        putValueStep.atom.expr === '.a' &&
        putValueStep.atom.take === 'text',
      describe(put)
    )

    // ---------------------------------------------------------------- 边界
    const empty = parseRule('   ')
    check('空规则产出空备选', empty.alternatives.length === 0, `alternatives=${empty.alternatives.length}`)

    const bare = atomOf('   @css:.a   ')
    check('规则首尾空白被裁掉', isSelector(bare) && bare.expr === '.a', describe(bare))
  } catch (err) {
    check('解析自检未抛异常', false, err instanceof Error ? err.message : String(err))
  }

  return checks
}
