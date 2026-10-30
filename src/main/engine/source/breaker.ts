/**
 * 书源熔断（M4-12）。
 *
 * 一条书源连续超时，多半是站点挂了、域名被墙、或者规则指向了一个已经不存在的地址。
 * 每用户每次搜索都再试一遍，代价是每次多等 8 秒，而收益是零。
 * 所以：**连续 3 次超时就临时停用 30 分钟**，冷却结束自动放行（半开重试）。
 *
 * 五处刻意的选择：
 *   1. **只对超时计数**。403/404/规则错误不算——那是「这个源坏了」，不是「这个源现在连不上」，
 *      立刻熔断只会让用户在换网之后发现源莫名其妙被停用。
 *   2. **不改 `enabled`**。`enabled` 是用户的意图，熔断是运行时的临时状态；
 *      写进同一列会让用户在设置页看到一个自己没关过的开关。
 *   3. **非超时结果清零连击**。一次 404 说明连接是通的，「连续超时」这条前提已经不成立。
 *   4. **冷却固定 30 分钟，不做指数退避**。可预测比「聪明」重要：用户看到提示里的时间，
 *      就知道什么时候能再试；指数退避会让人算不出下一次。
 *   5. **状态机是纯函数**，不碰数据库。落库由仓储负责，回归脚本可以直接断言状态迁移。
 */

/** 连续超时多少次触发熔断 */
export const BREAKER_THRESHOLD = 3
/** 冷却时长：30 分钟 */
export const BREAKER_COOLDOWN_MS = 30 * 60 * 1000

export interface BreakerState {
  /** 连续超时次数 */
  streak: number
  /** 冷却结束时间（Unix ms）；null = 未熔断 */
  until: number | null
  /** 最近一次失败原因，用于界面提示 */
  lastFailure: string | null
}

/** 库里没有这三个字段时的初值 */
export const BREAKER_IDLE: BreakerState = { streak: 0, until: null, lastFailure: null }

export interface FailureOutcome {
  ok: boolean
  /** 失败时给 `classifyFailure` 的输入 */
  code?: string | null
  message?: string | null
}

/**
 * 推进状态机。`now` 显式传入，测试才能「拨表」。
 *
 * 成功：清空连击与冷却（同时清掉 lastFailure——用户不需要知道三天前的一次超时）。
 * 超时：连击 +1，达到阈值就开冷却；冷却期内的再次超时**重置冷却起点**（站点还没恢复）。
 * 其他失败：连击清零，冷却保持原样（正在冷却时遇到 404 也不该提前放行）。
 */
export function advanceBreaker(state: BreakerState, outcome: FailureOutcome, now: number): BreakerState {
  if (outcome.ok) return { ...BREAKER_IDLE }

  const message = (outcome.message ?? '').trim()
  const isTimeout = (outcome.code ?? '') === 'E_TIMEOUT' || message.includes('超时')

  if (!isTimeout) {
    return { streak: 0, until: state.until, lastFailure: message === '' ? state.lastFailure : message }
  }

  const streak = state.streak + 1
  const lastFailure = message === '' ? '连续请求超时' : message
  if (streak < BREAKER_THRESHOLD) {
    return { streak, until: state.until, lastFailure }
  }
  return { streak, until: now + BREAKER_COOLDOWN_MS, lastFailure }
}

export function isBreakerOpen(state: BreakerState, now: number): boolean {
  return state.until !== null && state.until > now
}

/** 给界面/搜索结果用的一句话；未熔断返回 null */
export function breakerNote(state: BreakerState, now: number): string | null {
  if (!isBreakerOpen(state, now)) return null
  const at = new Date(state.until as number)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `连续 ${state.streak} 次超时，已临时停用（${hh}:${mm} 后自动恢复）`
}
