/**
 * 导入面板的状态（M1-07）。
 *
 * 用 Pinia 而不是组件内部 ref，是因为**入口有三个**：工具栏按钮、空状态按钮、
 * 拖放覆盖层。三者都要能「带着一个路径打开面板」，状态放在组件里就得往上透传
 * 事件，或者塞进 provide/inject——不如直接一个 store。
 *
 * 一条纪律：**进度只能来自 `import:progress` 事件**，不在 `commit` 的返回值里等结果。
 * 几百本的导入要跑几十秒，界面必须保持可响应、可取消。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ImportProgressDTO, ScanPreviewDTO, ScanPreviewItemDTO } from '@shared/dto'
import { importApi } from '@/api/import'
import { pushToast, toastError } from '@/lib/toast'

export type ImportStage = 'pick' | 'preview' | 'running' | 'result'

/** 预览列表最多渲染多少条。超了只列前 N 条并提示，否则大目录会卡死渲染 */
const MAX_ROWS = 300

export const useImportStore = defineStore('import', () => {
  const visible = ref(false)
  const stage = ref<ImportStage>('pick')
  const dirPath = ref('')
  const scanning = ref(false)
  const preview = ref<ScanPreviewDTO | null>(null)
  const progress = ref<ImportProgressDTO | null>(null)
  const result = ref<ImportProgressDTO | null>(null)
  const taskId = ref<string | null>(null)
  const error = ref<string | null>(null)
  /** 打开面板时的一条说明（拖放降级提示之类），显示在路径输入上方 */
  const notice = ref<string | null>(null)

  const options = reactive({
    scanDepth: 8,
    ignorePattern: '',
    onDuplicate: 'skip' as 'skip' | 'overwrite',
    registerAsRoot: true
  })

  /** 预览列表的分类页签 */
  const tab = ref<'all' | 'new' | 'duplicate' | 'unsupported' | 'skipped'>('all')

  function countsOf(items: readonly ScanPreviewItemDTO[]) {
    let fresh = 0
    let duplicate = 0
    let unsupported = 0
    let skipped = 0
    for (const item of items) {
      if (item.status === 'new') fresh++
      else if (item.status === 'duplicate') duplicate++
      else if (item.status === 'unsupported') unsupported++
      else skipped++
    }
    return { fresh, duplicate, unsupported, skipped }
  }

  const counts = computed(() => countsOf(preview.value?.items ?? []))

  /** 「开始导入」什么时候可点：有待处理的书，且当前没有任务在跑 */
  const canStart = computed(() => {
    if (stage.value === 'running') return false
    const { fresh, duplicate } = counts.value
    const pending = fresh + (options.onDuplicate === 'overwrite' ? duplicate : 0)
    return pending > 0
  })

  const rows = computed<ScanPreviewItemDTO[]>(() => {
    const items = preview.value?.items ?? []
    const filtered = tab.value === 'all' ? items : items.filter((item) => matchTab(item))
    return filtered.slice(0, MAX_ROWS)
  })

  /**
   * 列表是否真的被裁掉了一截。
   *
   * 不能只看主进程的 `preview.truncated`（那按 2000 条算）：这里实际只渲染 300 行，
   * 300~2000 之间的目录如果不提示，用户会误以为只有 300 本。
   */
  const rowsClipped = computed(() => {
    const items = preview.value?.items ?? []
    const filtered = tab.value === 'all' ? items : items.filter((item) => matchTab(item))
    return filtered.length > MAX_ROWS
  })

  function matchTab(item: ScanPreviewItemDTO): boolean {
    if (tab.value === 'new') return item.status === 'new'
    if (tab.value === 'duplicate') return item.status === 'duplicate'
    if (tab.value === 'unsupported') return item.status === 'unsupported'
    // 跳过：空文件与读不了——不是格式问题，是文件本身没内容或打不开
    return item.status === 'empty' || item.status === 'failed'
  }

  function reset(): void {
    stage.value = 'pick'
    preview.value = null
    progress.value = null
    result.value = null
    taskId.value = null
    error.value = null
    notice.value = null
    tab.value = 'all'
  }

  function open(path?: string, hint?: string | null): void {
    reset()
    if (path) dirPath.value = path
    if (hint) notice.value = hint
    visible.value = true
  }

  function close(): void {
    // 导入途中关闭面板**不取消任务**：任务继续跑完，用户去做别的事。
    // 真正要停必须显式点「取消」——否则误关面板会丢掉一次几十秒的导入。
    visible.value = false
  }

  async function pickFolder(): Promise<void> {
    try {
      const picked = await importApi.pickFolder()
      if (picked) dirPath.value = picked.path
    } catch (err) {
      toastError(err, '打开文件夹选择失败')
    }
  }

  async function scan(): Promise<void> {
    const path = dirPath.value.trim()
    if (!path) {
      error.value = '请先选择或填写要导入的文件夹'
      return
    }
    scanning.value = true
    error.value = null
    preview.value = null
    try {
      preview.value = await importApi.scan(path)
      stage.value = 'preview'
      tab.value = 'all'
    } catch (err) {
      toastError(err, '扫描目录失败')
      error.value = err instanceof Error ? err.message : '扫描目录失败'
    } finally {
      scanning.value = false
    }
  }

  async function start(): Promise<void> {
    if (!canStart.value) return
    const path = dirPath.value.trim()
    stage.value = 'running'
    progress.value = null
    error.value = null
    try {
      const started = await importApi.commit(path, {
        scanDepth: options.scanDepth,
        registerAsRoot: options.registerAsRoot,
        onDuplicate: options.onDuplicate,
        ...(options.ignorePattern.trim() ? { ignorePattern: options.ignorePattern.trim() } : {})
      })
      taskId.value = started.taskId
    } catch (err) {
      // 提交失败就退回预览：路径可能在扫描之后被删掉了
      toastError(err, '启动导入失败')
      stage.value = preview.value ? 'preview' : 'pick'
      error.value = err instanceof Error ? err.message : '启动导入失败'
    }
  }

  async function cancel(): Promise<void> {
    if (!taskId.value) return
    try {
      await importApi.cancel(taskId.value)
    } catch (err) {
      toastError(err, '取消导入失败')
    }
  }

  /** 进度事件回调。由 main.ts 在应用启动时挂上，与面板是否打开无关 */
  function applyProgress(dto: ImportProgressDTO): void {
    // 只认当前任务：连续两次导入时，上一个任务的迟到事件不能覆盖新结果
    if (taskId.value && dto.taskId !== taskId.value) return
    if (!taskId.value) taskId.value = dto.taskId

    progress.value = dto
    if (dto.phase === 'done' || dto.phase === 'cancelled' || dto.phase === 'failed') {
      result.value = dto
      stage.value = 'result'
      summarize(dto)
    }
  }

  function summarize(dto: ImportProgressDTO): void {
    if (dto.phase === 'failed') {
      pushToast({ level: 'error', message: '导入失败，请查看失败清单' })
      return
    }
    if (dto.phase === 'cancelled') {
      pushToast({ level: 'info', message: `已取消导入，本次入库 ${dto.imported} 本` })
      return
    }
    const parts = [`导入完成，新增 ${dto.imported} 本`]
    if (dto.updated > 0) parts.push(`覆盖 ${dto.updated} 本`)
    if (dto.skipped > 0) parts.push(`跳过 ${dto.skipped} 项`)
    if (dto.failedTotal > 0) parts.push(`失败 ${dto.failedTotal} 项`)
    pushToast({
      level: dto.failedTotal > 0 ? 'warn' : 'info',
      message: parts.join('，')
    })
  }

  return {
    visible,
    stage,
    dirPath,
    scanning,
    preview,
    progress,
    result,
    taskId,
    error,
    notice,
    options,
    tab,
    counts,
    rows,
    rowsClipped,
    canStart,
    maxRows: MAX_ROWS,
    reset,
    open,
    close,
    pickFolder,
    scan,
    start,
    cancel,
    applyProgress
  }
})
