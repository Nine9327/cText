-- ============================================================
-- 001_initial —— cText 初始表结构
-- 时间戳一律 Unix ms（INTEGER），所有 SQL 参数由调用方绑定
-- 注意：所有 DDL 必须幂等可重放（迁移只在 user_version 落后时执行一次）
-- ============================================================

-- 书库根目录（多根目录 / 离线检测）
CREATE TABLE library_roots (
  id            TEXT PRIMARY KEY,               -- ulid
  label         TEXT NOT NULL,                  -- 侧栏显示名，如「移动硬盘」
  path          TEXT NOT NULL UNIQUE,           -- 绝对路径
  volume_guid   TEXT,                           -- 可选的卷标识（辅助换盘符识别）
  state         TEXT NOT NULL DEFAULT 'online', -- online | offline
  sort          INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  created_at    INTEGER NOT NULL
);

-- 书源（保留「阅读 3.0」原始 JSON，便于回写与再导出）
CREATE TABLE book_sources (
  id              TEXT PRIMARY KEY,
  book_source_url TEXT NOT NULL UNIQUE,         -- bookSourceUrl
  name            TEXT NOT NULL,                -- bookSourceName
  "group"         TEXT,                         -- bookSourceGroup
  enabled         INTEGER NOT NULL DEFAULT 1,
  custom_order    INTEGER NOT NULL DEFAULT 0,
  compat_level    TEXT NOT NULL DEFAULT 'full', -- full | partial | unsupported
  compat_note     TEXT,                         -- 不兼容原因（导入时写入）
  rule_json       TEXT NOT NULL,                -- 原始书源 JSON
  last_used_at    INTEGER,
  created_at      INTEGER NOT NULL
);

-- 书籍
CREATE TABLE books (
  id            TEXT PRIMARY KEY,                     -- ulid
  title         TEXT NOT NULL,
  author        TEXT,
  series        TEXT,
  format        TEXT NOT NULL,                        -- txt | epub | pdf
  root_id       TEXT REFERENCES library_roots(id),    -- 网络书为 NULL
  rel_path      TEXT,                                 -- 相对 root 的路径；网络书为 NULL
  file_hash     TEXT NOT NULL,                        -- 网络书用 sourceUrl 派生
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  encoding      TEXT,
  cover_path    TEXT,                                 -- 封面缓存相对路径
  intro         TEXT,
  publisher     TEXT,
  pub_date      TEXT,
  language      TEXT,
  word_count    INTEGER,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  source_type   TEXT NOT NULL DEFAULT 'local',        -- local | network
  source_id     TEXT REFERENCES book_sources(id),
  source_url    TEXT,                                 -- 网络书详情页 URL（= bookUrl）
  favorite      INTEGER NOT NULL DEFAULT 0,
  read_state    TEXT NOT NULL DEFAULT 'unread',       -- unread | reading | finished
  progress      REAL NOT NULL DEFAULT 0,              -- 0..1
  last_read_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

-- 同一根目录内路径唯一；不同根目录允许同名同路径
CREATE UNIQUE INDEX idx_books_root_relpath ON books(root_id, rel_path)
  WHERE root_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_books_hash ON books(file_hash)
  WHERE source_type = 'local' AND deleted_at IS NULL;
CREATE INDEX idx_books_last_read ON books(last_read_at DESC);
CREATE INDEX idx_books_root ON books(root_id);
CREATE INDEX idx_books_fav ON books(favorite) WHERE favorite = 1;

-- 书籍可用性由 join 派生，不落冗余字段：
--   SELECT b.*, r.state AS root_state FROM books b
--   LEFT JOIN library_roots r ON r.id = b.root_id

-- 章节
CREATE TABLE chapters (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  anchor  TEXT,          -- epub href / txt 字节偏移 / 网络书章节 URL
  length  INTEGER,
  level   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, idx)
);

-- 阅读进度
CREATE TABLE reading_progress (
  book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL DEFAULT 0,
  offset      INTEGER NOT NULL DEFAULT 0,
  percent     REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- 书架（与「收藏」「分类」是三套独立语义）
CREATE TABLE shelves (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE shelf_books (
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (shelf_id, book_id)
);

-- 分类（题材标签）
CREATE TABLE categories (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT,
  sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE book_categories (
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, category_id)
);

-- 书签 / 笔记
CREATE TABLE bookmarks (
  id          TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  offset      INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'bookmark', -- bookmark | highlight
  text        TEXT,
  note        TEXT,
  color       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_bookmarks_book ON bookmarks(book_id, chapter_idx);

-- 设置（键值，值存 JSON）
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 全文检索：外部内容表，正文由 books 提供，故必须靠触发器保持同步
CREATE VIRTUAL TABLE books_fts USING fts5(
  title,
  author,
  intro,
  content='books',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER books_fts_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, author, intro)
  VALUES (new.rowid, new.title, new.author, new.intro);
END;

CREATE TRIGGER books_fts_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, intro)
  VALUES ('delete', old.rowid, old.title, old.author, old.intro);
END;

CREATE TRIGGER books_fts_au AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, intro)
  VALUES ('delete', old.rowid, old.title, old.author, old.intro);
  INSERT INTO books_fts(rowid, title, author, intro)
  VALUES (new.rowid, new.title, new.author, new.intro);
END;
