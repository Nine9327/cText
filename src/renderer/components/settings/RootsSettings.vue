<script setup lang="ts">
/**
 * 书库根目录（M5-01）。
 *
 * M1-01 的 `roots:*` 通道早就齐了，但界面一直只有侧栏的「切换」——
 * 添加、离线重定位、移除都没有入口，用户换块硬盘就没法继续用。
 *
 * 三条界面约定：
 *   1. **移除先确认，并写明书不会删**。移除根目录只是解绑（书籍降级为未归属），
 *      但用户在「设置 → 目录」里点删除时，直觉是「我的书要没了」。
 *   2. **离线目录的按钮变成「重新指定」**。离线时点检测没有意义（盘没插），
 *      能做的只有换个路径。
 *   3. **添加后不自动扫描**。几千本的目录一扫描就是几分钟，且设置页没有导入进度条；
 *      扫不扫由用户在书库页自己触发（那里有完整进度）。
 */
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SettingRow from '@/components/settings/SettingRow.vue'
import { call } from '@/api/client'
import { pushToast } from '@/lib/toast'
import type { RootDTO } from '@shared/dto'

const roots = ref<RootDTO[]>([])
const loading = ref(true)
const busy = ref(false)
const removing = ref<RootDTO | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function reload(): Promise<void> {
  try {
    roots.value = await call('roots:list')
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    loading.value = false
  }
}

onMounted(reload)

/** 选目录；用户取消返回 null（取消不是错误，不提示） */
async function pickDirectory(): Promise<string | null> {
  const picked = await call('import:pickFolder')
  return picked?.path ?? null
}

async function addRoot(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const path = await pickDirectory()
    if (path === null) return
    const created = await call('roots:add', { path, scanNow: false })
    await reload()
    pushToast({ level: 'info', message: `已添加目录「${created.label}」，可在书库页扫描导入` })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

async function checkRoots(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    roots.value = await call('roots:check')
    const offline = roots.value.filter((root) => root.state === 'offline').length
    pushToast({
      level: offline === 0 ? 'info' : 'warn',
      message: offline === 0 ? '所有目录都可访问' : `${offline} 个目录当前离线`
    })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

async function relocate(root: RootDTO): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const path = await pickDirectory()
    if (path === null) return
    const result = await call('roots:relocate', { rootId: root.id, newPath: path })
    await reload()
    pushToast({
      level: result.missing === 0 ? 'info' : 'warn',
      message:
        result.missing === 0
          ? `已重新指定，${result.matched} 本书全部找到`
          : `已重新指定，${result.matched} 本找到，${result.missing} 本在新目录里没找到`
    })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  } finally {
    busy.value = false
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value
  removing.value = null
  if (!target) return
  try {
    await call('roots:remove', { rootId: target.id })
    await reload()
    pushToast({ level: 'info', message: `已移除目录「${target.label}」，书籍记录仍保留在书库中` })
  } catch (err) {
    pushToast({ level: 'error', message: messageOf(err) })
  }
}
</script>

<template>
  <div data-settings-roots>
    <SettingRow
      v-for="root in roots"
      :key="root.id"
      :label="root.label"
      :desc="root.path"
      stacked
      data-settings-root
    >
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded border px-1.5 py-px text-[10.5px]"
          :class="
            root.state === 'online'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300/90'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-300/90'
          "
        >
          {{ root.state === 'online' ? '在线' : '离线' }}
        </span>
        <span class="text-[11px] text-faint">{{ root.bookCount }} 本</span>
        <span class="flex-1" />
        <button
          type="button"
          class="ct-btn"
          data-settings-root-relocate
          @click="relocate(root)"
        >
          {{ root.state === 'online' ? '更改路径' : '重新指定' }}
        </button>
        <button
          type="button"
          class="ct-btn text-rose-300/90 hover:border-rose-400/40 hover:text-rose-200"
          data-settings-root-remove
          @click="removing = root"
        >
          移除
        </button>
      </div>
    </SettingRow>

    <div v-if="!loading && roots.length === 0" class="px-4 py-6 text-center text-[11.5px] text-faint">
      还没有登记任何目录。添加后即可在「全部书籍」里扫描导入。
    </div>

    <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
      <button type="button" class="ct-btn" :disabled="busy" data-settings-root-add @click="addRoot">
        <AppIcon name="plus" :size="13" />添加目录
      </button>
      <button type="button" class="ct-btn" :disabled="busy" data-settings-root-check @click="checkRoots">
        <AppIcon name="check" :size="13" />检测状态
      </button>
      <span class="text-[11px] text-faint">移除目录只解绑，不会删除磁盘上的文件</span>
    </div>

    <ConfirmDialog
      :open="removing !== null"
      title="移除这个目录？"
      :desc="`「${removing?.label ?? ''}」里的 ${removing?.bookCount ?? 0} 本书会变成「未归属目录」，仍留在书库中。磁盘上的文件不会被删除，重新添加该目录后可以再归位。`"
      confirm-text="移除目录"
      danger
      @confirm="confirmRemove"
      @cancel="removing = null"
    />
  </div>
</template>
