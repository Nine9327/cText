/**
 * M4-04 自检：正则取值器。
 *
 * 两段：① Java→JS 的语法翻译（`(?i)`/`\p{Han}`/`\Q…\E`/占有量词/原子组）；
 * ② 取值语义（第 1 捕获组、全量匹配、坏规则标记不兼容而不抛）。
 * 固定输入，不联外网，改翻译规则时能高频跑。
 */
import { applyReplaces, extractRegex, translateJavaRegex } from './regex'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const LIST_HTML = `<ul>
  <li><a href="/book/1">三体</a><span>刘慈欣</span></li>
  <li><a href="/book/2">沙丘</a><span>弗兰克</span></li>
</ul>`

const JSON_TEXT = `{"code":0,"data":[{"name":"三体","author":"刘慈欣"},{"name":"沙丘","author":"弗兰克"}]}`

function pick(text: string, pattern: string): string[] {
  return extractRegex(text, pattern).values
}

function join(values: string[]): string {
  return values.join(' | ')
}

export function runRegexSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  try {
    // ---------------------------------------------------------------- 语法翻译
    const inline = translateJavaRegex('(?i)abc')
    check('(?i) 提取成 JS flag', inline.source === 'abc' && inline.flags === 'i', `${inline.source} / ${inline.flags}`)

    const multiFlag = translateJavaRegex('(?is)a.b')
    check('(?is) 多 flag 都提取', multiFlag.source === 'a.b' && multiFlag.flags.includes('i') && multiFlag.flags.includes('s'), multiFlag.flags)

    const han = translateJavaRegex('\\p{Han}+')
    check('\\p{Han} 转 Script=Han 并加 u', han.source === '\\p{Script=Han}+' && han.flags.includes('u'), `${han.source} / ${han.flags}`)

    const isHan = translateJavaRegex('\\p{IsHan}')
    check('\\p{IsHan} 转 Script=Han', isHan.source === '\\p{Script=Han}', isHan.source)

    const general = translateJavaRegex('\\p{L}')
    check('\\p{L} 保持通用类别', general.source === '\\p{L}' && general.flags.includes('u'), general.source)

    const posix = translateJavaRegex('\\p{Alpha}')
    check('\\p{Alpha} 归一成 \\p{L}', posix.source === '\\p{L}', posix.source)

    const script = translateJavaRegex('\\p{sc=Han}')
    check('\\p{sc=Han} 转 Script=Han', script.source === '\\p{Script=Han}', script.source)

    const quoted = translateJavaRegex('\\Q1+1\\E')
    check('\\Q…\\E 逐字符转义', quoted.source === '1\\+1', quoted.source)

    const possessive = translateJavaRegex('a*+b')
    check('占有量词去 +', possessive.source === 'a*b', possessive.source)

    const atomic = translateJavaRegex('(?>ab)c')
    check('原子组转非捕获组', atomic.source === '(?:ab)c', atomic.source)

    const lineBreak = translateJavaRegex('a\\Rb')
    check('\\R 转等价换行组', lineBreak.source.startsWith('a(?:\\r\\n|['), lineBreak.source)

    const anchors = translateJavaRegex('\\Afoo\\z')
    check('\\A/\\z 转 ^/$', anchors.source === '^foo$', anchors.source)

    check('翻译会记录改动说明（供调试面板）', translateJavaRegex('(?i)\\p{Han}').notes.length >= 2, String(translateJavaRegex('(?i)\\p{Han}').notes.length))

    // ---------------------------------------------------------------- 取值语义
    check(
      '第 1 捕获组提取书名',
      join(pick(JSON_TEXT, '"name":\\s*"([^"]*)"')) === '三体 | 沙丘',
      join(pick(JSON_TEXT, '"name":\\s*"([^"]*)"'))
    )
    check('无捕获组取整个匹配', join(pick('a1b22', '\\d+')) === '1 | 22', join(pick('a1b22', '\\d+')))
    check('多个捕获组只取第 1 组', join(pick('1-2 3-4', '(\\d+)-(\\d+)')) === '1 | 3', join(pick('1-2 3-4', '(\\d+)-(\\d+)')))
    check('(?i) 实际生效', join(pick('abc ABC', '(?i)ABC')) === 'abc | ABC', join(pick('abc ABC', '(?i)ABC')))
    check('中文脚本类可用', join(pick('abc三体def', '\\p{Han}+')) === '三体', join(pick('abc三体def', '\\p{Han}+')))
    check('\\Q…\\E 字面量可匹配', join(pick('x1+1y', '\\Q1+1\\E')) === '1+1', join(pick('x1+1y', '\\Q1+1\\E')))
    check('\\R 能跨行匹配', join(pick('a\nb', 'a\\Rb')) === 'a\nb', JSON.stringify(pick('a\nb', 'a\\Rb')))
    check(
      '(?s) 让 . 跨行取正文',
      pick('<div id="content">\n第一段\n第二段\n</div>', '(?s)<div id="content">(.*?)</div>')[0]?.includes('第二段') === true,
      JSON.stringify(pick('<div id="content">\n第一段\n第二段\n</div>', '(?s)<div id="content">(.*?)</div>'))
    )
    check(
      '命名分组同样取第 1 组',
      join(pick('<h1>三体</h1>', '<h1>(?<title>[^<]+)</h1>')) === '三体',
      join(pick('<h1>三体</h1>', '<h1>(?<title>[^<]+)</h1>'))
    )
    check('列表页取全部链接', join(pick(LIST_HTML, 'href="([^"]+)"')) === '/book/1 | /book/2', join(pick(LIST_HTML, 'href="([^"]+)"')))
    check('纯空白结果被丢弃', pick('   ', '\\s+').length === 0)
    check('空文本返回空', pick('', '\\d+').length === 0)
    check('空规则返回空', pick('abc', '   ').length === 0)

    // ---------------------------------------------------------------- 不兼容标记
    const broken = extractRegex('abc', '[unclosed')
    check('编译失败标记不兼容且不抛', broken.compatible === false && broken.error !== null && broken.values.length === 0, broken.error ?? '无错误')

    const midFlag = extractRegex('ab', 'a(?i)b')
    check('中段内联 flag 判为不兼容', midFlag.compatible === false, midFlag.error ?? '无错误')

    const okRule = extractRegex('abc', 'a(b)c')
    check('正常规则 compatible 为 true', okRule.compatible === true && okRule.error === null, join(okRule.values))

    // ---------------------------------------------------------------- ## 替换
    const trimmed = applyReplaces('三体 第一部', [{ pattern: '\\s+', replacement: '' }])
    check('## 替换去掉空白', trimmed.value === '三体第一部' && trimmed.errors.length === 0, trimmed.value)

    // 注意：Java 与 JS 的 `\w` 都是 ASCII 语义，中文字段要用 `.+?` 而不是 `\w+`
    const swapped = applyReplaces('刘慈欣-三体', [{ pattern: '(.+?)-(.+)', replacement: '$2$1' }])
    check('## 替换支持 $1 分组引用', swapped.value === '三体刘慈欣', swapped.value)

    const chained = applyReplaces('《三体》', [
      { pattern: '《', replacement: '' },
      { pattern: '》', replacement: '' }
    ])
    check('## 替换可连写', chained.value === '三体', chained.value)

    const badReplace = applyReplaces('abc', [{ pattern: '[', replacement: 'x' }])
    check('坏替换规则保留原值并记录错误', badReplace.value === 'abc' && badReplace.errors.length === 1, badReplace.value)

    const noOps = applyReplaces('abc', [])
    check('无替换时原样返回', noOps.value === 'abc', noOps.value)
  } catch (err) {
    check('自检未抛异常', false, err instanceof Error ? err.message : String(err))
  }

  return checks
}
