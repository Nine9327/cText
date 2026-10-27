"""M1-05 自检：EPUB 目录层级、OPF 元数据、封面提取、损坏/加密识别。

跑在 Python 侧的原因和 M1-04 一样：**样本本身要按结构生成**（nav / ncx / 不同封面约定 /
不同 OPF 位置），生成器是 Python 的（`make_epub.py`），断言自然也在同一侧。

`--emit DIR` 会把全部样本留在 DIR 里，供 `src/main/library/epub-smoke.ts`
走 Electron → NDJSON → worker 的真实链路复用同一批文件。

用法：`.venv/Scripts/python.exe python/smoke_epub.py [--emit DIR]`
输出：`SMOKE EPUB PASS/FAIL 名称 (细节)` + `SMOKE EPUB SUMMARY n/m`
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "ctext_worker"))

# Windows 控制台默认 cp936，中文断言名会乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from make_epub import build_epub, tiny_png  # noqa: E402
from methods.parse_epub import cover_extract, parse_epub_toc  # noqa: E402
from methods.parse_txt import parse_detect, parse_meta  # noqa: E402
from rpc import WorkerError  # noqa: E402

checks: list[tuple[str, bool, str]] = []
samples: list[tuple[str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), str(detail)))


def expect_error(name: str, code: str, fn) -> str:
    """断言抛出指定错误码，返回 message 供进一步检查。"""
    try:
        fn()
    except WorkerError as err:
        check(name, err.code == code, err.code)
        return err.message
    except Exception as err:  # noqa: BLE001
        check(name, False, f"非 WorkerError: {err!r}")
        return ""
    check(name, False, "未抛错")
    return ""


def sample(base: str, name: str, **kwargs) -> str:
    path = os.path.join(base, name)
    build_epub(path, **kwargs)
    samples.append((name, path))
    return path


def levels_of(chapters: list[dict]) -> list[int]:
    return [c["level"] for c in chapters]


def titles_of(chapters: list[dict]) -> list[str]:
    return [c["title"] for c in chapters]


# ---------------------------------------------------------------- 目录


def run_toc(base: str) -> None:
    flat = [
        {"title": "第一章 开始", "href": "Text/1.xhtml"},
        {"title": "第二章 继续", "href": "Text/2.xhtml"},
        {"title": "第三章 转折", "href": "Text/3.xhtml"},
        {"title": "第四章 结束", "href": "Text/4.xhtml"},
        {"title": "第五章 尾声", "href": "Text/5.xhtml"},
    ]
    path = sample(base, "toc_flat.epub", title="平铺目录", nav_tree=flat)
    result = parse_epub_toc({"path": path})
    check("平铺 nav 命中 5 章", result["chapterCount"] == 5, str(result["chapterCount"]))
    check("平铺 nav 来源为 nav", result["source"] == "nav", result["source"])
    check("平铺 nav 全部 level=1", all(level == 1 for level in levels_of(result["chapters"])), str(levels_of(result["chapters"])))
    check("平铺 nav 标题顺序保持", titles_of(result["chapters"]) == [n["title"] for n in flat], str(titles_of(result["chapters"])))
    check("chapterCount 与 chapters 长度一致", result["chapterCount"] == len(result["chapters"]), "一致")
    check("idx 从 0 连续", [c["idx"] for c in result["chapters"]] == list(range(5)), "连续")

    # 卷 / 章 两层：顶层是卷（level 0），子层是章（level 1）
    volumes = [
        {
            "title": "第一卷 风起",
            "href": None,
            "children": [
                {"title": "第一章 开始", "href": "Text/1.xhtml"},
                {"title": "第二章 继续", "href": "Text/2.xhtml"},
            ],
        },
        {
            "title": "第二卷 云涌",
            "href": None,
            "children": [
                {"title": "第三章 转折", "href": "Text/3.xhtml"},
                {"title": "第四章 结束", "href": "Text/4.xhtml"},
            ],
        },
    ]
    path = sample(base, "toc_volume.epub", title="分卷目录", nav_tree=volumes)
    result = parse_epub_toc({"path": path})
    check("卷章结构命中 6 条", result["chapterCount"] == 6, str(result["chapterCount"]))
    check("卷章层级为 0/1/1/0/1/1", levels_of(result["chapters"]) == [0, 1, 1, 0, 1, 1], str(levels_of(result["chapters"])))
    first_volume = result["chapters"][0]
    check("非链接分卷继承首个子节点 href", first_volume["href"] == "OEBPS/Text/1.xhtml", str(first_volume["href"]))
    check("分卷标题保留原文", first_volume["title"] == "第一卷 风起", first_volume["title"])

    # 三层：部 / 卷 / 章
    three = [
        {
            "title": "第一部 少年",
            "href": None,
            "children": [
                {
                    "title": "第一卷 出发",
                    "href": None,
                    "children": [
                        {"title": "第一章 启程", "href": "Text/1.xhtml"},
                        {"title": "第二章 遇险", "href": "Text/2.xhtml"},
                    ],
                }
            ],
        }
    ]
    path = sample(base, "toc_three.epub", title="三层目录", nav_tree=three)
    result = parse_epub_toc({"path": path})
    # 真正的三层结构不该被「包装层拆解」误伤：4 个节点各占一层
    check("三层目录命中 4 条", result["chapterCount"] == 4, str(result["chapterCount"]))
    check("三层层级为 0/1/2/2", levels_of(result["chapters"]) == [0, 1, 2, 2], str(levels_of(result["chapters"])))
    check("三层目录保留部标题", result["chapters"][0]["title"] == "第一部 少年", result["chapters"][0]["title"])

    # 单层包装（"目录" 包住所有章节）必须拆掉，否则所有章节都被压深一层
    single = [{"title": "目录", "href": None, "children": flat}]
    path = sample(base, "toc_single_root.epub", title="单层包装", nav_tree=single)
    result = parse_epub_toc({"path": path})
    check("单层包装被拆解", result["chapterCount"] == 5, str(result["chapterCount"]))
    check("拆解后章节仍为 level 1", all(level == 1 for level in levels_of(result["chapters"])), str(levels_of(result["chapters"])))

    # 包装 + 分卷：拆一层后正好是「卷 / 章」
    wrapped = [{"title": "正文", "href": None, "children": volumes}]
    path = sample(base, "toc_wrapped_volume.epub", title="包装加分卷", nav_tree=wrapped)
    result = parse_epub_toc({"path": path})
    check("包装+分卷层级仍为 0/1", levels_of(result["chapters"])[:3] == [0, 1, 1], str(levels_of(result["chapters"])))

    # EPUB2 只有 toc.ncx
    ncx = [
        {"title": "第一章 开始", "href": "Text/1.xhtml"},
        {"title": "第二章 继续", "href": "Text/2.xhtml"},
        {"title": "第三章 转折", "href": "Text/3.xhtml"},
        {"title": "第四章 结束", "href": "Text/4.xhtml"},
    ]
    path = sample(base, "toc_ncx.epub", title="EPUB2 目录", version="2.0", ncx_tree=ncx)
    result = parse_epub_toc({"path": path})
    check("EPUB2 只有 ncx 时来源为 ncx", result["source"] == "ncx", result["source"])
    check("ncx 命中 4 章", result["chapterCount"] == 4, str(result["chapterCount"]))
    check("ncx 标题正确", titles_of(result["chapters"]) == [n["title"] for n in ncx], str(titles_of(result["chapters"])))
    check("ncx 章节为 level 1", all(level == 1 for level in levels_of(result["chapters"])), str(levels_of(result["chapters"])))

    # nav 与 ncx 同时存在 → nav 优先（EPUB3 的 nav 才是权威）
    path = sample(
        base,
        "toc_both.epub",
        title="双目录",
        nav_tree=[{"title": "nav 标题", "href": "Text/1.xhtml"}],
        ncx_tree=[{"title": "ncx 标题", "href": "Text/1.xhtml"}],
        pages=[("Text/1.xhtml", "正文")],
    )
    result = parse_epub_toc({"path": path})
    check("nav 与 ncx 并存时优先 nav", result["source"] == "nav", result["source"])
    check("优先 nav 时标题取自 nav", result["chapters"][0]["title"] == "nav 标题", result["chapters"][0]["title"])

    # 完全没有目录文件 → 按 spine 顺序兜底
    path = sample(
        base,
        "toc_spine.epub",
        title="无目录",
        pages=[
            ("Text/1.xhtml", "第一章 开始"),
            ("Text/2.xhtml", "第二章 继续"),
            ("Text/3.xhtml", "第三章 结束"),
        ],
    )
    result = parse_epub_toc({"path": path})
    check("无 nav/ncx 时来源为 spine", result["source"] == "spine", result["source"])
    check("spine 兜底章数等于文档数", result["chapterCount"] == 3, str(result["chapterCount"]))
    check("spine 兜底标题取自 <title>", result["chapters"][0]["title"] == "第一章 开始", result["chapters"][0]["title"])
    check("spine 兜底为 level 1", all(level == 1 for level in levels_of(result["chapters"])), str(levels_of(result["chapters"])))

    # nav 文件在子目录，href 用 .. 回退
    path = sample(
        base,
        "toc_deep_nav.epub",
        title="子目录目录",
        nav_tree=[{"title": "第一章", "href": "Text/1.xhtml"}, {"title": "第二章", "href": "Text/2.xhtml"}],
        nav_dir="nav",
        pages=[("Text/1.xhtml", "第一章"), ("Text/2.xhtml", "第二章")],
    )
    result = parse_epub_toc({"path": path})
    check("子目录 nav 的 ../ href 正确归一", result["chapters"][0]["href"] == "OEBPS/Text/1.xhtml", str(result["chapters"][0]["href"]))
    check("子目录 nav 仍解析出 2 章", result["chapterCount"] == 2, str(result["chapterCount"]))

    # 中文文件名 + 百分号编码（真实 EPUB 的主流写法）
    cn_pages = [("正文/第一章.xhtml", "第一章 开始"), ("正文/第二章.xhtml", "第二章 继续")]
    path = sample(
        base,
        "toc_cn_href.epub",
        title="中文文件名",
        nav_tree=[{"title": "第一章 开始", "href": cn_pages[0][0]}, {"title": "第二章 继续", "href": cn_pages[1][0]}],
        pages=cn_pages,
        percent_encode_hrefs=True,
    )
    result = parse_epub_toc({"path": path})
    check("百分号编码的 href 被解码", result["chapters"][0]["href"] == "OEBPS/正文/第一章.xhtml", str(result["chapters"][0]["href"]))

    # OPF 放在包根（没有 OEBPS 这一层）
    path = sample(
        base,
        "toc_root_opf.epub",
        title="根目录 OPF",
        opf_dir="",
        nav_tree=[{"title": "第一章", "href": "Text/1.xhtml"}, {"title": "第二章", "href": "Text/2.xhtml"}],
        pages=[("Text/1.xhtml", "第一章"), ("Text/2.xhtml", "第二章")],
    )
    result = parse_epub_toc({"path": path})
    check("根目录 OPF 的 href 不带多余前缀", result["chapters"][0]["href"] == "Text/1.xhtml", str(result["chapters"][0]["href"]))

    # container.xml 缺失 → 直接扫 .opf 兜底
    path = sample(
        base,
        "toc_no_container.epub",
        title="缺 container",
        include_container=False,
        nav_tree=[{"title": "第一章", "href": "Text/1.xhtml"}, {"title": "第二章", "href": "Text/2.xhtml"}],
        pages=[("Text/1.xhtml", "第一章"), ("Text/2.xhtml", "第二章")],
    )
    result = parse_epub_toc({"path": path})
    check("缺 container.xml 时仍能找到 OPF", result["chapterCount"] == 2, str(result["chapterCount"]))


# ---------------------------------------------------------------- 元数据


def run_meta(base: str) -> None:
    path = sample(
        base,
        "meta_full.epub",
        title="斗破苍穹",
        authors=[("天蚕土豆", None)],
        language="zh-CN",
        publisher="某某出版社",
        pub_date="2011-05-01",
        description="<p>少年<b>萧炎</b>的故事</p><p>从天才到废物，再回到巅峰。</p>",
        pages=[("Text/1.xhtml", "第一章")],
    )
    meta = parse_meta({"path": path, "format": "epub"})
    check("OPF 书名", meta["title"] == "斗破苍穹", str(meta["title"]))
    check("OPF 作者", meta["author"] == "天蚕土豆", str(meta["author"]))
    check("OPF 语言", meta["lang"] == "zh-CN", str(meta["lang"]))
    check("OPF 出版社", meta["publisher"] == "某某出版社", str(meta["publisher"]))
    check("OPF 出版日期", meta["pubDate"] == "2011-05-01", str(meta["pubDate"]))
    check("OPF 版本号", meta["epubVersion"] == "3.0", str(meta["epubVersion"]))
    check("简介剥掉 HTML 标签", meta["intro"] and "<" not in meta["intro"], str(meta["intro"]))
    check("简介内容完整保留", "从天才到废物" in (meta["intro"] or ""), str(meta["intro"]))
    check("parse.meta 不落封面文件", meta["coverPath"] is None, str(meta["coverPath"]))

    # 多 creator 时优先 opf:role="aut"，否则译者会顶替作者
    path = sample(
        base,
        "meta_role.epub",
        title="有译者",
        authors=[("某某 译", "trl"), ("张三", "aut")],
        pages=[("Text/1.xhtml", "第一章")],
    )
    meta = parse_meta({"path": path, "format": "epub"})
    check("多 creator 时优先 role=aut", meta["author"] == "张三", str(meta["author"]))

    # 极简 OPF：只有标题
    path = sample(base, "meta_min.epub", title="只有书名", language=None, pages=[("Text/1.xhtml", "第一章")])
    meta = parse_meta({"path": path, "format": "epub"})
    check("缺 dc:language 时返回 None", meta["lang"] is None, str(meta["lang"]))
    check("缺 dc:creator 时返回 None", meta["author"] is None, str(meta["author"]))
    check("缺 dc:description 时返回 None", meta["intro"] is None, str(meta["intro"]))

    # 超长简介要截断
    long_desc = "很长的一段简介。" * 200
    path = sample(base, "meta_long.epub", title="长简介", description=long_desc, pages=[("Text/1.xhtml", "第一章")])
    meta = parse_meta({"path": path, "format": "epub"})
    check("超长简介被截断到 400 字内", len(meta["intro"] or "") <= 400, str(len(meta["intro"] or "")))

    # 无 format 参数时按扩展名判定
    path = os.path.join(base, "meta_full.epub")
    by_ext = parse_meta({"path": path})
    check("不传 format 时按扩展名走 EPUB", by_ext["title"] == "斗破苍穹", str(by_ext["title"]))


# ---------------------------------------------------------------- 封面


def run_cover(base: str) -> None:
    covers_dir = os.path.join(base, "covers")
    hit = 0

    def extract(name: str) -> dict:
        return cover_extract({"path": os.path.join(base, name), "destDir": covers_dir})

    # ① EPUB2 的 <meta name="cover">
    path = sample(
        base,
        "cover_meta.epub",
        title="meta 封面",
        pages=[("Text/1.xhtml", "第一章")],
        # 文件名故意写 .jpg 但内容是 PNG：实现必须按魔数而不是扩展名决定落盘后缀
        cover={"filename": "images/cover.jpg", "how": "meta", "data": tiny_png(12, 16)},
    )
    result = extract("cover_meta.epub")
    check("meta 封面被提取", bool(result["coverPath"]), str(result["coverPath"]))
    check("meta 封面来源为 meta-cover", result.get("source") == "meta-cover", str(result.get("source")))
    if result["coverPath"]:
        hit += 1
        check("封面后缀按魔数判定（PNG 命名成 .jpg）", result["coverPath"].endswith(".png"), os.path.basename(result["coverPath"]))
        check("封面文件真的写到了磁盘", os.path.isfile(result["coverPath"]), result["coverPath"])
        check("封面尺寸取自图片本身", (result["width"], result["height"]) == (12, 16), f"{result['width']}x{result['height']}")
        check("封面字节数与源一致", result["bytes"] == len(tiny_png(12, 16)), str(result["bytes"]))

    # ② EPUB3 的 properties="cover-image"
    sample(
        base,
        "cover_props.epub",
        title="properties 封面",
        pages=[("Text/1.xhtml", "第一章")],
        cover={"filename": "images/art.png", "how": "properties"},
    )
    result = extract("cover_props.epub")
    check("properties 封面被提取", bool(result["coverPath"]), str(result["coverPath"]))
    check("properties 封面来源正确", result.get("source") == "properties", str(result.get("source")))
    hit += 1 if result["coverPath"] else 0

    # ③ guide 指向封面页（EPUB2 的另一半写法）
    sample(
        base,
        "cover_guide.epub",
        title="guide 封面",
        pages=[("Text/1.xhtml", "第一章")],
        cover={"filename": "images/front.png", "how": "guide", "id": "front-img"},
    )
    result = extract("cover_guide.epub")
    check("guide 封面被提取", bool(result["coverPath"]), str(result["coverPath"]))
    check("guide 封面来源正确", result.get("source") == "guide", str(result.get("source")))
    hit += 1 if result["coverPath"] else 0

    # ④ 只有文件名里带 cover
    sample(
        base,
        "cover_filename.epub",
        title="文件名封面",
        pages=[("Text/1.xhtml", "第一章")],
        cover={"filename": "images/mycover.png", "how": "filename", "id": "img1"},
    )
    result = extract("cover_filename.epub")
    check("文件名约定封面被提取", bool(result["coverPath"]), str(result["coverPath"]))
    check("文件名约定来源正确", result.get("source") == "filename", str(result.get("source")))
    hit += 1 if result["coverPath"] else 0

    # ⑤ 真正的 JPEG
    jpeg = _real_jpeg()
    if jpeg:
        sample(
            base,
            "cover_jpeg.epub",
            title="JPEG 封面",
            pages=[("Text/1.xhtml", "第一章")],
            cover={"filename": "images/c.jpg", "how": "meta", "data": jpeg, "media_type": "image/jpeg"},
        )
        result = extract("cover_jpeg.epub")
        check("JPEG 封面后缀为 jpg", (result["coverPath"] or "").endswith(".jpg"), os.path.basename(result["coverPath"] or ""))
        hit += 1 if result["coverPath"] else 0

    # ⑥ 没有封面：不是错误
    sample(base, "cover_none.epub", title="无封面", pages=[("Text/1.xhtml", "第一章")])
    result = extract("cover_none.epub")
    check("无封面时返回 None 而不报错", result["coverPath"] is None, str(result["coverPath"]))
    check("无封面时给出原因", result["reason"] == "no-cover", str(result["reason"]))

    # ⑦ 声明成 image/jpeg 其实是 XHTML —— 必须拒绝，不能落一个打不开的文件
    sample(
        base,
        "cover_bogus.epub",
        title="假封面",
        pages=[("Text/1.xhtml", "第一章")],
        cover={
            "filename": "images/cover.jpg",
            "how": "meta",
            "data": b'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
        },
    )
    result = extract("cover_bogus.epub")
    check("假封面不会落盘", result["coverPath"] is None, str(result["coverPath"]))
    check("假封面原因为 invalid-image", result["reason"] == "invalid-image", str(result["reason"]))

    # ⑧ 同一张封面重复提取幂等（文件名由内容哈希决定）
    first = extract("cover_meta.epub")["coverPath"]
    second = extract("cover_meta.epub")["coverPath"]
    check("封面提取幂等（同内容同文件名）", first == second and bool(first), os.path.basename(first or ""))

    rate = hit / 5
    check(f"封面提取率 ≥90%（{hit}/5）", rate >= 0.9, f"{rate:.0%}")


def _real_jpeg() -> bytes:
    try:
        from io import BytesIO

        from PIL import Image

        buffer = BytesIO()
        Image.new("RGB", (10, 14), (200, 30, 30)).save(buffer, "JPEG")
        return buffer.getvalue()
    except Exception:  # noqa: BLE001 —— Pillow 缺失时跳过该项
        return b""


# ---------------------------------------------------------------- 异常与边界


def run_errors(base: str) -> None:
    corrupt = os.path.join(base, "bad_corrupt.epub")
    with open(corrupt, "wb") as handle:
        handle.write(b"\x00\x01\x02 not a zip at all" * 20)
    expect_error("非 zip 文件报 E_PARSE_FAILED", "E_PARSE_FAILED", lambda: parse_epub_toc({"path": corrupt}))

    plain = os.path.join(base, "bad_text.epub")
    with open(plain, "wb") as handle:
        handle.write("这其实是一个 txt 文件，只是改了扩展名。".encode("utf-8"))
    expect_error("文本冒充 EPUB 报 E_PARSE_FAILED", "E_PARSE_FAILED", lambda: parse_epub_toc({"path": plain}))

    # 合法 zip 但没有任何 OPF
    import zipfile

    noopf = os.path.join(base, "bad_noopf.epub")
    with zipfile.ZipFile(noopf, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("readme.txt", "没有 OPF")
    message = expect_error("缺 OPF 报 E_PARSE_FAILED", "E_PARSE_FAILED", lambda: parse_epub_toc({"path": noopf}))
    check("缺 OPF 的提示指向清单", "OPF" in message, message)

    # 正文被 AES 加密 → 真 DRM
    drm = sample(
        base,
        "drm_content.epub",
        title="加密书",
        pages=[("Text/1.xhtml", "第一章")],
        nav_tree=[{"title": "第一章", "href": "Text/1.xhtml"}],
        encryption={"targets": ["OEBPS/Text/1.xhtml"]},
    )
    message = expect_error("正文加密报 E_PARSE_FAILED", "E_PARSE_FAILED", lambda: parse_epub_toc({"path": drm}))
    check("加密书提示 DRM", "DRM" in message, message)

    # 只有字体被混淆 → 这是 OCF 标准做法，必须正常解析
    font_only = sample(
        base,
        "font_obfuscated.epub",
        title="字体混淆",
        pages=[("Text/1.xhtml", "第一章"), ("Text/2.xhtml", "第二章")],
        nav_tree=[{"title": "第一章", "href": "Text/1.xhtml"}, {"title": "第二章", "href": "Text/2.xhtml"}],
        extra_files=[("fonts/main.ttf", b"\x00\x01\x00\x00fake-font")],
        encryption={
            "targets": ["OEBPS/fonts/main.ttf"],
            "algorithm": "http://www.idpf.org/2008/embedding",
        },
    )
    result = parse_epub_toc({"path": font_only})
    check("字体混淆不算 DRM，正常解析", result["chapterCount"] == 2, str(result["chapterCount"]))

    # 参数与格式判定
    expect_error("文件不存在报 E_NOT_FOUND", "E_NOT_FOUND", lambda: parse_epub_toc({"path": os.path.join(base, "nope.epub")}))
    expect_error("缺少 path 报 E_INVALID_ARGUMENT", "E_INVALID_ARGUMENT", lambda: parse_epub_toc({}))
    expect_error(
        "destDir 传相对路径被拒",
        "E_INVALID_ARGUMENT",
        lambda: cover_extract({"path": join_epub(base), "destDir": "relative/dir"}),
    )

    detected = parse_detect({"path": join_epub(base)})
    check("parse.detect 对 EPUB 返回 format=epub", detected["format"] == "epub", str(detected["format"]))
    check("parse.detect 不对 EPUB 做编码探测", detected["encoding"] is None, str(detected["encoding"]))
    check("parse.detect 返回真实大小", detected["size"] > 0, str(detected["size"]))


def join_epub(base: str) -> str:
    return os.path.join(base, "cover_meta.epub")


# ---------------------------------------------------------------- 性能


def run_perf(base: str) -> None:
    count = 500
    pages = [(f"Text/{index}.xhtml", f"第{index}章 标题{index}") for index in range(1, count + 1)]
    nav = [{"title": title, "href": href} for href, title in pages]
    path = sample(base, "perf_500.epub", title="五百章", pages=pages, nav_tree=nav)

    started = time.perf_counter()
    result = parse_epub_toc({"path": path})
    elapsed_ms = (time.perf_counter() - started) * 1000

    check("500 章目录全部解析", result["chapterCount"] == count, str(result["chapterCount"]))
    check(f"500 章目录解析耗时可接受（{os.path.getsize(path) // 1024}KB）", elapsed_ms < 2000, f"{elapsed_ms:.0f}ms")

    started = time.perf_counter()
    parse_meta({"path": path, "format": "epub"})
    meta_ms = (time.perf_counter() - started) * 1000
    check("500 章书的元数据解析耗时可接受", meta_ms < 1000, f"{meta_ms:.0f}ms")


# ---------------------------------------------------------------- 入口


def main() -> int:
    emit = None
    if "--emit" in sys.argv:
        index = sys.argv.index("--emit")
        if index + 1 < len(sys.argv):
            emit = os.path.abspath(sys.argv[index + 1])

    base = emit or tempfile.mkdtemp(prefix="ctext-epub-smoke-")
    os.makedirs(base, exist_ok=True)

    try:
        run_toc(base)
        run_meta(base)
        run_cover(base)
        run_errors(base)
        run_perf(base)
        check("样本总数 ≥20", len(samples) >= 20, f"{len(samples)} 个")
    except Exception as err:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        check("自检执行未抛异常", False, repr(err))
    finally:
        if not emit:
            shutil.rmtree(base, ignore_errors=True)

    for name, ok, detail in checks:
        suffix = f" ({detail})" if detail else ""
        print(f"SMOKE EPUB {'PASS' if ok else 'FAIL'} {name}{suffix}")

    failed = sum(1 for _, ok, _ in checks if not ok)
    print(f"SMOKE EPUB SUMMARY {len(checks) - failed}/{len(checks)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
