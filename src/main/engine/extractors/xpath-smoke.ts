/**
 * M4-03 自检（一）：XPath 取值器。
 *
 * 用一段固定 HTML 当「同一页面」，断言容错解析后的求值结果：
 * 元素/属性/文本节点、1-based 索引、实体解码、大小写、自闭合标签、坏表达式。
 * 不联外网、不读文件，改建树或取值逻辑时能高频跑。
 */
import type { TakeKind } from '../ruleParser'
import { extractXpath } from './xpath'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const HTML = `<!doctype html><html><body>
  <div class="wrap">
    <ul class="result-list">
      <li class="item"><h3><a href="/book/1">三体</a></h3><span class="author">刘慈欣</span><p class="intro">地球往事</p></li>
      <li class="item"><h3><a href="/book/2">沙丘</a></h3><span class="author">弗兰克</span><p class="intro">香料</p></li>
    </ul>
    <div id="content"><p>第一段</p><p>第二段</p></div>
    <div id="lines">  第一行
      第二行  </div>
    <div class="own">直接文本<span>子元素文本</span>尾巴</div>
    <div class="amp">A &amp; B &lt; C</div>
    <img class="cover" src="/img/1.jpg">
    <div class="brs">上<br>中<br>下</div>
    <div class="empty"></div>
    <DIV ID="Upper"><SPAN>大写标签</SPAN></DIV>
  </div>
</body></html>`

function pick(expr: string, take: TakeKind | null = null): string[] {
  return extractXpath(HTML, expr, take).values
}

function join(values: string[]): string {
  return values.join(' | ')
}

export function runXpathSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  try {
    // ---------------------------------------------------------------- 元素 / 属性
    const items = pick('//li')
    check('//li 命中两个列表项', items.length === 2, `count=${items.length}`)
    check('无取值后缀时返回 outerHTML', items[0]?.startsWith('<li') === true, items[0]?.slice(0, 40) ?? '空')

    check('//a/@href 取链接', join(pick('//a/@href')) === '/book/1 | /book/2', join(pick('//a/@href')))
    check('//img/@src 取图片地址', join(pick('//img/@src')) === '/img/1.jpg', join(pick('//img/@src')))
    check('//*[@class="item"] 命中两项', pick('//*[@class="item"]').length === 2)

    // ---------------------------------------------------------------- 文本节点
    check('//li//a/text() 取书名', join(pick('//li//a/text()')) === '三体 | 沙丘', join(pick('//li//a/text()')))
    check(
      '//div[@id]/p/text() 取正文段落',
      join(pick('//div[@id="content"]/p/text()')) === '第一段 | 第二段',
      join(pick('//div[@id="content"]/p/text()'))
    )
    check('//div[@class="own"]/text() 只含直接文本', join(pick('//div[@class="own"]/text()')) === '直接文本 | 尾巴', join(pick('//div[@class="own"]/text()')))

    const lines = pick('//div[@id="lines"]/text()')
    check('文本节点只 trim 首尾、保留内部换行', lines.length === 1 && lines[0].startsWith('第一行') && lines[0].includes('\n') && lines[0].endsWith('第二行'), JSON.stringify(lines))

    // ---------------------------------------------------------------- 索引 / 函数
    check('1-based 索引 //li[1]', join(pick('//li[1]//a/@href')) === '/book/1', join(pick('//li[1]//a/@href')))
    check('1-based 索引 //li[2]', join(pick('//li[2]//span/text()')) === '弗兰克', join(pick('//li[2]//span/text()')))
    check('count(//li) 返回数字', join(pick('count(//li)')) === '2', join(pick('count(//li)')))
    check('string(//h3[1]/a) 返回字符串', join(pick('string(//h3[1]/a)')) === '三体', join(pick('string(//h3[1]/a)')))

    // ---------------------------------------------------------------- 取值后缀
    check('元素 @text 折叠空白', join(pick('//div[@id="content"]', 'text')) === '第一段第二段', join(pick('//div[@id="content"]', 'text')))
    check('元素 @ownText 只取直接文本', join(pick('//div[@class="own"]', 'ownText')) === '直接文本尾巴', join(pick('//div[@class="own"]', 'ownText')))
    check(
      '元素 @textNodes 按行拼接',
      join(pick('//div[@class="brs"]', 'textNodes')) === '上\n中\n下',
      JSON.stringify(pick('//div[@class="brs"]', 'textNodes'))
    )
    check('多节点 @href 逐个取值', join(pick('//a', 'href')) === '/book/1 | /book/2', join(pick('//a', 'href')))
    check('元素 @html 取内部 HTML', pick('//div[@id="content"]', 'html')[0]?.includes('<p>第一段</p>') === true, pick('//div[@id="content"]', 'html')[0] ?? '空')
    check('规则尾部 @text 后缀运行期兜底', join(pick('//div[@id="content"]@text')) === '第一段第二段', join(pick('//div[@id="content"]@text')))
    check('带 @xpath: 前缀整条规则也能用', join(pick('@xpath://li[1]//a/text()')) === '三体', join(pick('@xpath://li[1]//a/text()')))

    // ---------------------------------------------------------------- 容错
    check('HTML 实体已解码', join(pick('//div[@class="amp"]/text()')) === 'A & B < C', join(pick('//div[@class="amp"]/text()')))
    check('大写标签/属性名可命中（按 HTML 大小写不敏感落库）', join(pick('//div[@id="Upper"]//span/text()')) === '大写标签', join(pick('//div[@id="Upper"]//span/text()')))
    check('自闭合 <br> 不破坏树结构', pick('//div[@class="brs"]/br').length === 2, `count=${pick('//div[@class="brs"]/br').length}`)
    check('空元素仍能命中', pick('//div[@class="empty"]').length === 1)

    const missing = extractXpath(HTML, '//div[@id="missing"]')
    check('取不到时返回空且不报错', missing.values.length === 0 && missing.error === null, JSON.stringify(missing))

    const broken = extractXpath(HTML, '//[bad')
    check('坏表达式报错而不抛异常', broken.error !== null && broken.values.length === 0, broken.error ?? '无错误')

    const xpath2 = extractXpath(HTML, '//div[matches(., "x")]')
    check('XPath 2.0 函数明确报错', xpath2.error !== null, xpath2.error ?? '无错误')

    const empty = extractXpath(HTML, '   ')
    check('空规则返回空', empty.values.length === 0 && empty.error === null)
  } catch (err) {
    check('自检未抛异常', false, err instanceof Error ? err.message : String(err))
  }

  return checks
}
