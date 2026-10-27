"""TXT 解析（M1-04）：编码探测、元数据、章节目录。

产出三条契约（`产品文档.md` §3.5）：
    parse.detect      → { format, encoding, size }
    parse.meta        → { title, author, intro, coverPath, lang }
    parse.txt.outline → { encoding, chapters: [{idx, title, level, offset, length}] }

**offset 是字节偏移**（`chapters.anchor` 的约定），不是字符偏移——
M2-02 的 `parse.txt.read` 要按字节区间 seek，用字符偏移会让非 ASCII 文本整体错位。
UTF-16/32 无法按 `b'\\n'` 切分，走整体解码后用「重新编码长度」累计偏移，精度一致。

章节识别分强弱两档：
    强档：第X卷/部/篇/集（level 0）、第X章/回/节/话（level 1）、
          楔子/序章/尾声/番外… 这类固定词、英文 Chapter/Part（level 1）
    弱档：「1. 标题」「001 标题」这类纯数字行
弱档**只在强档命中少于 3 条时启用**——正文里的编号列表（「1. xxx」）太多，
无条件启用会把目录炸成几百条垃圾。
"""

from __future__ import annotations

import os
import re

from paths import SUPPORTED_FORMATS, format_of, require_path  # noqa: F401  (对外仍可 parse_txt.xxx)
from rpc import ERROR_INVALID_ARGUMENT, WorkerError, method
from textenc import detect_encoding, is_wide_encoding, normalize_encoding

# 中文数字 + 阿拉伯数字。含大写与「〇」「两」这些实际会出现在章节名里的写法
CN_NUM = "零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟"

# 标题行的长度上限：超过这个长度基本可以断定是正文段落而不是标题
MAX_TITLE_LEN = 50

# 强档命中少于这个数时才启用弱档
WEAK_FALLBACK_THRESHOLD = 3

# 单章无章节标记时，整本作为一章返回
WHOLE_BOOK_TITLE = "全文"

# 元数据提取只读前这么多行，避免为了找「作者：」把 200MB 读一遍
META_SCAN_LINES = 300

# 简介截断长度
INTRO_LIMIT = 400

RE_VOLUME = re.compile(rf"^第[{CN_NUM}\d]{{1,12}}[卷部篇集]")
RE_CHAPTER = re.compile(rf"^第[{CN_NUM}\d]{{1,12}}[章回节话]")
RE_SPECIAL = re.compile(
    r"^(楔子|序章|序言|自序|序|前言|引子|引言|尾声|后记|终章|番外|外传|附录|作者的话|完本感言)(?:\s|$)"
)
RE_EN = re.compile(r"^(chapter|part|volume|book)\s+[\divxlcdm]+", re.IGNORECASE)
RE_WEAK = re.compile(r"^\d{1,4}(?:[.、．]\s*|\s+)\S")

RE_FIELD = re.compile(r"^\s*(书名|作者|著者|简介|内容简介|文案|状态|字数|类别|标签)\s*[:：]\s*(.*)$")

CJK_RANGE = ("\u4e00", "\u9fff")


# ---------------------------------------------------------------- 章节识别


def classify_heading(text: str) -> tuple[str, int] | None:
    """判断一行是不是章节标题。返回 `(标题, level)`，不是则 None。

    level 语义：**0 = 卷/部（上层），1 = 章/回/节，2 = 更细的层级**。
    与目录树的层级方向一致——数字越小越靠近根。
    """
    stripped = text.strip()
    if not stripped or len(stripped) > MAX_TITLE_LEN:
        return None
    if RE_VOLUME.match(stripped):
        return stripped, 0
    if RE_CHAPTER.match(stripped):
        return stripped, 1
    if RE_SPECIAL.match(stripped):
        return stripped, 1
    if RE_EN.match(stripped):
        return stripped, 1
    return None


def classify_weak(text: str) -> tuple[str, int] | None:
    """弱档：纯数字编号行。只在强档几乎没命中时才用。"""
    stripped = text.strip()
    if not stripped or len(stripped) > MAX_TITLE_LEN:
        return None
    if RE_WEAK.match(stripped):
        return stripped, 1
    return None


