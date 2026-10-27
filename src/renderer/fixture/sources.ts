/**
 * 书源域的展示数据（M4-11 前的 fixture）。
 *
 * 为什么单独一个文件而不是 mock/：M1-08 砍掉了整个 mock 体系（书籍 / 根目录 /
 * 书架全部真实化），但书源是 M4 的域——列表骨架仍要能渲染（侧栏入口、空态、
 * 选中态的验收都依赖它）。这里的数据与 M4-11 的 book_sources 表结构对齐，
 * 到时候整文件删除、换成 source:list 的返回。
 */
export interface SourceFixture {
  id: string
  name: string
  enabled: boolean
  /** 书源分组（Legado 的 bookSourceGroup） */
  group: string
}

export const fixtureSources: SourceFixture[] = [
  { id: 'src1', name: '示例书源 A', enabled: true, group: '默认' },
  { id: 'src2', name: '示例书源 B', enabled: true, group: '默认' },
  { id: 'src3', name: '示例书源 C', enabled: false, group: '备用' }
]
