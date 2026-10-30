/**
 * 书源兼容性判定（M4-07）。
 *
 * 导入时做一次**静态**预检，把「能不能用」提前告诉用户，而不是等他点搜索才看到日志里的
 * 一堆 `Invalid regular expression`。三个等级的含义（写进 `book_sources.compat_level`）：
 *
 *   - `full`        四条链路的核心规则齐全，所有规则都能解析、所有正则都能编译；
 *   - `partial`     能跑但**可能缺东西**：某条规则写坏、用了白名单外的 `java.*`、
 *                   缺目录或正文规则、需要登录。导入后仍会参与搜索，失败时按源报错；
 *   - `unsupported` 跑不了：非文本类型（音频/图片/文件），或搜索/目录/正文三条全缺。
 *
 * 一条设计原则：**静态检查只报「确定坏了」，不猜「可能不兼容」**。
 * 比如 CSS 选择器不做试解析——真实书源的简写（`tag.` / `class.`）和区间语法
 * 需要真实 DOM 才谈得上对错，静态判死会把大量正常书源误标。宁可运行时再失败。
 */
import type { CompatLevel } from '@shared/dto'
import { probeJavaRegex } from '../extractors/regex'
import { JAVA_API_METHODS } from '../js/javaApi'
import { parseRule, type ParsedRule, type RuleAtom, type RuleStep } from '../ruleParser'
import { TEXT_SOURCE_TYPE, type NormalizedSource, type RuleSection } from './model'

export interface CompatIssue {
  /** 出问题的规则路径，如 `ruleToc.chapterList` */
  path: string
  reason: string
}

export interface CompatReport {
  level: CompatLevel
  /** 写进 `compat_note` 的可读原因；full 时为空数组 */
  notes: string[]
  issues: CompatIssue[]
  /** 参与检查的规则条数（含 `@put` 内层） */
  ruleCount: number
  /** 其中 JS 规则条数 */
  jsRules: number
}

/** 三条核心链路：缺任何一条，这个书源就跑不通「搜索 → 目录 → 正文」 */
const CORE_RULES: ReadonlyArray<{ path: string; section: RuleSection; key: string }> = [
  { path: 'ruleSearch.bookList', section: 'ruleSearch', key: 'bookList' },
  { path: 'ruleToc.chapterList', section: 'ruleToc', key: 'chapterList' },
  { path: 'ruleContent.content', section: 'ruleContent', key: 'content' }
]

const JAVA_CALL = /\bjava\s*\.\s*([A-Za-z_$][\w$]*)/g