def _scan_narrow(path: str, encoding: str, bom_len: int, weak: bool) -> list[tuple[int, str, int]]:
    """按 `b'\\n'` 逐行扫描，累计字节偏移。

    GBK 与 UTF-8 的尾字节范围都不含 0x0A，所以按字节切行是安全的，
    不需要先整体解码——这对 200MB 的文件是决定性的（内存占用是常数）。
    """
    matcher = classify_weak if weak else classify_heading
    hits: list[tuple[int, str, int]] = []
    offset = bom_len

    with open(path, "rb") as f:
        f.seek(bom_len)
        for raw in f:
            found = matcher(raw.decode(encoding, errors="replace").rstrip("\r\n"))
            if found:
                hits.append((offset, found[0], found[1]))
            offset += len(raw)

    return hits


def _scan_wide(path: str, encoding: str, bom_len: int, weak: bool) -> list[tuple[int, str, int]]:
    """UTF-16/32 的扫描：整体解码后按行切，偏移用「重新编码后的长度」累计。

    这类文件在中文 TXT 里极罕见，牺牲内存换正确性可以接受。
    """
    matcher = classify_weak if weak else classify_heading
    with open(path, "rb") as f:
        f.seek(bom_len)
        text = f.read().decode(encoding, errors="replace")

    hits: list[tuple[int, str, int]] = []
    offset = bom_len
    for line in text.split("\n"):
        found = matcher(line.rstrip("\r"))
        if found:
            hits.append((offset, found[0], found[1]))
        offset += len((line + "\n").encode(encoding, errors="replace"))

    return hits


def scan_chapters(path: str, encoding: str, bom_len: int) -> list[tuple[int, str, int]]:
    """先强档；命中太少再试弱档，取命中更多的那个。"""
    scanner = _scan_wide if is_wide_encoding(encoding) else _scan_narrow

    hits = scanner(path, encoding, bom_len, weak=False)
    if len(hits) >= WEAK_FALLBACK_THRESHOLD:
        return hits

    weak_hits = scanner(path, encoding, bom_len, weak=True)
    return weak_hits if len(weak_hits) > len(hits) else hits


def build_outline(hits: list[tuple[int, str, int]], size: int) -> list[dict]:
    """把命中点补齐 length（到下一章的偏移，最后一章到文件末尾）。

    一章都没命中时返回单章「全文」——不是所有 TXT 都有章节标记，
    没有兜底的话阅读器会拿到空目录、整本书无法打开。
    """
    if not hits:
        return [{"idx": 0, "title": WHOLE_BOOK_TITLE, "level": 1, "offset": 0, "length": size}]

    chapters = []
    for i, (offset, title, level) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else size
        chapters.append(
            {
                "idx": i,
                "title": title,
                "level": level,
                "offset": offset,
                # 极端情况下（重复偏移）可能为 0，clamp 到 0 而不是负数
                "length": max(end - offset, 0),
            }
        )
    return chapters


# ---------------------------------------------------------------- 元数据


def _strip_brackets(text: str) -> str:
    return re.sub(r"[《》]", "", text).strip()


def meta_from_filename(path: str) -> tuple[str | None, str | None]:
    """从文件名猜书名与作者。TXT 没有内嵌元数据，文件名是唯一的先验信息。

    覆盖四种常见命名：`《书名》作者` / `[作者]书名` / `书名 - 作者` / `书名_作者`。
    """
    stem = os.path.splitext(os.path.basename(path))[0].strip()
    if not stem:
        return None, None

    m = re.match(r"^《(.+?)》\s*(.*)$", stem)
    if m:
        return m.group(1).strip() or None, m.group(2).strip() or None

    m = re.match(r"^[\[【](.+?)[\]】]\s*(.+)$", stem)
    if m:
        return m.group(2).strip() or None, m.group(1).strip() or None

    # 分隔符两侧带空格的更可信（书名本身可能含连字符）
    m = re.match(r"^(.+?)\s+[-—–]\s+(.+)$", stem)
    if m:
        return m.group(1).strip() or None, m.group(2).strip() or None

    m = re.match(r"^(.+?)_(.+)$", stem)
    if m:
        return m.group(1).strip() or None, m.group(2).strip() or None

    return stem, None


def _read_head_lines(path: str, encoding: str, bom_len: int, limit: int) -> list[str]:
    """读前 limit 行。遇到解码错误用 replace，不因为个别坏字节放弃整个头部。"""
    lines: list[str] = []
    with open(path, "rb") as f:
        f.seek(bom_len)
        for raw in f:
            lines.append(raw.decode(encoding, errors="replace").rstrip("\r\n"))
            if len(lines) >= limit:
                break
    return lines


