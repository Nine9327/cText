/**
 * 书签与划线 IPC（M2-09）。
 *
 * 五个通道都围绕「章 + 两个字符偏移」这一组坐标：
 *   - `bookmarks:list`       整本（侧栏一次拿全，量级是几十条）
 *   - `bookmarks:add`        划线/书签，重复位置返回已有的那条
 *   - `bookmarks:updateNote` 只改备注（摘要是不可变的，改位置等于新建）
 *   - `bookmarks:remove`
 *   - `bookmarks:export`     导出 Markdown，没给路径时弹保存框
 */
import { writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import type { BookmarkDTO } from '@shared/dto'
import { getDb } from '../db/connection'
import { addBookmark, exportBookmarks, listBookmarks, removeBookmark, updateBookmarkNote } from '../db/repositories/bookmarks'
import { registerHandler } from './registry'

/** Windows 文件名禁用字符，顺带把路径分隔符也换掉 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || '读书笔记'
}

export function registerBookmarksIpc(): void {
  registerHandler('bookmarks:list', ({ bookId }): BookmarkDTO[] => listBookmarks(getDb(), bookId))

  registerHandler('bookmarks:add', (input): BookmarkDTO => addBookmark(getDb(), input))

  registerHandler('bookmarks:updateNote', ({ id, note }) => {
    updateBookmarkNote(getDb(), id, note)
  })

  registerHandler('bookmarks:remove', ({ id }) => {
    removeBookmark(getDb(), id)
  })

  registerHandler('bookmarks:export', async ({ bookId, path }) => {
    const db = getDb()
    const book = db.prepare('SELECT title FROM books WHERE id = ? AND deleted_at IS NULL').get(bookId) as
      | { title: string }
      | undefined
    const markdown = exportBookmarks(db, bookId, book?.title ?? '未命名')

    let target = path
    if (!target) {
      const picked = await dialog.showSaveDialog({
        title: '导出读书笔记',
        defaultPath: `${safeFileName(book?.title ?? '读书笔记')}-笔记.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (picked.canceled || !picked.filePath) return null
      target = picked.filePath
    }

    await writeFile(target, markdown, 'utf8')
    return { path: target }
  })
}
