/**
 * M4-03 自检（二）：JSONPath 取值器。
 *
 * 覆盖接口类书源的典型写法：`$.data.list[*].name`、递归 `$..x`、切片、下标、
 * 过滤表达式、对象结果转 JSON 串（供链式下一段复用），以及三类必须报错的输入：
 * 非法 JSON、括号不配平、引号未闭合。
 */
import { checkJsonPath, extractJson, normalizeJsonPath } from './json'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

const BODY = {
  code: 0,
  data: {
    total: 2,
    list: [
      { name: '三体', author: '刘慈欣', url: '/book/1', tags: ['科幻', '中国'], wordCount: 880000, free: true, intro: '' },
      { name: '沙丘', author: '弗兰克', url: '/book/2', tags: [], wordCount: 620000, free: false, intro: null }
    ]
  },
  chapters: [
    { title: '第一章', link: '/c/1' },
    { title: '第二章', link: '/c/2' }
  ]
}

function pick(expr: string, payload: unknown = BODY): string[] {
  return extractJson(payload, expr).values
}

function join(values: string[]): string {
  return values.join(' | ')
}

export function runJsonSmoke(): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    checks.push({ name, ok, detail })
  }

  try {
    // ---------------------------------------------------------------- 路径
    check('通配取数组字段', join(pick('$.data.list[*].name')) === '三体 | 沙丘', join(pick('$.data.list[*].name')))
    check('下标取值', join(pick('$.data.list[0].name')) === '三体', join(pick('$.data.list[0].name')))
    check('切片取值', join(pick('$.data.list[0:1].name')) === '三体', join(pick('$.data.list[0:1].name')))
    check('递归下降 $..name', join(pick('$..name')) === '三体 | 沙丘', join(pick('$..name')))
    check('递归下降 $..title', join(pick('$..title')) === '第一章 | 第二章', join(pick('$..title')))
    check('方括号写法', join(pick("$['data']['total']")) === '2', join(pick("$['data']['total']")))
    check('含点号的键名不被拆开', join(pick("$['data']['total']")) === '2')

    // ---------------------------------------------------------------- 类型转换
    check('数字转字符串', join(pick('$.data.total')) === '2', join(pick('$.data.total')))
    check('大整数不丢精度', join(pick('$.data.list[*].wordCount')) === '880000 | 620000', join(pick('$.data.list[*].wordCount')))
    check('布尔转字符串', join(pick('$.data.list[*].free')) === 'true | false', join(pick('$.data.list[*].free')))
    check('空串与 null 被丢弃', pick('$.data.list[*].intro').length === 0, join(pick('$.data.list[*].intro')))

    const tags = pick('$.data.list[*].tags')
    check('数组值转 JSON 串', tags.length === 2 && JSON.parse(tags[0]).join(',') === '科幻,中国' && tags[1] === '[]', join(tags))

    const item = pick('$.data.list[0]')[0]
    check('对象值转 JSON 串且可再解析', JSON.parse(item).name === '三体', item?.slice(0, 40) ?? '空')

    // ---------------------------------------------------------------- 过滤表达式
    check('过滤表达式走受限求值器', join(pick('$.data.list[?(@.wordCount>700000)].name')) === '三体', join(pick('$.data.list[?(@.wordCount>700000)].name')))

    // ---------------------------------------------------------------- 输入形态
    check('接受原始响应文本', join(pick('$.data.total', JSON.stringify(BODY))) === '2')
    check('接受已解析对象', join(pick('$.data.total', BODY)) === '2')
    check('取不到返回空且不报错', extractJson(BODY, '$.missing.path').values.length === 0 && extractJson(BODY, '$.missing.path').error === null)
    check('空规则返回空', extractJson(BODY, '  ').values.length === 0)

    // ---------------------------------------------------------------- 报错分支
    const badJson = extractJson('这里不是 JSON', '$.a')
    check('非法 JSON 报错', badJson.error === '响应不是合法 JSON', badJson.error ?? '无错误')

    const unclosed = extractJson(BODY, '$.data.list[*')
    check('方括号不配平报错（不静默返回垃圾）', unclosed.error !== null && unclosed.values.length === 0, unclosed.error ?? '无错误')

    const extra = extractJson(BODY, '$.data.list[0]]')
    check('多余右括号报错', extra.error !== null, extra.error ?? '无错误')

    const quoteOpen = extractJson(BODY, "$['data]")
    check('引号未闭合报错', quoteOpen.error !== null, quoteOpen.error ?? '无错误')

    const trailingDot = extractJson(BODY, '$.data.')
    check('以 . 结尾报错', trailingDot.error !== null, trailingDot.error ?? '无错误')

    // ---------------------------------------------------------------- 路径归一化
    check('缺 $ 前缀自动补全', normalizeJsonPath('data.list') === '$.data.list', normalizeJsonPath('data.list'))
    check('递归下降不被补坏', normalizeJsonPath('..title') === '$..title', normalizeJsonPath('..title'))
    check('已有 $ 原样保留', normalizeJsonPath('$.a') === '$.a', normalizeJsonPath('$.a'))
    check('剥掉 @json: 前缀', normalizeJsonPath('@json:$.a') === '$.a', normalizeJsonPath('@json:$.a'))
    check('合法路径预检通过', checkJsonPath("$['a.b'][0]") === null, String(checkJsonPath("$['a.b'][0]")))
    check('非 $ 开头预检失败', checkJsonPath('a.b') !== null, String(checkJsonPath('a.b')))
  } catch (err) {
    check('自检未抛异常', false, err instanceof Error ? err.message : String(err))
  }

  return checks
}
