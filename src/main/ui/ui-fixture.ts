/**
 * verify:ui 的 fixture 库（M1-08）。
 *
 * 为什么要 seed 而不是让断言基于空库：M0-08 的 43 项断言验证的是「列表过滤、
 * 选中态、离线角标」这类**只有在关系成立时才能验**的行为——收藏随根目录收敛、
 * 离线根目录的横幅、书架计数。所以临时库里必须有一批确定性的数据。
 *
 * 数据与被删除的 mock/library.ts 完全对齐（16 本书 / 2 个真实根目录 + 全部书库
 * 虚拟入口 / 收藏 5 / 书架 2），因此断言的数字一个都不用改。
 *
 * 固定 id（'r1'/'r2'/'b01'…）是刻意的： books.root_id 外键要指得到，
 * 且失败时的断言输出可直接对上号。
 */
import type { Db } from '../db/connection'

interface SeedBook {
  id: string
  title: string
  author: string | null
  format: 'txt' | 'epub'
  rootId: string
  favorite?: boolean
  readState?: 'unread' | 'reading' | 'finished'
  progress?: number
  lastReadAt?: number
}

const SEED_ROOTS = [
  { id: 'r1', label: '本地书库', path: 'D:\\books', state: 'online' },
  { id: 'r2', label: '移动硬盘', path: 'F:\\novels', state: 'offline' }
]

const SEED_BOOKS: SeedBook[] = [
  { id: 'b01', title: '置身事内：中国政府与经济发展', author: '兰小欢', format: 'epub', rootId: 'r1', favorite: true, readState: 'reading', progress: 0.42, lastReadAt: 3000 },
  { id: 'b02', title: '网络是怎样连接的', author: '户根勤', format: 'epub', rootId: 'r1', readState: 'reading', progress: 0.18 },
  { id: 'b03', title: '从这里读懂第三帝国（纳粹德国的腐败与反腐+现代性与大屠杀+从俾斯麦到希特勒）', author: '多人合集', format: 'epub', rootId: 'r1', favorite: true },
  { id: 'b04', title: '村上春树长篇代表作集（套装共10册）', author: '村上春树', format: 'epub', rootId: 'r1' },
  { id: 'b05', title: '开局长生万古，苟到天荒地老', author: '夜南听风', format: 'txt', rootId: 'r1', readState: 'reading', progress: 0.63, lastReadAt: 2000 },
  { id: 'b06', title: '明朝那些事儿（全集）', author: '当年明月', format: 'txt', rootId: 'r1' },
  { id: 'b07', title: '人类简史：从动物到上帝', author: '尤瓦尔·赫拉利', format: 'epub', rootId: 'r1', favorite: true, readState: 'finished', progress: 1 },
  { id: 'b08', title: '三体', author: '刘慈欣', format: 'txt', rootId: 'r1' },
  { id: 'b09', title: '平凡的世界', author: '路遥', format: 'txt', rootId: 'r2', favorite: true, readState: 'reading', progress: 0.35 },
  { id: 'b10', title: '白夜行', author: '东野圭吾', format: 'epub', rootId: 'r2' },
  { id: 'b11', title: '万历十五年', author: '黄仁宇', format: 'epub', rootId: 'r2' },
  { id: 'b12', title: '局外人', author: '阿尔贝·加缪', format: 'epub', rootId: 'r2' },
  { id: 'b13', title: '深入理解计算机系统（第3版）', author: 'Randal E. Bryant', format: 'epub', rootId: 'r1', favorite: true, readState: 'reading', progress: 0.09, lastReadAt: 1000 },
  { id: 'b14', title: '活着', author: '余华', format: 'txt', rootId: 'r1' },
  { id: 'b15', title: '沙丘', author: '弗兰克·赫伯特', format: 'epub', rootId: 'r1' },
  { id: 'b16', title: '乡土中国', author: '费孝通', format: 'epub', rootId: 'r1' }
]

const SEED_SHELVES = [
  { id: 's1', name: '睡前读物', bookIds: ['b03', 'b10', 'b12', 'b14'] },
  { id: 's2', name: '技术书', bookIds: ['b02', 'b13', 'b01'] }
]

export function seedUiFixture(db: Db): void {
  const now = Date.now()
  const insertRoot = db.prepare(
    `INSERT INTO library_roots (id, label, path, state, sort, last_check_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  SEED_ROOTS.forEach((root, index) => {
    insertRoot.run(root.id, root.label, root.path, root.state, index, now, now)
  })

  const insertBook = db.prepare(
    `INSERT INTO books (id, title, author, format, root_id, rel_path, file_hash, size_bytes,
                        favorite, read_state, progress, last_read_at, chapter_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  SEED_BOOKS.forEach((book, index) => {
    const createdAt = now - (SEED_BOOKS.length - index) * 1000 // b01 最旧，b16 最新
    insertBook.run(
      book.id,
      book.title,
      book.author,
      book.format,
      book.rootId,
      `${book.title}.txt`,
      `seed-${book.id}`,
      1024,
      book.favorite ? 1 : 0,
      book.readState ?? 'unread',
      book.progress ?? 0,
      book.lastReadAt ?? null,
      3,
      createdAt,
      createdAt
    )
  })

  const insertShelf = db.prepare(
    'INSERT INTO shelves (id, name, icon, sort, created_at) VALUES (?, ?, NULL, ?, ?)'
  )
  const insertShelfBook = db.prepare(
    'INSERT INTO shelf_books (shelf_id, book_id, sort, added_at) VALUES (?, ?, ?, ?)'
  )
  SEED_SHELVES.forEach((shelf, index) => {
    insertShelf.run(shelf.id, shelf.name, index, now)
    shelf.bookIds.forEach((bookId, bookIndex) => {
      insertShelfBook.run(shelf.id, bookId, bookIndex, now)
    })
  })
}
