/** 图标名称与 path 数据（不依赖额外图标库） */
export type IconName =
  | 'book'
  | 'star'
  | 'folder'
  | 'plus'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'globe'
  | 'layers'
  | 'search'
  | 'sort'
  | 'import'
  | 'settings'
  | 'grid'
  | 'detail'
  | 'list'
  | 'check'
  | 'offline'
  | 'info'
  | 'warning'
  | 'error'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'bookmark'

export const iconPaths: Record<IconName, string> = {
  book: 'M6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3ZM4 18.5A2.5 2.5 0 0 1 6.5 16H19',
  bookmark: 'M7 3.5h10a1 1 0 0 1 1 1V21l-6-4.4L6 21V4.5a1 1 0 0 1 1-1Z',
  star: 'M12 3.2 14.9 9l6.4.9-4.6 4.5 1.1 6.4L12 17.8 6.2 20.8l1.1-6.4L2.7 9.9 9.1 9 12 3.2Z',
  folder:
    'M4 20h16a1.6 1.6 0 0 0 1.6-1.6V8.4A1.6 1.6 0 0 0 20 6.8h-8l-1.6-2.2A1.6 1.6 0 0 0 9.1 4H4a1.6 1.6 0 0 0-1.6 1.6v12.8A1.6 1.6 0 0 0 4 20Z',
  plus: 'M12 5v14M5 12h14',
  'chevron-down': 'm6.5 9.5 5.5 5.5 5.5-5.5',
  'chevron-right': 'm9.5 6.5 5.5 5.5-5.5 5.5',
  'chevron-left': 'm14.5 6.5-5.5 5.5 5.5 5.5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.4 2.5 3.8 5.6 3.8 9s-1.4 6.5-3.8 9c-2.4-2.5-3.8-5.6-3.8-9S9.6 5.5 12 3Z',
  layers: 'M12 3.6 3.6 8 12 12.4 20.4 8 12 3.6ZM3.6 12.4 12 16.8l8.4-4.4M3.6 16.8 12 21.2l8.4-4.4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10.2 17.2L16 16',
  sort: 'M7 4v15M4 16.5 7 20l3-3.5M17 20V5M14 7.5 17 4l3 3.5',
  import:
    'M12 3.5v11M8.2 10.8 12 14.6l3.8-3.8M4 16.5v2.2A1.8 1.8 0 0 0 5.8 20.5h12.4a1.8 1.8 0 0 0 1.8-1.8v-2.2',
  settings: 'M4 7h16M4 12h16M4 17h16M9 5v4M15 10v4M11 15v4',
  grid: 'M4 4.5h6.2v6.2H4zM13.8 4.5H20v6.2h-6.2zM4 13.3h6.2v6.2H4zM13.8 13.3H20v6.2h-6.2z',
  detail: 'M4 5.5h16v13H4zM4 9.6h16',
  list: 'M4 6h.01M4 12h.01M4 18h.01M8 6h12M8 12h12M8 18h12',
  check: 'M4.5 12.5 9 17l10.5-10.5',
  offline: 'M4 8.5h16v10H4zM3 3l18 18',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.4h.01',
  warning: 'M12 4.3 21 20H3L12 4.3ZM12 10.2v4.4M12 17.4h.01',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6',
  minimize: 'M5 12h14',
  maximize: 'M5.5 5.5h13v13h-13z',
  restore: 'M8 8V5.5h10.5V16H16M5.5 8h10.5v10.5H5.5z',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11'
}
