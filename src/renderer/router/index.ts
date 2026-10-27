import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from '@/views/LibraryView.vue'
import ComingSoonView from '@/views/ComingSoonView.vue'

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
      path: '/shelves/:shelfId',
      name: 'shelf',
      component: LibraryView,
      meta: { title: '我的书架', view: 'shelf' }
    },
    {
      path: '/sources',
      name: 'sources',
      component: ComingSoonView,
      meta: {
        title: '网络小说',
        desc: '书源导入、聚合搜索、章节缓存。书源规则对齐「阅读 3.0」格式。',
        icon: 'search',
        task: 'M4-01 ~ M4-12'
      }
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
