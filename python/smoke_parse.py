"""M1-04 自检：编码探测、元数据、章节目录。

跑在 Python 侧而不是 Electron 里，因为**样本本身要用各种编码写出来**——
Node 没有内置 GBK 编码器，把样本生成搬到 TS 侧会引入一个 iconv 依赖，
只为了产测试数据，不划算。

由 `scripts/verify-txt.mjs` 调用（内部用仓库内 `.venv` 的 Python）。
输出格式与其它验收脚本一致：`SMOKE TXT PASS/FAIL 名称 (细节)` + 汇总行。

用法：`.venv/Scripts/python.exe python/smoke_parse.py`
"""

from __future__ import annotations

import codecs
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "ctext_worker"))

# Windows 控制台默认 cp936，中文断言名会乱码甚至抛 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from rpc import WorkerError  # noqa: E402
from methods.parse_txt import (  # noqa: E402
    classify_heading,
    meta_from_filename,
    parse_detect,
    parse_meta,
    parse_txt_outline,
)

# ---------------------------------------------------------------- 语料

# 约 200 字纯中文，足够让统计模型收敛
PROSE_CN = (
    "少年李三从山中走出，背着一把破旧的铁剑。他不知道前方等着自己的是什么，"
    "只知道师父临终前说过一句话：山下的世界比山上复杂得多。"
    "他不信。直到他遇到了那个卖糖葫芦的老人。"
    "老人笑眯眯地看着他，说这根糖葫芦不要钱，只要你替我办一件事。"
    "李三犹豫了很久，最终还是接过了那根糖葫芦。"
    "江湖，就这样开始了。"
)

PROSE_MIX = PROSE_CN + " He walked 10 miles and met 3 strangers on the road. 那是他第一次见到陌生人。"

EMOJI = "这本书里有一些表情符号 😀🎉🚀 和特殊字符。" * 30

RARE = "饕餮魑魅魍魉，龘靐齉爩。这些字在日常排版里很少见，但 GB18030 能表示它们。" * 10

ENGLISH = "Hello world. This is a plain English book with no CJK characters at all.\n" * 20

TRAD = (
    "少年李三從山中走出，背著一把破舊的鐵劍。他不知道前方等著自己的是什麼，"
    "只知道師父臨終前說過一句話：山下的世界比山上複雜得多。"
) * 4

ENCODING_CASES = [
    # (文件名, 编码器, 内容, 期望编码)
    ("utf8.txt", "utf-8", PROSE_CN, "utf-8"),
    ("utf8bom.txt", "utf-8-sig", PROSE_CN, "utf-8-sig"),
    ("gb18030.txt", "gb18030", PROSE_CN, "gb18030"),
    ("gbk.txt", "gbk", PROSE_CN, "gb18030"),  # GBK 归一为超集 gb18030
    ("utf16le_bom.txt", "utf-16", PROSE_CN, "utf-16-le"),
    ("utf16be_bom.txt", "utf-16-be-bom", PROSE_CN, "utf-16-be"),
    ("utf16le_nobom.txt", "utf-16-le", PROSE_CN, "utf-16-le"),
    ("utf16be_nobom.txt", "utf-16-be", PROSE_CN, "utf-16-be"),
    ("utf16le_mixed.txt", "utf-16-le", PROSE_MIX, "utf-16-le"),
    ("utf8_mixed.txt", "utf-8", PROSE_MIX, "utf-8"),
    ("gbk_mixed.txt", "gbk", PROSE_MIX, "gb18030"),
    ("utf8_bom_mixed.txt", "utf-8-sig", PROSE_MIX, "utf-8-sig"),
    ("utf8_emoji.txt", "utf-8", EMOJI, "utf-8"),
    ("gb18030_rare.txt", "gb18030", RARE, "gb18030"),
    ("ascii.txt", "ascii", ENGLISH, "utf-8"),
    ("big5.txt", "big5", TRAD, "big5"),  # 允许失败：统计模型不一定认得出繁体
    ("gb18030_long.txt", "gb18030", PROSE_CN * 4, "gb18030"),
    ("utf8_long.txt", "utf-8", PROSE_CN * 4, "utf-8"),
    ("gbk_english_heavy.txt", "gbk", PROSE_MIX * 2, "gb18030"),
    ("utf8_short.txt", "utf-8", "短文本，只有一句话。", "utf-8"),
]

# 编码识别准确率门槛：产品验收要求 ≥90%
ENCODING_PASS_RATE = 0.90


