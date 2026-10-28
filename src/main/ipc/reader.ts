/**
 * 阅读器 IPC（M2-01）。
 *
 * 两个通道：
 *   - `reader:content`  取一章正文（M2-01）
 *   - `reader:chapters` 取整本目录（M2-06）
 * `reader:saveProgress` 仍是占位（进度落库属 M2-08，含 1s 防抖与启动恢复）。
 */
import type { ChapterContentDTO, ChapterDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { listChapters } from '../db/repositories/books'
import { getChapterContent } from '../reader/content'
import { registerHandler } from './registry'

export function registerReaderIpc(): void {
  registerHandler(
    'reader:content',
    ({ bookId, chapterIdx }): Promise<ChapterContentDTO> => getChapterContent(getDb(), bookId, chapterIdx)
  )
  registerHandler('reader:chapters', ({ bookId }): ChapterDTO[] => listChapters(getDb(), bookId))
}