export function analyzeCompat(source: NormalizedSource): CompatReport {
  const issues: CompatIssue[] = []
  const notes: string[] = []
  let ruleCount = 0
  let jsRules = 0

  const ruleOf = (section: RuleSection, key: string): string | null => source.rules[section]?.[key] ?? null

  // ---------- 1. 类型 ----------
  const nonText = source.bookSourceType !== TEXT_SOURCE_TYPE
  if (nonText) {
    notes.push(`书源类型为 ${source.bookSourceType}（音频/图片/文件），v1 仅支持文本`)
  }

  // ---------- 2. 核心链路齐全度 ----------
  const missingCore: string[] = []
  for (const core of CORE_RULES) {
    if (ruleOf(core.section, core.key) === null) missingCore.push(core.path)
  }
  // 搜索还依赖 searchUrl：没有它，规则再对也发不出请求
  const searchable = missingCore.every((p) => p !== 'ruleSearch.bookList') && source.searchUrl !== null

  if (!searchable) {
    notes.push(source.searchUrl === null ? '缺 searchUrl，无法搜索' : '缺 ruleSearch.bookList，无法解析搜索结果')
  }
  if (missingCore.includes('ruleToc.chapterList')) notes.push('缺 ruleToc.chapterList，无法取目录')
  if (missingCore.includes('ruleContent.content')) notes.push('缺 ruleContent.content，无法取正文')

  // ---------- 3. 逐条规则静态检查 ----------
  for (const section of Object.keys(source.rules) as RuleSection[]) {
    const rules = source.rules[section]
    if (rules === undefined) continue
    for (const [key, raw] of Object.entries(rules)) {
      const path = `${section}.${key}`
      const before = issues.length
      const counted = inspectRule(raw, path, issues)
      ruleCount += counted.rules
      jsRules += counted.js
      // 同一路径已经有问题就不用再记「解析失败」之外的噪声
      if (issues.length > before) continue
    }
  }

  // ---------- 4. 登录态与变量 ----------
  if (source.loginUrl !== null) {
    notes.push('书源声明了 loginUrl（需要登录），v1 不提供登录能力')
  }

  // ---------- 5. 汇总 ----------
  const allCoreMissing = !searchable && missingCore.includes('ruleToc.chapterList') && missingCore.includes('ruleContent.content')

  let level: CompatLevel
  if (nonText || allCoreMissing) {
    level = 'unsupported'
  } else if (issues.length > 0 || notes.length > 0) {
    level = 'partial'
  } else {
    level = 'full'
  }

  // 写进库里的是「原因」，不是日志：控制在 5 条以内，太长 UI 也没法展示
  const summary: string[] = []
  for (const issue of issues) summary.push(`${issue.path}：${issue.reason}`)
  for (const note of notes) summary.push(note)
  if (jsRules > 0 && level === 'full') summary.push(`含 ${jsRules} 条 JS 规则（沙箱执行）`)
  const trimmed = summary.slice(0, 5)
  if (summary.length > trimmed.length) trimmed.push(`等 ${summary.length} 项`)

  return {
    level,
    notes: level === 'full' ? [] : trimmed,
    issues,
    ruleCount,
    jsRules
  }
}

/** 检查一条规则字符串；返回它包含多少条规则 / 多少条 JS 规则 */
function inspectRule(raw: string, path: string, issues: CompatIssue[]): { rules: number; js: number } {
  let parsed: ParsedRule
  try {
    parsed = parseRule(raw, { defaultSyntax: 'regex' })
  } catch (err) {
    issues.push({ path, reason: `规则无法解析：${err instanceof Error ? err.message : String(err)}` })
    return { rules: 1, js: 0 }
  }

  let rules = 1
  let js = 0
  const visitAtom = (atom: RuleAtom, at: string): void => {
    switch (atom.type) {
      case 'regex': {
        const probe = probeJavaRegex(atom.pattern)
        if (!probe.ok) issues.push({ path: at, reason: probe.error ?? '正则不兼容' })
        break
      }
      case 'js': {
        js += 1
        const unknown = unknownJavaMethods(atom.code)
        if (unknown.length > 0) {
          issues.push({ path: at, reason: `使用了未实现的 java 方法：${unknown.join(' / ')}` })
        }
        break
      }
      case 'put': {
        if (atom.value !== null) {
          rules += 1
          for (const alt of atom.value.alternatives) {
            for (const chain of alt.chains) {
              for (const step of chain.steps) visitAtom(step.atom, `${at}@put:${atom.key}`)
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  const visitStep = (step: RuleStep, at: string): void => {
    visitAtom(step.atom, at)
    // `##正则##替换` 的 pattern 同样是 Java 正则，编译不过就取不到值
    for (const op of step.replaces) {
      const probe = probeJavaRegex(op.pattern)
      if (!probe.ok) issues.push({ path: at, reason: `替换正则不兼容：${probe.error ?? '未知原因'}` })
    }
  }

  for (const alt of parsed.alternatives) {
    for (const chain of alt.chains) {
      for (const step of chain.steps) visitStep(step, path)
    }
  }

  return { rules, js }
}

/** 扫描 JS 片段里用到的 `java.X`，挑出白名单外的。带 `java.` 前缀但动态取属性的（`java[k]`）不算 */
export function unknownJavaMethods(code: string): string[] {
  const unknown = new Set<string>()
  for (const match of code.matchAll(JAVA_CALL)) {
    const name = match[1]
    if (name === undefined) continue
    if (!JAVA_API_METHODS.includes(name)) unknown.add(name)
  }
  return [...unknown]
}
