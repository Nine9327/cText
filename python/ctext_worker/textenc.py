"""文本编码探测（M1-04）。

中文 TXT 的实际编码分布大致是：UTF-8（含 BOM）占一半，GBK/GB18030 占另一半，
少量 UTF-16（多为老工具导出），极少 Big5。所以探测链按这个先验排序：

    1. BOM          —— 有 BOM 就没歧义，直接定，别让后面的启发式覆盖它
    2. 严格 UTF-8   —— 中文 UTF-8 与 GBK 的字节特征互斥，长文本几乎不会误判
    3. 无 BOM UTF-16 —— 靠 NUL 字节分布判断（中文 UTF-16 的高字节几乎全 0）
    4. charset-normalizer —— 兜底识别 Big5 / Shift-JIS 等
    5. GB18030      —— 最终兜底。它是 GBK/GB2312 的超集，解 GBK 内容不会失败，
                       所以前一步没识别出来时选它比选 GBK 更安全

**不要把 charset-normalizer 放到第 2 步**：它对短文本的置信度不可靠，
而「严格 UTF-8 能否解码」是一个确定性的判据，比统计模型更可信。
"""

from __future__ import annotations

# BOM 表顺序敏感：UTF-32 LE 的 BOM 是 FF FE 00 00，是 UTF-16 LE 的 FF FE 的超集，
# 必须排在前面，否则 UTF-32 文件会被误判成 UTF-16
BOM_TABLE: tuple[tuple[bytes, str], ...] = (
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)

# 采样 16KB：charset-normalizer 在这个量级上准确性已经饱和，
# 再大只是让每个文件多花几十毫秒。探测发生在每次解析前，成本要压住。
SAMPLE_SIZE = 16 * 1024

# 类别统计只取前 8KB，避免 16 万次 ord() 成为瓶颈
CLASSIFY_SIZE = 8 * 1024

# 这些编码统一归一到 GB18030（超集），避免后续解码因为个别生僻字失败
GB_FAMILY = {"gbk", "gb2312", "gb18030", "cp936", "hz", "gb_2312-80"}

# 这些编码按「字节偏移」遍历不安全（NUL 字节分布在每个码元里），要走整体解码
WIDE_ENCODINGS = {"utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be"}


def normalize_encoding(name: str | None) -> str:
    """把各种别名收敛到 Python codec 名，中文编码族统一成 gb18030。"""
    if not name:
        return "utf-8"
    key = name.strip().lower().replace("_", "-")
    if key in GB_FAMILY:
        return "gb18030"
    if key in {"utf8", "utf-8-sig", "ascii", "us-ascii"}:
        return "utf-8-sig" if key == "utf-8-sig" else "utf-8"
    return key


def _nul_hint(sample: bytes) -> str | None:
    """ASCII 为主的 UTF-16：某一侧的 NUL 字节占比很高（ASCII 码元的高字节是 0）。"""
    if len(sample) < 64:
        return None
    even = sample[0::2]
    odd = sample[1::2]
    odd_nul = odd.count(0) / max(len(odd), 1)
    even_nul = even.count(0) / max(len(even), 1)
    if odd_nul > 0.3 and odd_nul > even_nul:
        return "utf-16-le"
    if even_nul > 0.3 and even_nul > odd_nul:
        return "utf-16-be"
    return None


def _cjk_width_hint(sample: bytes) -> str | None:
    """纯中文的 UTF-16：**没有 NUL**，靠高字节分布判断。

    CJK 统一区 U+4E00~U+9FFF 的高字节恰好落在 0x4E~0x9F。小端时高字节在奇数位，
    大端在偶数位。对照之下，GBK 的尾字节虽然也有 43% 落在这个区间，
    但首字节（偶数位）几乎全部落在 0x81~0xFE，两侧都高才判定为 UTF-16。
    """
    if len(sample) < 128:
        return None

    def ratio(high_bytes: bytes) -> float:
        if not high_bytes:
            return 0.0
        hit = sum(1 for b in high_bytes if 0x4E <= b <= 0x9F or b == 0)
        return hit / len(high_bytes)

    le = ratio(sample[1::2])
    be = ratio(sample[0::2])
    if le > 0.6 and le > be:
        return "utf-16-le"
    if be > 0.6 and be > le:
        return "utf-16-be"
    return None


def detect_utf16(sample: bytes) -> str | None:
    return _nul_hint(sample) or _cjk_width_hint(sample)


