/**
 * M4-02 自检：CSS 取值器。
 *
 * 用一段固定的 HTML 当「同一页面」，断言与 jsoup 对齐的取值语义：
 * 简写、八种取值后缀、空白折叠、实体解码、缺失属性、坏选择器。
 * 不联外网、不读文件，改选择器翻译或取值逻辑时能高频跑。
 */
import type { TakeKind } from '../ruleParser'
import { extractCss, translateLegadoSelector } from './css'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const HTML = `<!doctype html><html><body>
  <ul class="result-list">
    <li class="item"><h3><a href="/book/1">三体</a></h3><span class="author">刘慈欣</span><p class="intro">地球往事</p></li>
    <li class="item"><h3><a href="/book/2">沙丘</a></h3><span class="author">弗兰克</span><p class="intro">香料</p></li>
  </ul>
  <div id="content"><p>第一段</p><p>第二段</p></div>
  <img class="cover" src="/img/1.jpg" alt="封面">
  <meta name="description" content="一段简介">
  <div class="own">直接文本<span>子元素文本</span>尾巴</div>
  <div class="space">  多   空白
     第二行  </div>
  <a class="no-href">没有链接</a>
  <div class="amp">A &amp; B &lt; C</div>
</body></html>`

function take(expr: string, suffix: TakeKind | null): string[] {
  return extractCss(HTML, expr, suffix).values
}

function join(values: string[]): string {
  return values.join(' | ')
}

export function runCssSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  try {
    // ---------------------------------------------------------------- 简写翻译
    check(
      'class./tag./id. 简写翻译成标准选择器',
      translateLegadoSelector('class.result-list>tag.li>tag.a') === '.result-list>li>a',
      translateLegadoSelector('class.result-list>tag.li>tag.a')
    )
    check('id. 简写翻译', translateLegadoSelector('id.content p') === '#content p', translateLegadoSelector('id.content p'))
    check('不带简写时原样返回', translateLegadoSelector('.x > a') === '.x > a', translateLegadoSelector('.x > a'))

    // ---------------------------------------------------------------- 选择
    const items = take('class.item', null)
    check('class.item 命中两个列表项', items.length === 2, `count=${items.length}`)

    const tags = take('tag.li', null)
    check('tag.li 命中两个列表项', tags.length === 2, `count=${tags.length}`)

    const anchors = extractCss(HTML, 'tag.a', null)
    check(
      '无取值后缀时返回 outerHTML',
      anchors.values.length === 3 && anchors.values[0].includes('三体'),
      `count=${anchors.values.length} ${anchors.values[0] ?? '空'}`
    )

    // ---------------------------------------------------------------- 取值后缀
    check('@href 取链接', join(take('tag.a', 'href')) === '/book/1 | /book/2', join(take('tag.a', 'href')))
    check('@src 取图片地址', join(take('img.cover', 'src')) === '/img/1.jpg', join(take('img.cover', 'src')))
    check('@text 取作者名', join(take('class.author', 'text')) === '刘慈欣 | 弗兰克', join(take('class.author', 'text')))
    check(
      '@content 取 meta 内容',
      join(take('meta[name=description]', 'content')) === '一段简介',
      join(take('meta[name=description]', 'content'))
    )

    check(
      '@text 折叠连续空白',
      join(take('class.space', 'text')) === '多 空白 第二行',
      join(take('class.space', 'text'))
    )

    check(
      '@textNodes 用换行拼接并保留节点内空白',
      (() => {
        const v = take('class.space', 'textNodes')[0] ?? ''
        return v.includes('\n') && v.startsWith('多   空白')
      })(),
      JSON.stringify(take('class.space', 'textNodes')[0] ?? '')
    )

    check(
      '@ownText 只看直接文本子节点',
      join(take('class.own', 'ownText')) === '直接文本尾巴',
      join(take('class.own', 'ownText'))
    )
    check(
      '@text 递归取全部文本',
      join(take('class.own', 'text')) === '直接文本子元素文本尾巴',
      join(take('class.own', 'text'))
    )
    check(
      '@textNodes 递归取全部文本节点',
      (take('class.own', 'textNodes')[0] ?? '').split('\n').length === 3,
      JSON.stringify(take('class.own', 'textNodes')[0] ?? '')
    )

    check('@html 取 innerHTML', join(take('class.intro', 'html')) === '地球往事 | 香料', join(take('class.intro', 'html')))

    const outer = take('img.cover', 'outerHtml')[0] ?? ''
    check('@outerHtml 取 outerHTML', outer.startsWith('<img') && outer.includes('src="/img/1.jpg"'), outer)

    // ---------------------------------------------------------------- 边界
    check('缺失属性返回空并被丢弃', take('class.no-href', 'href').length === 0, JSON.stringify(take('class.no-href', 'href')))
    check('HTML 实体被解码', join(take('class.amp', 'text')) === 'A & B < C', join(take('class.amp', 'text')))
    check('空表达式返回空结果', extractCss(HTML, '   ', 'text').values.length === 0)

    const bad = extractCss(HTML, 'div[[[', 'text')
    check('坏选择器返回 error 而不是抛异常', bad.values.length === 0 && bad.error !== null, bad.error ?? '无错误')
  } catch (err) {
    check('自检执行未抛异常', false, err instanceof Error ? err.message : String(err))
  }

  return checks
}