def encode_with(spec: str, text: str) -> bytes:
    """按样本规格编码。'utf-16-be-bom' 不是 Python 的内置 codec，手工补 BOM。"""
    if spec == "utf-16-be-bom":
        return codecs.BOM_UTF16_BE + text.encode("utf-16-be")
    return text.encode(spec)


def write_bytes(path: str, data: bytes) -> str:
    with open(path, "wb") as f:
        f.write(data)
    return path


# ---------------------------------------------------------------- 断言

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), str(detail)))


def expect_error(name: str, code: str, fn) -> None:
    try:
        fn()
        check(name, False, "未抛错")
    except WorkerError as err:  # noqa: PERF203
        check(name, err.code == code, err.code)


# ---------------------------------------------------------------- 各段用例


def run_encoding(tmp: str) -> None:
    passed = 0
    for name, spec, text, expected in ENCODING_CASES:
        path = write_bytes(os.path.join(tmp, name), encode_with(spec, text))
        try:
            detected = parse_detect({"path": path})["encoding"]
        except Exception as err:  # noqa: BLE001
            check(f"编码探测 {name}", False, f"抛异常 {err!r}")
            continue
        ok = detected == expected
        passed += 1 if ok else 0
        # 逐条都记下来：失败时能直接看出是哪类编码出的问题
        check(f"编码探测 {name}", ok, f"期望 {expected} 实际 {detected}")

    rate = passed / len(ENCODING_CASES)
    check(
        f"编码识别准确率 ≥{int(ENCODING_PASS_RATE * 100)}%",
        rate >= ENCODING_PASS_RATE,
        f"{passed}/{len(ENCODING_CASES)} = {rate:.0%}",
    )


