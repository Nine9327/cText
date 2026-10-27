"""EPUB 解析（M1-05）：目录、元数据、内嵌封面。

契约（`docs/产品文档.md` §3.5）：
    parse.epub.toc   path → chapters[]（href + 层级）
    parse.meta       path, format → title, author, intro, coverPath, lang
    cover.extract    path, destDir → coverPath

**`parse.meta` 不写任何文件**。契约里虽然有 `coverPath` 字段，但「探测元数据」
是只读语义：M1-07 的导入预览会反复调它，每次都落一张封面纯属浪费，而且会把
「只读探测」变成有副作用的操作。EPUB 分支改为回传 `coverHref`（清单里的图片路径），
真正写盘只在 `cover.extract` 里发生。

**`parse.epub.chapter` 不在本任务范围**：它属于 M2-03（EPUB 渲染），
要把 XHTML 转成安全 HTML 并抽图片资源，与「能不能导入」是两件事。
"""

from __future__ import annotations

import os
import tempfile

from epub import MAX_COVER_BYTES, image_ext, open_epub, write_cover
from paths import require_dir, require_path
from rpc import method

# 没传 destDir 时的落点。生产环境由主进程传 userData/covers，
# 这里给临时目录只是为了让自检和手工调试不必构造参数
DEFAULT_COVER_DIR = os.path.join(tempfile.gettempdir(), "ctext-covers")


def epub_meta(path: str) -> dict:
    """OPF 元数据 + 封面所在位置（不落盘）。供 `parse.meta` 的 EPUB 分支调用。"""
    with open_epub(path) as book:
        data = book.metadata()
        href, source = book.cover_href()

    data["coverHref"] = href
    data["coverSource"] = source or None
    # 契约字段，明确是 None：封面文件由 cover.extract 产出
    data["coverPath"] = None
    return data


@method("parse.epub.toc")
def parse_epub_toc(params: dict) -> dict:
    path = require_path(params)

    with open_epub(path) as book:
        chapters, source = book.chapters()
        meta = book.metadata()
        spine_count = len(book.spine)

    rows = [
        {
            "idx": index,
            "title": chapter["title"],
            "level": chapter["level"],
            # href 是 zip 内完整路径，M1-06 直接写进 chapters.anchor
            "href": chapter["href"],
        }
        for index, chapter in enumerate(chapters)
    ]

    return {
        "chapters": rows,
        "chapterCount": len(rows),
        "source": source,
        "spineCount": spine_count,
        "version": meta.get("epubVersion"),
        # 目录为空是「能导入但没有目录」，不是失败：M2 会退化成「全文滚动」
        "empty": len(rows) == 0,
    }


@method("cover.extract")
def cover_extract(params: dict) -> dict:
    path = require_path(params)
    dest_dir = require_dir(params, "destDir") or DEFAULT_COVER_DIR

    with open_epub(path) as book:
        found = book.cover_bytes()

    if not found:
        # 没有封面是常态（纯文本 EPUB），不是错误
        return {"coverPath": None, "reason": "no-cover"}

    data, href, source = found
    if image_ext(data, href) is None:  # cover_bytes 已校验过，双保险
        return {"coverPath": None, "reason": "invalid-image"}

    result = write_cover(data, href, dest_dir)
    result["source"] = source
    result["coverHref"] = href
    result["maxBytes"] = MAX_COVER_BYTES
    return result
