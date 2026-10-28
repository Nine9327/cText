/**
 * 分类 IPC（M3-03）。
 *
 * 与书架的分工：**分类描述书本身**（科幻 / 历史 / 技术），**书架描述阅读安排**
 * （睡前读物 / 待读）。同一本书可以既属于「科幻」分类，又躺在「待读」书架里，
 * 两者互不影响——这也是为什么 `library:setCategories` 与 `shelves:addBooks`
 * 是两个通道而不是一个「打标签」接口。
 *
 * 名称唯一：重名分类在筛选器里是两个一模一样的选项，用户无法选对。
 * 校验放在这里（而不是只靠 DDL 的 UNIQUE），是为了给出一句能读懂的话，
 * 而不是一个 `SQLITE_CONSTRAINT_UNIQUE`。
 */
import { randomUUID } from 'node:crypto'
import type { CategoryDTO } from '@shared/dto'
import { AppError, ERROR_CODES } from '@shared/errors'
import { getDb } from '../db/connection'
import {
  addBookCategories,
  createCategory,
  findCategoryByName,
  listCategories,
  removeBookCategories,
  removeCategory,
  setBookCategories,
  updateCategory
} from '../db/repositories/categories'
import { registerHandler } from './registry'

export function registerCategoriesIpc(): void {
  registerHandler('categories:list', (): CategoryDTO[] => listCategories(getDb()))

  registerHandler('categories:create', ({ name, color }): CategoryDTO => {
    if (findCategoryByName(getDb(), name)) {
      throw new AppError(ERROR_CODES.conflict, `已经有叫「${name}」的分类了`)
    }
    return createCategory(getDb(), `ct_${randomUUID().slice(0, 8)}`, name, color)
  })

  registerHandler('categories:update', ({ id, name, color, sort }): CategoryDTO | null => {
    if (name) {
      const clash = findCategoryByName(getDb(), name, id)
      if (clash) throw new AppError(ERROR_CODES.conflict, `已经有叫「${name}」的分类了`)
    }
    const updated = updateCategory(getDb(), id, { name, color, sort })
    if (!updated) throw new AppError(ERROR_CODES.notFound, '分类不存在，可能已被删除')
    return updated
  })

  /** 删除分类只删标签关联，书籍一行不动 */
  registerHandler('categories:remove', ({ id }) => {
    if (!removeCategory(getDb(), id)) {
      throw new AppError(ERROR_CODES.notFound, '分类不存在，可能已被删除')
    }
  })

  /** 整体替换一本书的分类（传空数组 = 清空） */
  registerHandler('library:setCategories', ({ id, categoryIds }) => {
    setBookCategories(getDb(), id, categoryIds)
  })

  /**
   * 批量打标签（M3-05）：**增量**，不覆盖既有标签。
   * 批量场景的意图是「给这 500 本都加上科幻」，而不是「把它们的标签全换成科幻」。
   * `removeCategories` 是它的逆操作，也是「撤销」的实现基础。
   */
  registerHandler('library:addCategories', ({ bookIds, categoryIds }) =>
    addBookCategories(getDb(), bookIds, categoryIds)
  )
  registerHandler('library:removeCategories', ({ bookIds, categoryIds }) => ({
    updated: removeBookCategories(getDb(), bookIds, categoryIds)
  }))
}
