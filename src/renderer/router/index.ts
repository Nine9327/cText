import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from '@/views/LibraryView.vue'
import ShelvesView from '@/views/ShelvesView.vue'
import SourcesView from '@/views/SourcesView.vue'
import ComingSoonView from '@/views/ComingSoonView.vue'

/**
 * 路由表。五个侧栏入口各有独立去处（对齐产品文档 §2.2）：
 *   /library   全部书籍（受当前书库根目录过滤）
 *   /favorites 收藏的书籍
 *   /shelves   我的书架总览 → /shelves/:shelfId 单个书架
 *   /sources   网络小说总览 → /sources/:sourceId 单个书源
 * 加 /reader、/settings 两个未实现页，空状态由 ComingSoonView 承担。
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
      path: '/reader',
      name: 'reader',
      component: ComingSoonView,
      meta: {
        title: '阅读器',
        desc: '分页 / 滚动、目录、排版主题、进度记忆、书签笔记。',
        icon: 'book',
        task: 'M2-01 ~ M2-11'
      }
    },
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
