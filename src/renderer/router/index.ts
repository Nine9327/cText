import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from '@/views/LibraryView.vue'
import ShelvesView from '@/views/ShelvesView.vue'
import SourcesView from '@/views/SourcesView.vue'
import ComingSoonView from '@/views/ComingSoonView.vue'
import ReaderView from '@/views/ReaderView.vue'
import BookDetailView from '@/views/BookDetailView.vue'

/**
 * 路由表。侧栏入口各有独立去处（对齐产品文档 §2.2）：
 *   /library   全部书籍（受当前书库根目录过滤）
 *   /favorites 收藏的书籍
 *   /shelves   我的书架总览 → /shelves/:shelfId 单个书架
 *   /sources   网络小说总览 → /sources/:sourceId 单个书源
 * 加 /reader、/settings 两个未实现页，空状态由 ComingSoonView 承担。
 *
 * **侧栏只渲染已实现的入口**（书库/收藏/书架）：/sources 与 /settings 的路由
 * 保留——直接输 URL 仍能到达，但侧栏不再给入口，避免用户点进占位页。
 */
export const router = createRouter({
  // Electron 用 file:// 加载，hash 模式最省事
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    {
      path: '/library',
      name: 'library',
      component: LibraryView,
      meta: { title: '全部书籍' }
    },
    {
      path: '/favorites',
      name: 'favorites',
      component: LibraryView,
      meta: { title: '收藏的书籍', view: 'favorites' }
    },
    {
      path: '/shelves',
      name: 'shelves',
      component: ShelvesView,
      meta: { title: '我的书架' }
    },
    {
      path: '/shelves/:shelfId',
      name: 'shelf',
      component: LibraryView,
      meta: { title: '我的书架', view: 'shelf' }
    },
    {
      path: '/sources',
      name: 'sources',
      component: SourcesView,
      meta: { title: '网络小说' }
    },
    {
      path: '/sources/:sourceId',
      name: 'source',
      component: SourcesView,
      meta: { title: '网络小说' }
    },
    {
      path: '/book/:bookId',
      name: 'book',
      component: BookDetailView,
      meta: { title: '书籍详情' }
    },
    {
      path: '/reader/:bookId',
      name: 'reader',
      component: ReaderView,
      // immersive：阅读时收起侧栏（产品文档 §2.6 的沉浸阅读），标题栏保留
      // ——无边框窗口没有系统标题栏，关掉它用户就没法拖窗口/最小化
      meta: { title: '阅读器', immersive: true }
    },
    // 没有书号时退回书库：阅读器是「打开某本书」的动作，不该有独立入口
    { path: '/reader', redirect: '/library' },
    {
      path: '/settings',
      name: 'settings',
      component: ComingSoonView,
      meta: {
        title: '设置',
        desc: '阅读偏好、书库根目录、书源管理、存储与快捷键。',
        icon: 'settings',
        task: 'M5-01'
      }
    },
    { path: '/:pathMatch(.*)*', redirect: '/library' }
  ]
})