def run_outline(tmp: str) -> None:
    docs = {
        "chinese_num.txt": "第一章 开始\n正文甲\n第二章 继续\n正文乙\n第三章 结束\n正文丙\n",
        "arabic.txt": "第1章 开始\n正文甲\n第2章 继续\n正文乙\n第3章 结束\n",
        "volume.txt": "第一卷 风起\n第一章 开始\n正文\n第二章 继续\n正文\n第二卷 云涌\n第一章 再来\n正文\n",
        "special.txt": "楔子\n前言正文\n正文\n尾声\n结束\n",
        "english.txt": "Chapter 1 Start\nbody\nChapter 2 End\nbody\nChapter 3 Finale\n",
        "no_chapter.txt": "只有正文，没有任何章节标记。\n第二段。\n第三段。\n",
        "weak.txt": "1. 开始\n正文\n2. 继续\n正文\n3. 结束\n正文\n",
        "false_positive.txt": (
            "第一章 这是一个非常非常长的行，长到超过了标题的长度上限，所以它其实是正文而不是标题，"
            "因为作者没有在段落里换行，整段都挤在一起了。\n正文\n"
        ),
    }

    results: dict[str, dict] = {}
    for name, doc in docs.items():
        path = write_bytes(os.path.join(tmp, name), doc.encode("utf-8"))
        results[name] = parse_txt_outline({"path": path, "encoding": "auto"})

    r = results["chinese_num.txt"]
    check("中文数字章节命中 3 条", len(r["chapters"]) == 3, f"{len(r['chapters'])} 条")
    check("章节 level 为 1", all(c["level"] == 1 for c in r["chapters"]), str([c["level"] for c in r["chapters"]]))
    check("章节标题保留原文", r["chapters"][0]["title"] == "第一章 开始", r["chapters"][0]["title"])

    r = results["arabic.txt"]
    check("阿拉伯数字章节命中 3 条", len(r["chapters"]) == 3, f"{len(r['chapters'])} 条")

    r = results["volume.txt"]
    levels = [c["level"] for c in r["chapters"]]
    check("卷+章命中 5 条（2 卷 3 章）", len(r["chapters"]) == 5, f"{len(r['chapters'])} 条")
    check("卷的 level 为 0", levels[0] == 0 and levels[3] == 0, str(levels))
    check("章在卷之后仍为 level 1", levels[1] == 1 and levels[4] == 1, str(levels))

    r = results["special.txt"]
    titles = [c["title"] for c in r["chapters"]]
    check("楔子与尾声被识别", titles == ["楔子", "尾声"], str(titles))

    r = results["english.txt"]
    check("英文 Chapter 命中 3 条", len(r["chapters"]) == 3, f"{len(r['chapters'])} 条")

    r = results["no_chapter.txt"]
    check("无章节标记时返回单章全文", len(r["chapters"]) == 1 and r["chapters"][0]["title"] == "全文", str(len(r["chapters"])))
    check("全文章节从 0 开始", r["chapters"][0]["offset"] == 0, str(r["chapters"][0]["offset"]))

    r = results["weak.txt"]
    check("纯数字编号在强档不足时启用弱档", len(r["chapters"]) == 3, f"{len(r['chapters'])} 条")

    r = results["false_positive.txt"]
    check("超长行不被误判为标题", len(r["chapters"]) == 1, f"{len(r['chapters'])} 条")

    # 字节偏移正确性：直接用编码后的字节去 index，是最硬的验证。
    # 文档写得比其它用例长一些——短文本的编码探测本就不可靠，
    # 用 27 个字的样本测偏移只会测到探测的噪声。
    offset_doc = (
        "第一章 开始\n"
        + "正文甲，内容写长一点，让编码探测有足够的样本可以收敛。\n" * 5
        + "第二章 继续\n"
        + "正文乙，同样是用来撑长度的段落，不含任何章节标记。\n" * 5
        + "第三章 结束\n"
        + "正文丙，最后一段了。\n" * 5
    )
    for enc in ("utf-8", "gb18030", "utf-16-le"):
        path = write_bytes(os.path.join(tmp, f"offset_{enc}.txt"), offset_doc.encode(enc))
        result = parse_txt_outline({"path": path, "encoding": "auto"})
        with open(path, "rb") as f:
            data = f.read()
        expected = data.index("第二章".encode(enc))
        if len(result["chapters"]) < 2:
            check(f"字节偏移正确（{enc}）", False, f"只识别出 {len(result['chapters'])} 章 / {result['encoding']}")
            continue
        actual = result["chapters"][1]["offset"]
        check(f"字节偏移正确（{enc}）", actual == expected, f"期望 {expected} 实际 {actual}")

    # 无间隙：首章 offset + 全部 length = 文件大小
    for enc in ("utf-8", "gb18030"):
        doc = docs["chinese_num.txt"]
        path = write_bytes(os.path.join(tmp, f"cover_{enc}.txt"), doc.encode(enc))
        result = parse_txt_outline({"path": path, "encoding": "auto"})
        size = os.path.getsize(path)
        total = result["chapters"][0]["offset"] + sum(c["length"] for c in result["chapters"])
        check(f"章节覆盖整个文件（{enc}）", total == size, f"{total} vs {size}")

    # GBK 文件按探测结果解析（不显式传 encoding）
    doc = docs["chinese_num.txt"]
    gbk_path = write_bytes(os.path.join(tmp, "auto_gbk.txt"), doc.encode("gbk"))
    auto = parse_txt_outline({"path": gbk_path, "encoding": "auto"})
    check("自动探测后章节仍正确", len(auto["chapters"]) == 3, f"{len(auto['chapters'])} 条 / {auto['encoding']}")

    # BOM 文件的第一章 offset 必须跳过 BOM
    bom_path = write_bytes(os.path.join(tmp, "bom_offset.txt"), codecs.BOM_UTF8 + docs["chinese_num.txt"].encode("utf-8"))
    bom = parse_txt_outline({"path": bom_path, "encoding": "auto"})
    check("带 BOM 时首章 offset 跳过 BOM", bom["chapters"][0]["offset"] == 3, str(bom["chapters"][0]["offset"]))

    # 逐行分类函数的边界
    check("空行不算标题", classify_heading("   ") is None, "None")
    check("普通正文不算标题", classify_heading("他走了很久，终于看到了城门。") is None, "None")
    check("卷识别为 level 0", (classify_heading("第三卷 风云"))[1] == 0, "0")


