/**
 * 纯界面偏好：侧栏是否折叠、各分区是否展开。
 *
 * 与 library store 分开的原因：这些只影响渲染层布局，不参与任何查询；
 * 放 localStorage 而不是数据库，是因为写库要走 IPC 往返，而折叠一次侧栏
 * 立刻就得看到效果。M1 之后「书籍视图偏好（封面/详细/列表）」会进 settings 表，
 * 那是业务数据；这里这些留在本地（计划 §3.8）。
 *
 * localStorage 读写全部兜底：隐私模式 / 配额满 / 被策略禁用时不该让界面炸掉。
 */
import { reactive, watch } from 'vue'
import { defineStore } from 'pinia'

const STORAGE_KEY = 'ctext.ui.v1'

export type SectionKey = 'shelves' | 'sources'

interface UiState {
  sidebarCollapsed: boolean
  sections: Record<SectionKey, boolean>
}

const defaults: UiState = {
  sidebarCollapsed: false,
  sections: { shelves: true, sources: true }
}

function load(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(defaults)
    const parsed = JSON.parse(raw) as Partial<UiState>
    return {
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      sections: {
        shelves: parsed.sections?.shelves !== false,
        sources: parsed.sections?.sources !== false
      }
    }
  } catch {
    return structuredClone(defaults)
  }
}

function save(state: UiState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存不下就只影响"下次启动记不住"，不该影响本次操作
  }
}

export const useUiStore = defineStore('ui', () => {
  const state = reactive<UiState>(load())

  watch(state, (value) => save(value), { deep: true })

  function toggleSidebar(): void {
    state.sidebarCollapsed = !state.sidebarCollapsed
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    state.sidebarCollapsed = collapsed
  }

  function toggleSection(key: SectionKey): void {
    state.sections[key] = !state.sections[key]
  }

  function isSectionOpen(key: SectionKey): boolean {
    return state.sections[key]
  }

  /** 供验收脚本复位用；正常界面不会调用 */
  function reset(): void {
    state.sidebarCollapsed = defaults.sidebarCollapsed
    state.sections = { ...defaults.sections }
  }

  return { state, toggleSidebar, setSidebarCollapsed, toggleSection, isSectionOpen, reset }
})
