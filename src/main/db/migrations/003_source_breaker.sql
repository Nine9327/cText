-- ============================================================
-- 003_source_breaker —— 书源熔断状态（M4-12）
-- 时间戳一律 Unix ms（INTEGER），所有 SQL 参数由调用方绑定
--
-- 为什么不复用 enabled：enabled 是用户的意图，熔断是运行时的临时状态。
-- 写进同一列会让用户在设置页看到一个自己没关过的开关。
-- ============================================================

ALTER TABLE book_sources ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_sources ADD COLUMN breaker_until INTEGER;
ALTER TABLE book_sources ADD COLUMN last_failure TEXT;