def run_meta(tmp: str) -> None:
    body = "第一章 开始\n正文\n"

    cases = [
        ("《斗破苍穹》天蚕土豆.txt", body, "斗破苍穹", "天蚕土豆"),
        ("凡人修仙传 - 忘语.txt", body, "凡人修仙传", "忘语"),
        ("[猫腻]庆余年.txt", body, "庆余年", "猫腻"),
        ("全职高手_蝴蝶蓝.txt", body, "全职高手", "蝴蝶蓝"),
        ("没有作者的.txt", body, "没有作者的", None),
    ]
    for filename, doc, want_title, want_author in cases:
        path = write_bytes(os.path.join(tmp, filename), doc.encode("utf-8"))
        meta = parse_meta({"path": path, "format": "txt"})
        check(f"文件名解析 {filename}", meta["title"] == want_title, f"title={meta['title']}")
        check(f"作者解析 {filename}", meta["author"] == want_author, f"author={meta['author']}")

    # 正文里的字段优先于文件名里的作者，但书名仍以文件名为准
    with_fields = (
        "书名：某某传奇\n"
        "作者：张三\n"
        "简介：这是一个关于某某的故事，讲述了他如何从一个普通人成长为传奇人物，经历了无数艰难险阻，也失去了很多。\n"
        "\n"
        "第一章 开始\n正文\n"
    )
    path = write_bytes(os.path.join(tmp, "字段优先.txt"), with_fields.encode("utf-8"))
    meta = parse_meta({"path": path, "format": "txt"})
    check("正文作者优先于文件名", meta["author"] == "张三", str(meta["author"]))
    check("书名以文件名为准", meta["title"] == "字段优先", str(meta["title"]))
    check("简介取自正文字段", bool(meta["intro"]) and meta["intro"].startswith("这是一个关于"), str(meta["intro"])[:20])
    check("简介长度受限", len(meta["intro"] or "") <= 400, str(len(meta["intro"] or "")))
    check("txt 无封面", meta["coverPath"] is None, str(meta["coverPath"]))
    check("中文文本判定语言为 zh", meta["lang"] == "zh", str(meta["lang"]))

    # 文件名边的边界
    check("meta_from_filename 取书名", meta_from_filename("D:/a/斗破苍穹.txt")[0] == "斗破苍穹", "斗破苍穹")
    check("meta_from_filename 无作者", meta_from_filename("D:/a/斗破苍穹.txt")[1] is None, "None")


def run_detect_and_errors(tmp: str) -> None:
    path = write_bytes(os.path.join(tmp, "detect.txt"), PROSE_CN.encode("utf-8"))
    result = parse_detect({"path": path})
    check("parse.detect 返回 format", result["format"] == "txt", str(result["format"]))
    check("parse.detect 返回 size", result["size"] == os.path.getsize(path), str(result["size"]))
    check("parse.detect 返回 encoding", result["encoding"] == "utf-8", str(result["encoding"]))

    fake_pdf = write_bytes(os.path.join(tmp, "book.pdf"), b"%PDF-1.4")
    expect_error("不支持的扩展名被拒", "E_INVALID_ARGUMENT", lambda: parse_detect({"path": fake_pdf}))
    expect_error(
        "文件不存在报 notFound",
        "E_NOT_FOUND",
        lambda: parse_detect({"path": os.path.join(tmp, "nope.txt")}),
    )
    expect_error("缺少 path 被拒", "E_INVALID_ARGUMENT", lambda: parse_detect({}))
    # EPUB 分支在 M1-05 已实现，损坏的样本应当报「解析失败」而不是「未实现」
    expect_error(
        "损坏的 EPUB 报 E_PARSE_FAILED",
        "E_PARSE_FAILED",
        lambda: parse_meta({"path": write_bytes(os.path.join(tmp, "x.epub"), b"PK\x03\x04"), "format": "epub"}),
    )


def run_performance(tmp: str) -> None:
    """200 章 × 50 段的大文件，确认识别与耗时都在可接受范围。"""
    import time

    lines: list[str] = []
    for i in range(200):
        lines.append(f"第{i + 1}章 标题{i + 1}")
        lines.extend([f"这是第{i + 1}章的第{j + 1}段正文，内容用于撑大文件。" for j in range(50)])

    path = write_bytes(os.path.join(tmp, "big.txt"), ("\n".join(lines) + "\n").encode("gb18030"))
    size = os.path.getsize(path)
    started = time.perf_counter()
    result = parse_txt_outline({"path": path, "encoding": "auto"})
    elapsed_ms = (time.perf_counter() - started) * 1000

    check("大文件章节数正确", len(result["chapters"]) == 200, f"{len(result['chapters'])} 条")
    check(
        f"大文件解析耗时可接受（{size // 1024}KB）",
        elapsed_ms < 3000,
        f"{elapsed_ms:.0f}ms",
    )


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="ctext-txt-smoke-")
    try:
        run_encoding(tmp)
        run_outline(tmp)
        run_meta(tmp)
        run_detect_and_errors(tmp)
        run_performance(tmp)
    except Exception as err:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        check("自检执行未抛异常", False, repr(err))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    for name, ok, detail in checks:
        suffix = f" ({detail})" if detail else ""
        print(f"SMOKE TXT {'PASS' if ok else 'FAIL'} {name}{suffix}")

    failed = sum(1 for _, ok, _ in checks if not ok)
    print(f"SMOKE TXT SUMMARY {len(checks) - failed}/{len(checks)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