def guess_lang(text: str) -> str | None:
    """按汉字占比猜语言。只区分「中文 / 不确定」，不做多语言识别。"""
    if not text:
        return None
    sample = text[:4000]
    cjk = sum(1 for ch in sample if CJK_RANGE[0] <= ch <= CJK_RANGE[1])
    return "zh" if cjk / max(len(sample), 1) > 0.05 else None


def txt_meta(path: str, encoding: str, bom_len: int) -> dict:
    """从文件头 + 文件名提取元数据。

    优先级：文件头里的「作者：」比文件名可靠（文件名常被下载站改名）；
    书名反过来——「书名：」这一行在 TXT 里不如文件名普遍，所以文件名优先。
    """
    lines = _read_head_lines(path, encoding, bom_len, META_SCAN_LINES)

    title_line: str | None = None
    author_line: str | None = None
    intro_line: str | None = None
    body_before_chapter: list[str] = []

    for line in lines:
        # 遇到第一个章节标题就停止收集「正文前文本」
        if classify_heading(line):
            break
        found = RE_FIELD.match(line)
        if found:
            key, value = found.group(1), found.group(2).strip()
            if key == "书名" and value and not title_line:
                title_line = _strip_brackets(value)
            elif key in ("作者", "著者") and value and not author_line:
                # 「作者：张三 著」这类写法，去掉尾部常见后缀
                author_line = re.sub(r"\s*(著|编著|编写|译)$", "", value).strip() or None
            elif key in ("简介", "内容简介", "文案") and value and not intro_line:
                intro_line = value
        elif line.strip():
            body_before_chapter.append(line.strip())

    file_title, file_author = meta_from_filename(path)

    title = file_title or title_line
    author = author_line or file_author

    if intro_line:
        intro = intro_line[:INTRO_LIMIT]
    elif body_before_chapter:
        joined = " ".join(body_before_chapter).strip()
        # 太短的「正文前文本」多半是版权声明或空白，不当简介
        intro = joined[:INTRO_LIMIT] if len(joined) >= 80 else None
    else:
        intro = None

    return {
        "title": title,
        "author": author,
        "intro": intro,
        "coverPath": None,
        "lang": guess_lang(" ".join(body_before_chapter) or (title or "")),
        "encoding": encoding,
    }


# ---------------------------------------------------------------- 方法


@method("parse.detect")
def parse_detect(params: dict) -> dict:
    path = require_path(params)
    fmt = format_of(path)
    if fmt is None:
        raise WorkerError(ERROR_INVALID_ARGUMENT, "不支持的文件格式")

    # EPUB 是 zip 容器，对它跑编码探测既没意义也很贵（要读 16KB 二进制）。
    # encoding 回 None 而不是空串，调用方能据此区分「未探测」与「探测结果为空」
    encoding = None if fmt == "epub" else detect_encoding(path)[0]
    return {"format": fmt, "encoding": encoding, "size": os.path.getsize(path)}


@method("parse.meta")
def parse_meta(params: dict) -> dict:
    path = require_path(params)
    fmt = params.get("format") or format_of(path)
    if fmt not in ("txt", "epub"):
        raise WorkerError(ERROR_INVALID_ARGUMENT, "不支持的文件格式")

    if fmt == "epub":
        # 延迟导入：让「只解析 TXT」的场景不必加载 lxml/zip 相关的模块
        from methods.parse_epub import epub_meta

        return epub_meta(path)

    encoding, bom_len = detect_encoding(path)
    return txt_meta(path, encoding, bom_len)


@method("parse.txt.outline")
def parse_txt_outline(params: dict) -> dict:
    path = require_path(params)

    detected, bom_len = detect_encoding(path)
    requested = params.get("encoding")
    encoding = detected if not requested or requested == "auto" else normalize_encoding(requested)

    size = os.path.getsize(path)
    hits = scan_chapters(path, encoding, bom_len)
    chapters = build_outline(hits, size)

    return {
        "encoding": encoding,
        # 探测到的编码一起回传，让调用方能显示「本文件按 GB18030 解析」
        "detectedEncoding": detected,
        "chapters": chapters,
        "lineHits": len(hits),
    }
