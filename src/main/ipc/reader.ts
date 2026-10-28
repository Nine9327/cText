/**
 * 阅读器 IPC（M2-01）。
 *
 * 两个通道：
 *   - `reader:content`  取一章正文（M2-01）
 *   - `reader:chapters` 取整本目录（M2-06）
 *   - `reader:progress` / `reader:saveProgress` 读写阅读进度（M2-08）
 */
import type { ChapterContentDTO, ChapterDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { listChapters } from '../db/repositories/books'
import { loadProgress, saveProgress } from '../db/repositories/progress'
import { getChapterContent } from '../reader/content'
import { registerHandler } from './registry'

export function registerReaderIpc(): void {
  registerHandler(
    'reader:content',
    ({ bookId, chapterIdx }): Promise<ChapterContentDTO> => getChapterContent(getDb(), bookId, chapterIdx)
  )
  registerHandler('reader:chapters', ({ bookId }): ChapterDTO[] => listChapters(getDb(), bookId))

  // 进度：写入是同步 SQL（better-sqlite3），渲染层负责 1s 防抖；
  // 主进程不做二次缓存，避免「缓存里的进度」和「库里的进度」两份真相
  registerHandler('reader:progress', ({ bookId }) => loadProgress(getDb(), bookId))
  registerHandler('reader:saveProgress', (progress) => {
    saveProgress(getDb(), progress)
  })
}
