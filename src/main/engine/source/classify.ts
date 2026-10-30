/**
 * 失败归类（M4-12）。
 *
 * 一次书源回归会产出几十条失败，如果只给「失败」两个字，修复工作就变成了逐个点开看日志。
 * 这里把错误码 + 文案 + HTTP 状态收敛成**有限的几类**，每类带一句「下一步查什么」：
 *
 *   - `timeout`    请求超时（可重试，且是熔断的唯一计数项）
 *   - `network`    DNS / 连接被拒 / TLS / 代理，站点或网络问题，不是规则问题
 *   - `http`       4xx/5xx，按状态再细分（403 多为防盗链/UA，404 多为改版或书被删）
 *   - `encoding`   解码后仍是乱码，站点声明与实际编码不一致
 *   - `rule`       规则本身的问题：选择器无效、正则编译失败、JS 抛错
 *   - `empty`      请求成功、规则也没报错，但取不到值——通常是站点改版
 *   - `unsupported` 非文本源 / 记录坏了 / 缺核心规则，修不好，只能换源
 *   - `breaker`    被熔断跳过（本次没发请求）
 *
 * **只做归类，不做决策**。哪些类计入熔断、哪些类要提示用户，由调用方决定：
 * 归类一旦掺进策略，回归报告和运行时行为就会各说各话。
 */

export type FailureKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'encoding'
  | 'rule'
  | 'empty'
  | 'unsupported'
  | 'breaker'
  | 'unknown'

export interface FailureClass {
  kind: FailureKind
  /** 报告里显示的短标签 */
  label: string
  /** 给用户/开发者的下一步提示 */
  hint: string
  /** 换个时间重试有没有意义 */
  retriable: boolean
}

const CLASSES: Record<FailureKind, Omit<FailureClass, 'kind'>> = {
  timeout: {
    label: '超时',
    hint: '站点响应慢或被限速；确认是否需要代理、是否把同站间隔调大',
    retriable: true
  },
  network: {
    label: '网络不可达',
    hint: 'DNS 解析失败 / 连接被拒 / TLS 握手失败；先确认站点是否可直连',
    retriable: true
  },
  http: {
    label: 'HTTP 错误',
    hint: '看状态码：403 多为防盗链或 UA，404 多为改版，5xx 是站点故障',
    retriable: true
  },
  encoding: {
    label: '编码异常',
    hint: '站点声明的编码与实际不符；需要按响应头/正文探测重新判定',
    retriable: false
  },
  rule: {
    label: '规则错误',
    hint: '选择器/正则/JS 本身有问题；用规则调试面板逐段看中间结果',
    retriable: false
  },
  empty: {
    label: '取不到内容',
    hint: '请求成功但字段为空；站点改版或规则过期，需要对照页面重写规则',
    retriable: false
  },
  unsupported: {
    label: '不支持',
    hint: '非文本源、记录损坏或缺核心规则；v1 无法修复，建议换源',
    retriable: false
  },
  breaker: {
    label: '已熔断',
    hint: '连续超时被临时停用；等冷却结束或手动恢复后重试',
    retriable: true
  },
  unknown: {
    label: '未知',
    hint: '没有匹配到已知模式；保留原始错误码/文案待人工判断',
    retriable: true
  }
}

export interface FailureInput {
  /** 引擎错误码（`E_TIMEOUT` / `E_HTTP` / …）或 undici 的系统码 */
  code?: string | null
  message?: string | null
  /** HTTP 状态码，请求层有就直接给，比从文案里抠可靠 */
  status?: number | null
}

/** undici / Node 的网络类错误码：这些都不是书源规则的问题 */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT'
])

const TIMEOUT_CODES = new Set(['E_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/** 规则类错误的文案特征。引擎自身的报错都带固定前缀，按前缀判比按关键词判稳 */
const RULE_HINTS = ['选择器无效', '规则无法解析', '正则', '语法错误', '规则', '不兼容', 'JS ']

export function classifyFailure(input: FailureInput): FailureClass {
  const code = (input.code ?? '').trim()
  const message = input.message ?? ''
  const status = input.status ?? null

  const make = (kind: FailureKind): FailureClass => ({ kind, ...CLASSES[kind] })

  if (code === 'E_BREAKER') return make('breaker')
  if (TIMEOUT_CODES.has(code) || message.includes('超时')) return make('timeout')
  if (code === 'E_HTTP' || (status !== null && status >= 400)) {
    const base = make('http')
    if (status === 403 || status === 401 || message.includes('HTTP 403')) {
      return { ...base, hint: '站点拒绝访问：先看是否需要 UA/Referer/Cookie，或该源已下架' }
    }
    if (status === 404 || message.includes('HTTP 404')) {
      return { ...base, hint: '地址 404：站点改版或该书已删除，规则里的路径要跟着改', retriable: false }
    }
    if (status === 429 || message.includes('HTTP 429')) {
      return { ...base, hint: '被限流：调大该源的同站间隔，或稍后再试' }
    }
    return base
  }
  if (NETWORK_CODES.has(code)) return make('network')
  if (code === 'E_BAD_RECORD' || code === 'E_UNSUPPORTED' || code === 'E_NO_RULE') return make('unsupported')
  if (code === 'E_EMPTY_TOC' || code === 'E_EMPTY_CONTENT') return make('empty')
  if (code === 'E_RULE' || code === 'E_BAD_URL') return make('rule')
  if (code === 'E_ENCODING' || message.includes('乱码') || message.includes('解码')) return make('encoding')
  if (code === 'E_REQUEST') return make('network')
  if (RULE_HINTS.some((hint) => message.includes(hint))) return make('rule')
  return make('unknown')
}

/** 报告用的聚合：按类别计数，顺序固定（不随出现顺序抖动） */
export type FailureTally = Record<FailureKind, number>

export function emptyTally(): FailureTally {
  return {
    timeout: 0,
    network: 0,
    http: 0,
    encoding: 0,
    rule: 0,
    empty: 0,
    unsupported: 0,
    breaker: 0,
    unknown: 0
  }
}

export function tally(tallyState: FailureTally, failure: FailureClass): void {
  tallyState[failure.kind] += 1
}
