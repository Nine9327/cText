/**
 * UI 骨架用的假数据。M1 起替换为 library:list / roots:list 的返回。
 *
 * 这里刻意把「根目录 → 书籍」「书架 → 书籍」「收藏 → 书籍」三种关系都建出来，
 * 因为侧栏骨架的选中态与过滤行为只有在关系成立时才能验：
 *   - 根目录离线 → 其下书籍全部 offline（产品文档 §2.3）
 *   - 收藏是书籍的一个布尔属性（books.favorite），不是分组
 *   - 书架是多对多分组，同一本书可以同时在多个书架
 */

export type ReadState = 'unread' | 'reading' | 'finished' | 'offline'

/** 书库根目录：一个可独立上下线的挂载点 */
export interface MockRoot {
  id: string
  /** 侧栏显示名 */
  label: string
  /** 真实路径；「全部书库」为空串 */
  path: string
  online: boolean
}

export interface MockBook {
  id: string
  title: string
  author: string
  state: ReadState
  /** 0 ~ 1 */
  progress: number
  format: 'txt' | 'epub'
  cover: { from: string; to: string }
  /** 所属根目录（books 表只存 root_id + rel_path，不存绝对路径） */
  rootId: string
}

export const ALL_ROOTS_ID = 'all'

export const mockRoots: MockRoot[] = [
  { id: ALL_ROOTS_ID, label: '全部书库', path: '', online: true },
  { id: 'r1', label: '本地书库', path: 'D:\\books', online: true },
  { id: 'r2', label: '移动硬盘', path: 'F:\\novels', online: false }
]

export const mockBooks: MockBook[] = [
  {
    id: 'b01',
    title: '置身事内：中国政府与经济发展',
    author: '兰小欢',
    state: 'reading',
    progress: 0.42,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#8a6a52', to: '#4a3628' }
  },
  {
    id: 'b02',
    title: '网络是怎样连接的',
    author: '户根勤',
    state: 'reading',
    progress: 0.18,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#2f4f6f', to: '#18293a' }
  },
  {
    id: 'b03',
    title: '从这里读懂第三帝国（纳粹德国的腐败与反腐+现代性与大屠杀+从俾斯麦到希特勒）',
    author: '多人合集',
    state: 'unread',
    progress: 0,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#7a2f2f', to: '#3a1414' }
  },
  {
    id: 'b04',
    title: '村上春树长篇代表作集（套装共10册）',
    author: '村上春树',
    state: 'unread',
    progress: 0,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#3d4a3a', to: '#1d241c' }
  },
  {
    id: 'b05',
    title: '开局长生万古，苟到天荒地老',
    author: '夜南听风',
    state: 'reading',
    progress: 0.63,
    format: 'txt',
    rootId: 'r1',
    cover: { from: '#3a5a7a', to: '#17293a' }
  },
  {
    id: 'b06',
    title: '明朝那些事儿（全集）',
    author: '当年明月',
    state: 'unread',
    progress: 0,
    format: 'txt',
    rootId: 'r1',
    cover: { from: '#8a6a2f', to: '#3f2f14' }
  },
  {
    id: 'b07',
    title: '人类简史：从动物到上帝',
    author: '尤瓦尔·赫拉利',
    state: 'finished',
    progress: 1,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#5a4a6a', to: '#2a2136' }
  },
  {
    id: 'b08',
    title: '三体',
    author: '刘慈欣',
    state: 'unread',
    progress: 0,
    format: 'txt',
    rootId: 'r1',
    cover: { from: '#1f3a4a', to: '#0d1a22' }
  },
  // ---- 以下 4 本在移动硬盘上；该根目录离线，所以全部 offline ----
  {
    id: 'b09',
    title: '平凡的世界',
    author: '路遥',
    state: 'offline',
    progress: 0.35,
    format: 'txt',
    rootId: 'r2',
    cover: { from: '#6a5236', to: '#2f2317' }
  },
  {
    id: 'b10',
    title: '白夜行',
    author: '东野圭吾',
    state: 'offline',
    progress: 0,
    format: 'epub',
    rootId: 'r2',
    cover: { from: '#3a3a4a', to: '#16161f' }
  },
  {
    id: 'b11',
    title: '万历十五年',
    author: '黄仁宇',
    state: 'offline',
    progress: 0,
    format: 'epub',
    rootId: 'r2',
    cover: { from: '#7a5a3a', to: '#33241a' }
  },
  {
    id: 'b12',
    title: '局外人',
    author: '阿尔贝·加缪',
    state: 'offline',
    progress: 0,
    format: 'epub',
    rootId: 'r2',
    cover: { from: '#4a5a5a', to: '#1f2626' }
  },
  // ---- 回到本地书库 ----
  {
    id: 'b13',
    title: '深入理解计算机系统（第3版）',
    author: 'Randal E. Bryant',
    state: 'reading',
    progress: 0.09,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#2f3a5a', to: '#141a29' }
  },
  {
    id: 'b14',
    title: '活着',
    author: '余华',
    state: 'unread',
    progress: 0,
    format: 'txt',
    rootId: 'r1',
    cover: { from: '#6a3a2f', to: '#2b1512' }
  },
  {
    id: 'b15',
    title: '沙丘',
    author: '弗兰克·赫伯特',
    state: 'unread',
    progress: 0,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#8a6a2f', to: '#3a2a10' }
  },
  {
    id: 'b16',
    title: '乡土中国',
    author: '费孝通',
    state: 'unread',
    progress: 0,
    format: 'epub',
    rootId: 'r1',
    cover: { from: '#4a5a3a', to: '#1e2416' }
  }
]

/**
 * 收藏是 `books.favorite` 布尔，不是分组。
 * 刻意包含一本离线书（b09），用来验证收藏列表里也要显示离线角标。
 */
export const favoriteIds: readonly string[] = ['b01', 'b03', 'b07', 'b09', 'b13']

export interface MockShelf {
  id: string
  name: string
  /** 多对多：同一本书可以在多个书架里 */
  bookIds: string[]
}

export const mockShelves: MockShelf[] = [
  { id: 's1', name: '睡前读物', bookIds: ['b03', 'b10', 'b12', 'b14'] },
  { id: 's2', name: '技术书', bookIds: ['b02', 'b13', 'b01'] }
]

export interface MockSource {
  id: string
  name: string
  enabled: boolean
  /** 书源分组（Legado 的 bookSourceGroup） */
  group: string
}

export const mockSources: MockSource[] = [
  { id: 'src1', name: '示例书源 A', enabled: true, group: '默认' },
  { id: 'src2', name: '示例书源 B', enabled: true, group: '默认' },
  { id: 'src3', name: '示例书源 C', enabled: false, group: '备用' }
]
