/**
 * 同站请求节流（M4-06）。
 *
 * 对同一个人站点连续打请求是最容易被封、也最不礼貌的行为。这里按 host 做
 * **串行 + 最小间隔**：同一 host 的请求排队依次执行，两次之间至少隔
 * `minIntervalMs`；不同 host 互不影响（搜索是并发源，不能互相拖）。
 *
 * 间隔从「上一次任务结束」开始算，而不是从开始算——慢响应不会导致下一发立刻打出去。
 *
 * 默认 1000ms 对应计划里的「单域名 QPS ≤1」。注意 §7.4 已记录一处待定口径：
 * 目录分页（`nextTocUrl` 20 页）在 1000ms 间隔下必然超时，届时需要把间隔降到
 * 300ms 或对分页豁免。这里先按计划实现，间隔可配置，等口径定了只改一个默认值。
 */
export const DEFAULT_MIN_INTERVAL_MS = 1000

/** host 队列上限：书源可能很多，避免 Map 无界增长 */
const MAX_HOSTS = 128

export class HostLimiter {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly lastFinishedAt = new Map<string, number>()

  constructor(private minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS) {}

  setMinInterval(ms: number): void {
    this.minIntervalMs = Math.max(0, ms)
  }

  getMinInterval(): number {
    return this.minIntervalMs
  }

  /** 排队执行；抛错只影响本次调用，不打断同 host 的后续队列 */
  run<T>(host: string, task: () => Promise<T>): Promise<T> {
    const key = host.toLowerCase()
    const previous = this.tails.get(String(key)) ?? Promise.resolve()

    const current = previous.then(async () => {
      const last = this.lastFinishedAt.get(key) ?? 0
      const wait = this.minIntervalMs - (Date.now() - last)
      if (wait > 0) await delay(wait)
      try {
        return await task()
      } finally {
        this.lastFinishedAt.set(key, Date.now())
      }
    })

    // 队列只关心「前一个跑完了」，不关心它成功还是失败
    this.tails.set(
      key,
      current.then(
        () => undefined,
        () => undefined
      )
    )
    this.trim(key)
    return current
  }

  /** 当前排队中的 host 数，自检用 */
  size(): number {
    return this.tails.size
  }

  private trim(keep: string): void {
    if (this.tails.size <= MAX_HOSTS) return
    for (const key of this.tails.keys()) {
      if (key !== keep) {
        this.tails.delete(key)
        this.lastFinishedAt.delete(key)
        return
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
