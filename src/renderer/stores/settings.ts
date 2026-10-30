/**
 * 设置中心的数据源（M5-01）。
 *
 * 只持有「常规 / 存储 / 书源」三组：阅读排版与快捷键的真相源是 `stores/reader`
 * （阅读器正在用那份数据渲染，设置页改这里再让阅读器去读，会出现两套值谁赢的问题）。
 * 所以设置页的阅读组直接调 reader store 的 setter，只有这里这三组走本 store。
 *
 * **不做乐观更新**：主进程返回的就是合并后的全量，直接替换。
 * 设置项点击频率低，多一次往返换来「界面永远等于库里的值」，比省几十毫秒值。
 * 唯一例外是滑杆／输入框这类连续操作——界面在组件内部用本地值即时反馈，
 * 松手（change）才提交，见 SettingsView 的 `commitStorageLimit`。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { SettingsDTO } from '@shared/dto'
import type { DeepPartial } from '@shared/ipc/contract'
import { settingsApi } from '@/api/settings'

/** 首次加载完成之前用 null 表示「还不知道」，界面不渲染任何可交互控件 */
export const useSettingsStore = defineStore('settings', () => {
  const current = ref<SettingsDTO | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const general = computed(() => current.value?.general ?? null)
  const storage = computed(() => current.value?.storage ?? null)
  const sources = computed(() => current.value?.sources ?? null)
  const ready = computed(() => current.value !== null)

  let inflight: Promise<void> | null = null

  /**
   * 读全量。并发调用合并成一次：设置页与「关于」面板可能同时挂载，
   * 两边各发一次读请求没有意义。
   */
  async function load(force = false): Promise<void> {
    if (!force && current.value !== null) return
    if (inflight !== null) return inflight

    loading.value = true
    error.value = null
    inflight = (async () => {
      try {
        current.value = await settingsApi.get()
      } catch (err) {
        error.value = err instanceof Error ? err.message : '读取设置失败'
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  /**
   * 局部更新。返回是否成功——失败时组件要能把控件回退到原值，
   * 否则界面会停在一个「显示已开启、实际没存上」的状态。
   */
  async function patch(partial: DeepPartial<SettingsDTO>): Promise<boolean> {
    if (saving.value) return false
    saving.value = true
    error.value = null
    try {
      current.value = await settingsApi.patch(partial)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '保存设置失败'
      // 失败时重新读一次：本地那份可能已经被上一次成功写入改过，
      // 直接留着会让界面与库分叉
      await load(true)
      return false
    } finally {
      saving.value = false
    }
  }

  async function reset(): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      current.value = await settingsApi.reset()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '恢复默认失败'
      return false
    } finally {
      saving.value = false
    }
  }

  return { current, loading, saving, error, general, storage, sources, ready, load, patch, reset }
})
