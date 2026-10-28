/**
 * 阅读器 IPC（M2-01）。
 *
 * 目前只有一个通道：`reader:content`。
 * `reader:saveProgress` 仍是占位（进度落库属 M2-08，含 1s 防抖与启动恢复）。
 */
import type { ChapterContentDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { getChapterContent } from '../reader/content'
import { registerHandler } from './registry'

export function registerReaderIpc(): void {
  registerHandler(
    'reader:content',
    ({ bookId, chapterIdx }): Promise<ChapterContentDTO> => getChapterContent(getDb(), bookId, chapterIdx)
  )
}
