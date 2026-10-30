<script setup lang="ts">
/**
 * 关于（M5-01）。
 *
 * 这一页的实际用途是**问题反馈**：用户报告「打不开书」时，我们需要版本矩阵、
 * 是否安全模式、库和日志在哪。所以路径都带一个「打开」按钮，
 * 底部再给一个「复制诊断信息」——比让用户手抄一行安装路径现实。
 *
 * 版本信息全部来自 `system:info`，页面不自己拼 process.versions：
 * 渲染层的 `process` 是 Electron 注入的沙箱版本，和主进程不是同一份真值。
 */
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import SettingRow from '@/components/settings/SettingRow.vue'
import { systemApi } from '@/api/system'
import { pushToast } from '@/lib/toast'
import type { AppInfoDTO } from '@shared/dto'

const info = ref<AppInfoDTO | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    info.value = await systemApi.info()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

async function open(target: 'data' | 'logs'): Promise<void> {
  try {
    await systemApi.openPath(target)
  } catch (err) {
    pushToast({ level: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

/** 诊断信息：够开发者判断「哪个版本、什么平台、库在哪」，不包含书单与阅读内容 */
function diagnosisText(): string {
  const app = info.value
  if (!app) return ''
  return [
    `${app.name} ${app.version}`,
    `Electron ${app.electron} / Chrome ${app.chrome} / Node ${app.node}`,
    `${app.platform} ${app.arch}${app.isDev ? ' · 开发态' : ''}`,
    `安全模式：${app.safeMode ? `是（${app.safeModeSource}）` : '否'}`,
    `数据目录：${app.userDataPath}`,
    `数据库：${app.dbPath}`,
    `日志目录：${app.logDir}`
  ].join('\n')
}

async function copyDiagnosis(): Promise<void> {
  try {
    await navigator.clipboard.writeText(diagnosisText())
    pushToast({ level: 'info', message: '诊断信息已复制，可直接粘贴到反馈里' })
  } catch {
    pushToast({ level: 'error', message: '复制失败，请手动选择文本' })
  }
}
</script>

<template>
  <div data-settings-about>
    <div v-if="error" class="px-4 py-6 text-[12px] text-rose-300/90">{{ error }}</div>

    <template v-else-if="info">
      <SettingRow label="版本" :desc="`${info.platform} ${info.arch}${info.isDev ? ' · 开发态' : ''}`">
        <span class="text-[12.5px] text-ink" data-settings-version>v{{ info.version }}</span>
      </SettingRow>

      <SettingRow label="运行时" desc="Electron / Chromium / Node 的版本组合，反馈问题时需要它">
        <span class="text-[11.5px] text-dim">
          {{ info.electron }} · {{ info.chrome }} · {{ info.node }}
        </span>
      </SettingRow>

      <SettingRow
        label="安全模式"
        desc="关闭 Chromium 沙箱运行的兼容模式。正常应为「否」，为「是」时部分功能可能受限"
      >
        <span class="text-[12px]" :class="info.safeMode ? 'text-amber-300/90' : 'text-dim'">
          {{ info.safeMode ? `是（${info.safeModeSource}）` : '否' }}
        </span>
      </SettingRow>

      <SettingRow label="数据目录" :desc="info.userDataPath" stacked>
        <button type="button" class="ct-btn" data-settings-open-data @click="open('data')">
          <AppIcon name="folder" :size="13" />打开目录
        </button>
      </SettingRow>

      <SettingRow label="日志目录" :desc="info.logDir" stacked>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="ct-btn" data-settings-open-logs @click="open('logs')">
            <AppIcon name="folder" :size="13" />打开目录
          </button>
          <button type="button" class="ct-btn" data-settings-copy-diag @click="copyDiagnosis">
            <AppIcon name="detail" :size="13" />复制诊断信息
          </button>
        </div>
      </SettingRow>

      <div class="px-4 py-3 text-[11px] leading-relaxed text-faint">
        本应用不内置、不分发任何书源规则；网络小说功能需要你自己导入书源。阅读数据全部保存在本机，
        不会上传。
      </div>
    </template>

    <div v-else class="px-4 py-6 text-[11.5px] text-faint">正在读取版本信息…</div>
  </div>
</template>
