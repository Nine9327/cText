-- 002：书签/划线补「终点偏移」（M2-09）
--
-- 001 里的 bookmarks 只有 `offset`（起点）与 `text`。只靠 text 去找终点
-- 会在重复文本上出错（同一章里「他说」出现几十次），而划线必须精确到
-- 起止两个字符——重排后靠这两个整数就能原样还原，与页号无关。
--
-- 可空：`kind = 'bookmark'`（纯书签，标记一个位置）没有终点。
ALTER TABLE bookmarks ADD COLUMN end_offset INTEGER;