def _char_classes(text: str) -> tuple[int, int, int]:
    """返回 `(汉字数, 谚文数, 假名数)`。

    这三个计数是区分中日韩编码的关键：同一段 GBK 字节用 cp949 解出来是谚文，
    用 gb18030 解出来是汉字——字节层面分不出来，字符类别一望便知。
    """
    cjk = hangul = kana = 0
    for ch in text:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF:
            cjk += 1
        elif 0xAC00 <= cp <= 0xD7AF:
            hangul += 1
        elif 0x3040 <= cp <= 0x30FF:
            kana += 1
    return cjk, hangul, kana


def _rank(encoding: str, sample: bytes) -> tuple[int, int, int, int] | None:
    """给候选编码打分，越小越好。返回 None 表示这个编码名根本不认识。

    排序键依次是：
        1. 替换字符数 —— 解不出来的直接淘汰，这一位就把大部分候选筛掉了
        2. 谚文 + 假名数 —— 中文书的正文里几乎不该出现这两种字符
        3. **gb18030 优先** —— 中日韩共用 U+4E00~U+9FFF 汉字区，日文 JIS 汉字
           与中文 GBK 汉字在字符类别上完全无法区分（euc-jis-2004 解一段 GBK 文本
           出来也是一堆「汉字」）。产品是中文阅读器，中文的先验概率远高于日文，
           所以同等质量下让 gb18030 赢。代价是罕见编码的日文 TXT 会被读成乱码，
           这个取舍是刻意的。
        4. 负的汉字数 —— 同等条件下汉字多的赢
    """
    try:
        text = sample.decode(encoding)
        bad = 0
    except UnicodeDecodeError:
        text = sample.decode(encoding, errors="replace")
        bad = text.count("\ufffd")
    except LookupError:
        return None

    cjk, hangul, kana = _char_classes(text[:CLASSIFY_SIZE])
    return (bad, hangul + kana, 0 if encoding == "gb18030" else 1, -cjk)


def detect_from_bytes(sample: bytes) -> str:
    """从字节样本推断编码。纯函数，便于单测。"""
    if not sample:
        return "utf-8"

    for bom, encoding in BOM_TABLE:
        if sample.startswith(bom):
            return encoding

    try:
        sample.decode("utf-8")
        # 严格解码通过就认 utf-8：这是确定性判据，不需要再问统计模型
        return "utf-8"
    except UnicodeDecodeError:
        pass

    utf16 = detect_utf16(sample)
    if utf16:
        return utf16

    # 让统计模型给出若干个候选，再用「解码出来像不像中文」把它们排个序。
    # 单看模型的 chaos 会在短样本上翻车：一段 GBK 文本它可能给出 cp949，
    # 两者 chaos 都很低，但 cp949 解出来是谚文、gb18030 解出来是汉字。
    candidates: list[str] = []
    try:
        from charset_normalizer import from_bytes

        for match in from_bytes(sample):
            if match.encoding:
                normalized = normalize_encoding(match.encoding)
                if normalized and normalized not in candidates:
                    candidates.append(normalized)
            if len(candidates) >= 4:
                break
    except Exception:  # noqa: BLE001 —— 探测失败不该让解析失败
        pass

    if "gb18030" not in candidates:
        candidates.append("gb18030")

    ranked = [(score, enc) for enc in candidates if (score := _rank(enc, sample)) is not None]
    if not ranked:
        return "gb18030"

    ranked.sort()
    return ranked[0][1]


def detect_encoding(path: str) -> tuple[str, int]:
    """探测文件编码。

    返回 `(encoding, bom_length)`。`bom_length` 供上层在计算字节偏移时跳过 BOM，
    否则第一章的 offset 会偏 3 个字节，切出来的正文开头带个不可见字符。
    """

    with open(path, "rb") as f:
        head = f.read(4)
        for bom, encoding in BOM_TABLE:
            if head.startswith(bom):
                return encoding, len(bom)
        f.seek(0)
        sample = f.read(SAMPLE_SIZE)

    return detect_from_bytes(sample), 0


def bom_length(path: str) -> int:
    """只按文件头判断 BOM 长度。

    给「调用方已经探测过编码、只想复用结果」的场景用（M1-06 的导入队列会
    在每本书开始时探测一次，后续调用直接传 encoding）。不再重复跑统计模型。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(4)
    except OSError:
        return 0
    for bom, _encoding in BOM_TABLE:
        if head.startswith(bom):
            return len(bom)
    return 0


def is_wide_encoding(encoding: str) -> bool:
    """是否需要走「整体读入」路径（UTF-16/32 无法按 b'\\n' 切分）。"""
    return encoding.lower() in WIDE_ENCODINGS
