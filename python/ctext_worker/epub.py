"""EPUB 底层解析：zip 容器 → OPF 清单 → nav / ncx 目录树。

**为什么不用 ebooklib**（它在 `requirements.txt` 里锁过一个版本）：

1. `read_epub()` 会把全部文档一次性读进内存并建成 `EpubItem` 对象，500 章的书写完
   M1-06 的并发 4 导入会常驻几十 MB，而实际只需要「清单 + 目录」两小段 XML。
2. 它的失败一律抛 `BadZipFile` / `KeyError` 这类底层异常，无法区分
   「压缩包坏了」「不是 EPUB」「受 DRM 保护」——而产品要求导入结果面板
   按原因分类展示（`docs/产品文档.md` §223）。
3. 字体混淆（Adobe / IDPF 两种算法）在正规出版 EPUB 里很常见且**不是 DRM**，
   ebooklib 不区分，我们必须在 `META-INF/encryption.xml` 里做这个判断。

代价是自己写 ~450 行。换来的是零不确定性：所有异常都是带错误码的 `WorkerError`。

**XML 解析的安全边界**：统一用 `lxml.XMLParser(recover=True, resolve_entities=False,
no_network=True)`。
- `resolve_entities=False` + `no_network=True` 挡掉 XXE 与十亿笑声（EPUB 是不可信输入）
- `recover=True` 让残缺的 XHTML 也能解析出目录，而不是整本判失败
- **parser 不能用模块级单例**：worker 是 4 线程池，lxml 的 parser 对象不可跨线程复用。
  每次解析新建一个，代价是微秒级。

**href 一律归一化为「zip 内完整路径」**（如 `OEBPS/Text/ch1.xhtml`）：
去 fragment、URL 解码、`..` 折叠。这样 M2-03 拿到的 href 可以直接 `zip.read()`。
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import re
import zipfile
from urllib.parse import unquote

from lxml import etree

from rpc import ERROR_PARSE_FAILED, WorkerError

CONTAINER_PATH = "META-INF/container.xml"
ENCRYPTION_PATH = "META-INF/encryption.xml"

# 目录条目上限：病态 EPUB 的 nav 可能有几万条，超了直接截断而不是把内存吃光
MAX_CHAPTERS = 20000

# 目录标题长度上限。EPUB 里偶尔会出现整段正文被塞进 <a> 的情况
TITLE_LIMIT = 200

# 目录标题的兜底来源是 XHTML 的 <title>，它一定在文件头部，只读前 8KB 就够
HEAD_BYTES = 8192

# 单张封面的体积上限（压缩炸弹防护）
MAX_COVER_BYTES = 32 * 1024 * 1024

# 简介截断长度，与 TXT 保持一致（产品文档写 ≤500 字，实现取 400 更保守）
INTRO_LIMIT = 400

XHTML_SUFFIXES = (".xhtml", ".html", ".htm")

IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"}

# 字体混淆算法：OCF 标准允许对嵌入字体做混淆，这**不是** DRM
_FONT_OBFUSCATION_HINTS = ("embedding", "pdf/enc", "obfuscation")

RE_TAG = re.compile(r"(?s)<[^>]+>")
RE_BLOCK_TAG = re.compile(r"(?is)<(script|style)[^>]*>.*?</\1>")
RE_TITLE = re.compile(r"(?is)<title[^>]*>(.*?)</title>")
RE_H123 = re.compile(r"(?is)<h[1-3][^>]*>(.*?)</h[1-3]>")
RE_SPACES = re.compile(r"\s+")

# 「包装层」标题：这类节点只是把目录包起来的壳，不是书的结构
RE_WRAPPER_TITLE = re.compile(
    r"^(目\s*录|目錄|正文|目录页|content|contents|table of contents|toc|body|book)$", re.IGNORECASE
)


# ---------------------------------------------------------------- 小工具


def _local(tag: object) -> str:
    """取标签的本地名，忽略命名空间。

    EPUB 世界里同一个元素可能带 `{http://www.w3.org/1999/xhtml}` 前缀，
    也可能裸着（大量工具产出的 nav.xhtml 并不带 ns）。按本地名匹配一次，
    比给每个查询准备两套 XPath 稳得多。
    """
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _iter_local(node: etree._Element, name: str):
    """深度优先遍历所有本地名匹配的子节点（含自身）。"""
    for child in node.iter():
        if _local(child.tag) == name:
            yield child


def _all_text(node: etree._Element) -> str:
    try:
        return "".join(node.itertext())
    except (ValueError, TypeError):
        return ""


def _clean_text(text: str | None) -> str:
    if not text:
        return ""
    return RE_SPACES.sub(" ", text).strip()


def strip_markup(text: str | None) -> str:
    """把 `dc:description` 里常见的 HTML 片段压成纯文本。

    顺序不能反：**先剥标签再解实体**。反过来的话 `<b>` 会被实体解码成 `<b>`
    然后又被当成标签剥掉，正文里的「a &lt; b」这类内容会莫名消失。
    """
    if not text:
        return ""
    cleaned = RE_BLOCK_TAG.sub(" ", text)
    cleaned = RE_TAG.sub(" ", cleaned)
    for entity, char in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
        cleaned = cleaned.replace(entity, char)
    return _clean_text(cleaned)


def parse_xml(data: bytes) -> etree._Element | None:
    """安全地解析一段 XML/XHTML。解析不出来返回 None，由调用方决定降级策略。"""
    if not data:
        return None
    parser = etree.XMLParser(recover=True, resolve_entities=False, no_network=True, huge_tree=False)
    try:
        root = etree.fromstring(data, parser)
    except (etree.XMLSyntaxError, ValueError, LookupError):
        return None
    return root if root is not None else None


def resolve_href(base_dir: str, href: str) -> str:
    """把 OPF/nav 里的相对 href 归一化成 zip 内路径。

    - URL 解码（中文文件名常被百分号编码）
    - 反斜杠当分隔符（少数工具用 `\\` 生成 href）
    - 丢掉 fragment —— 目录粒度是「文档」不是「锚点」，M2-03 按文档取内容
    - `..` 折叠后若跑到 zip 根之外，截断多余前缀而不是报错
    """
    raw = unquote(href.strip()).replace("\\", "/")
    raw = raw.split("#", 1)[0].strip()
    if not raw:
        return ""

    if raw.startswith("/"):
        joined = posixpath.normpath(raw.lstrip("/"))
    elif base_dir:
        joined = posixpath.normpath(posixpath.join(base_dir, raw))
    else:
        joined = posixpath.normpath(raw)

    while joined.startswith("../"):
        joined = joined[3:]
    if joined == ".":
        return ""
    return joined.lstrip("/")


def image_ext(data: bytes, href: str = "") -> str | None:
    """按魔数判图片格式；判不出再退回扩展名。返回 None 表示「这不是图片」。

    必须校验内容：有大量 EPUB 把 `cover.xhtml` 声明成 `image/jpeg`，
    直接按清单声明的 media-type 落盘会产出一个打不开的「封面」。

    内容以 `<` 开头时**只认 SVG**，不再退回扩展名——那一定是标记语言，
    `.jpg` 后缀只是清单里写错了。
    """
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:2] == b"BM":
        return "bmp"

    head = data[:2048]
    if head.lstrip()[:1] == b"<":
        return "svg" if b"<svg" in head.lower() else None

    ext = posixpath.splitext(href)[1].lstrip(".").lower()
    return ext if ext in IMAGE_EXTS else None


def _is_image_item(item: dict) -> bool:
    if item["mediaType"].startswith("image/"):
        return True
    return posixpath.splitext(item["href"])[1].lstrip(".").lower() in IMAGE_EXTS


def _is_document_item(item: dict) -> bool:
    if item["mediaType"] in ("application/xhtml+xml", "text/html"):
        return True
    return item["href"].lower().endswith(XHTML_SUFFIXES)


# ---------------------------------------------------------------- 容器


class EpubBook:
    """一个已打开的 EPUB。用 `open_epub()` 构造，支持 with 语法。"""

    def __init__(self, path: str) -> None:
        self.path = path
        try:
            self._zip = zipfile.ZipFile(path)
        except Exception as err:  # noqa: BLE001 —— BadZipFile/OSError/ValueError 统一收敛
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 文件已损坏或不是有效的 EPUB", detail=repr(err))

        # 大小写不敏感的索引：Windows 上产出的 EPUB 常出现 OPF 写 `Text/A.xhtml`
        # 而 zip 里实际是 `text/a.xhtml` 的情况
        self._names: dict[str, str] = {}
        for name in self._zip.namelist():
            if not name.endswith("/"):
                self._names.setdefault(name.lower(), name)

        self._loaded = False
        self.opf_path = ""
        self._opf: etree._Element | None = None
        self.manifest: dict[str, dict] = {}
        self.spine: list[dict] = []
        self.spine_toc_id: str | None = None

    # -- 生命周期 -------------------------------------------------

    def __enter__(self) -> EpubBook:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        try:
            self._zip.close()
        except Exception:  # noqa: BLE001 —— 关不掉没有补救手段，也不该影响结果
            pass

    # -- 原始读取 -------------------------------------------------

    def has(self, name: str) -> bool:
        return name.lower() in self._names

    def read(self, name: str, limit: int | None = None) -> bytes:
        """读一个条目的全部内容。`limit` 是**体积闸门**，超了直接报错而不是截断。"""
        real = self._names.get(name.lower(), name)
        try:
            info = self._zip.getinfo(real)
        except KeyError:
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 内部文件缺失", detail=name)
        if limit is not None and info.file_size > limit:
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 内部文件过大，已拒绝解析", detail=name)
        try:
            with self._zip.open(real) as handle:
                return handle.read()
        except RuntimeError as err:
            # zipfile 对加密条目抛 RuntimeError("File ... is encrypted")
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 受 DRM 保护，无法导入", detail=str(err))
        except Exception as err:  # noqa: BLE001 —— CRC 错、截断、压缩算法不支持都在这里
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 内部文件已损坏", detail=f"{name}: {err}")

    def read_head(self, name: str, size: int = HEAD_BYTES) -> bytes:
        """只读前若干字节。

        与 `read(limit=)` 的语义**不同**：这里是「读一部分」，不因为文件大而报错。
        取目录标题只需要 `<title>`，不必为 500 章的书把正文全解压一遍。
        """
        real = self._names.get(name.lower(), name)
        try:
            with self._zip.open(real) as handle:
                return handle.read(size)
        except KeyError:
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 内部文件缺失", detail=name)
        except RuntimeError as err:
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 受 DRM 保护，无法导入", detail=str(err))
        except Exception as err:  # noqa: BLE001
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 内部文件已损坏", detail=f"{name}: {err}")

    # -- 加载 -----------------------------------------------------

    def load(self) -> EpubBook:
        if self._loaded:
            return self
        self.opf_path = self._find_opf_path()
        root = parse_xml(self.read(self.opf_path))
        if root is None:
            raise WorkerError(ERROR_PARSE_FAILED, "EPUB 的 OPF 清单无法解析", detail=self.opf_path)
        self._opf = root
        self._parse_manifest()
        self._parse_spine()
        self._check_encryption()
        self._loaded = True
        return self

    def _find_opf_path(self) -> str:
        if self.has(CONTAINER_PATH):
            root = parse_xml(self.read(CONTAINER_PATH))
            if root is not None:
                for node in _iter_local(root, "rootfile"):
                    full = node.get("full-path")
                    if not full:
                        continue
                    target = resolve_href("", full)
                    if target and self.has(target):
                        return target
        # 回退：container.xml 缺失或指向不存在的文件时，直接找包内 .opf。
        # 单选深度最浅的那个——`OEBPS/content.opf` 比 `OEBPS/toc.ncx.opf` 更可能是主清单
        candidates = sorted(
            (name for name in self._names.values() if name.lower().endswith(".opf")),
            key=lambda name: (name.count("/"), name),
        )
        if candidates:
            return candidates[0]
        raise WorkerError(ERROR_PARSE_FAILED, "这不是有效的 EPUB（找不到 OPF 清单）")

    def _parse_manifest(self) -> None:
        base = posixpath.dirname(self.opf_path)
        for node in _iter_local(self._opf, "item"):
            item_id = node.get("id")
            href = node.get("href")
            if not item_id or not href:
                continue
            self.manifest[item_id] = {
                "id": item_id,
                "href": resolve_href(base, href),
                "mediaType": (node.get("media-type") or "").strip().lower(),
                "properties": (node.get("properties") or "").lower().split(),
            }

    def _parse_spine(self) -> None:
        for spine in _iter_local(self._opf, "spine"):
            toc = spine.get("toc")
            if toc:
                self.spine_toc_id = toc
            break
        for node in _iter_local(self._opf, "itemref"):
            idref = node.get("idref")
            if not idref or idref not in self.manifest:
                continue
            self.spine.append(
                {
                    "idref": idref,
                    "linear": (node.get("linear") or "yes").strip().lower() != "no",
                    "href": self.manifest[idref]["href"],
                }
            )

    def _check_encryption(self) -> None:
        """区分「DRM」与「字体混淆」。

        正规出版社的 EPUB 几乎都会对嵌入字体做 IDPF/Adobe 混淆，那是 OCF 标准的一部分，
        把整本书判成加密会误伤一大片。只有**正文文档或 OPF 本身**被某种非字体混淆算法
        加密，才算真的打不开。

        判定必须逐条 `EncryptedData` 进行：加密清单里往往是「字体用混淆算法 + 正文用 AES」，
        只取第一条的 Algorithm 会让 DRM 书因为字体在前而蒙混过关。
        """
        if not self.has(ENCRYPTION_PATH):
            return
        root = parse_xml(self.read(ENCRYPTION_PATH))
        if root is None:
            # 解不出来的 encryption.xml 不能当证据，继续尝试解析
            return

        doc_targets = {entry["href"] for entry in self.spine} | {self.opf_path}
        for data in _iter_local(root, "encrypteddata"):
            algorithm = ""
            for node in data:
                if _local(node.tag) == "encryptionmethod":
                    algorithm = (node.get("Algorithm") or "").lower()
                    break
            for ref in data.iter():
                if _local(ref.tag) != "cipherreference":
                    continue
                uri = ref.get("URI")
                if not uri:
                    continue
                if resolve_href("", uri) not in doc_targets:
                    continue
                if any(hint in algorithm for hint in _FONT_OBFUSCATION_HINTS):
                    continue
                raise WorkerError(ERROR_PARSE_FAILED, "EPUB 受 DRM 保护，无法导入")

    # -- 元数据 ---------------------------------------------------

    def metadata(self) -> dict:
        self.load()

        def first_text(name: str) -> str | None:
            for node in _iter_local(self._opf, name):
                text = _clean_text(_all_text(node))
                if text:
                    return text
            return None

        title = first_text("title")
        author = self._pick_author()
        intro = strip_markup(first_text("description"))[:INTRO_LIMIT] or None

        version = ""
        if self._opf is not None:
            version = (self._opf.get("version") or "").strip()

        return {
            "title": title,
            "author": author,
            "intro": intro,
            "coverPath": None,
            "lang": first_text("language"),
            "publisher": first_text("publisher"),
            "pubDate": first_text("date"),
            "epubVersion": version or None,
        }

    def _pick_author(self) -> str | None:
        """优先取 `opf:role="aut"` 的 creator。

        出版 EPUB 的 creator 常混入译者、编者，取第一个会得到「某某 译」。
        """
        creators: list[str] = []
        auto: str | None = None
        for node in _iter_local(self._opf, "creator"):
            text = _clean_text(_all_text(node))
            if not text:
                continue
            creators.append(text)
            role = (node.get("{http://www.idpf.org/2007/opf}role") or node.get("role") or "").strip().lower()
            if role == "aut" and auto is None:
                auto = text
        return auto or (creators[0] if creators else None)

    # -- 封面 -----------------------------------------------------

    def cover_href(self) -> tuple[str | None, str]:
        """按常见程度依次尝试四种约定，返回 `(zip 内路径, 来源标签)`。"""
        self.load()

        # ① EPUB2：<meta name="cover" content="item-id"/>
        for node in _iter_local(self._opf, "meta"):
            if (node.get("name") or "").strip().lower() != "cover":
                continue
            item = self.manifest.get((node.get("content") or "").strip())
            if item and _is_image_item(item):
                return item["href"], "meta-cover"

        # ② EPUB3：properties="cover-image"
        for item in self.manifest.values():
            if "cover-image" in item["properties"] and _is_image_item(item):
                return item["href"], "properties"

        # ③ guide 指向的封面页里的第一张图（大量 EPUB2 只写 guide 不写 meta）
        from_guide = self._cover_from_guide()
        if from_guide:
            return from_guide, "guide"

        # ④ id 或文件名里带 cover 的图片。排序后再挑，保证同一个文件每次结果一致
        for item in sorted(self.manifest.values(), key=lambda entry: entry["href"]):
            if not _is_image_item(item):
                continue
            name = posixpath.basename(item["href"]).lower()
            if "cover" in item["id"].lower() or "cover" in name:
                return item["href"], "filename"

        return None, ""

    def _cover_from_guide(self) -> str | None:
        guide_href = None
        for node in _iter_local(self._opf, "reference"):
            if (node.get("type") or "").strip().lower() == "cover":
                guide_href = node.get("href")
                break
        if not guide_href:
            return None

        page = resolve_href(posixpath.dirname(self.opf_path), guide_href)
        if not page or not self.has(page):
            return None
        # guide 直接指向图片是合法的，此时不用再往下找
        if _is_image_href(page):
            return page

        root = parse_xml(self.read_head(page, HEAD_BYTES * 4))
        if root is None:
            return None
        base = posixpath.dirname(page)
        for node in root.iter():
            name = _local(node.tag)
            if name == "img":
                src = node.get("src")
            elif name == "image":
                src = node.get("{http://www.w3.org/1999/xlink}href") or node.get("href")
            else:
                continue
            if not src or "://" in src:
                continue
            target = resolve_href(base, src)
            if target and self.has(target):
                return target
        return None

    def cover_bytes(self) -> tuple[bytes, str, str] | None:
        """返回封面的原始字节。**不做格式校验**——校验交给 `cover.extract`，
        这样「清单说它是图但内容不是」能报出 `invalid-image` 而不是笼统的「没封面」。
        """
        href, source = self.cover_href()
        if not href:
            return None
        return self.read(href, MAX_COVER_BYTES), href, source

    # -- 目录 -----------------------------------------------------

    def chapters(self) -> tuple[list[dict], str]:
        """返回 `(扁平章节列表, 数据来源)`，来源取值 `nav` / `ncx` / `spine`。"""
        # 必须显式 load：nav/ncx 的查找全靠 manifest，忘了这步会静默返回「没有目录」
        self.load()
        nodes, source = self._nav_nodes()
        if not nodes:
            nodes, source = self._spine_nodes(), "spine"
        return flatten_tree(nodes), source

    def _nav_nodes(self) -> tuple[list[dict], str]:
        nodes = self._nav_from_nav_doc()
        if nodes:
            return nodes, "nav"
        nodes = self._nav_from_ncx()
        if nodes:
            return nodes, "ncx"
        return [], ""

    def _nav_from_nav_doc(self) -> list[dict]:
        """EPUB3 的 `nav.xhtml`：找 `<nav epub:type="toc">` 里的第一个 `<ol>`。"""
        target = None
        for item in self.manifest.values():
            if "nav" in item["properties"] and _is_document_item(item):
                target = item["href"]
                break
        if target is None:
            # 清单没声明 properties 时，退回按文件名找（EPUB2 工具链升上来的书常见）
            for item in sorted(self.manifest.values(), key=lambda entry: entry["href"]):
                if _is_document_item(item) and posixpath.basename(item["href"]).lower() == "nav.xhtml":
                    target = item["href"]
                    break
        if target is None or not self.has(target):
            return []

        root = parse_xml(self.read(target))
        if root is None:
            return []

        navs = list(_iter_local(root, "nav"))
        chosen = None
        for node in navs:
            if "toc" in (node.get("{http://www.idpf.org/2007/ops}type") or node.get("type") or "").lower():
                chosen = node
                break
        if chosen is None and navs:
            chosen = navs[0]
        # 连 <nav> 都没有（不合规但存在）：把整篇当目录树处理
        container = chosen if chosen is not None else root

        for node in container.iter():
            if _local(node.tag) == "ol":
                return self._parse_ol(node, posixpath.dirname(target))
        return []

    def _parse_ol(self, ol: etree._Element, base: str) -> list[dict]:
        out: list[dict] = []
        for li in ol:
            if _local(li.tag) != "li":
                continue
            title, href = self._li_label(li, base)
            children: list[dict] = []
            for sub in li:
                if _local(sub.tag) == "ol":
                    children = self._parse_ol(sub, base)
                    break
            if not title and not children:
                continue
            out.append({"title": title, "href": href, "children": children})
        return out

    def _li_label(self, li: etree._Element, base: str) -> tuple[str, str | None]:
        """条目文字与链接。`<a>` 优先，其次 `<span>`（非链接的分卷标题就是这种）。"""
        for child in li:
            name = _local(child.tag)
            if name == "a":
                href = child.get("href")
                return _clean_text(_all_text(child)), (resolve_href(base, href) if href else None)
            if name == "span":
                return _clean_text(_all_text(child)), None
        return _clean_text(li.text), None

    def _nav_from_ncx(self) -> list[dict]:
        """EPUB2 的 `toc.ncx`：`navMap` 下递归 `navPoint`。"""
        ncx_href = None
        if self.spine_toc_id and self.spine_toc_id in self.manifest:
            ncx_href = self.manifest[self.spine_toc_id]["href"]
        if not ncx_href:
            for item in sorted(self.manifest.values(), key=lambda entry: entry["href"]):
                if "dtbncx" in item["mediaType"] or item["href"].lower().endswith(".ncx"):
                    ncx_href = item["href"]
                    break
        if not ncx_href or not self.has(ncx_href):
            return []

        root = parse_xml(self.read(ncx_href))
        if root is None:
            return []
        nav_map = next(_iter_local(root, "navmap"), None)
        if nav_map is None:
            return []
        return self._parse_nav_points(nav_map, posixpath.dirname(ncx_href))

    def _parse_nav_points(self, parent: etree._Element, base: str) -> list[dict]:
        out: list[dict] = []
        for point in parent:
            if _local(point.tag) != "navpoint":
                continue
            title = ""
            href: str | None = None
            for node in point:
                name = _local(node.tag)
                if name == "navlabel" and not title:
                    for child in node:
                        if _local(child.tag) == "text":
                            title = _clean_text(_all_text(child))
                            break
                elif name == "content" and href is None:
                    src = node.get("src")
                    if src:
                        href = resolve_href(base, src)
            out.append({"title": title, "href": href, "children": self._parse_nav_points(point, base)})
        return out

    def _spine_nodes(self) -> list[dict]:
        """最后的兜底：按 spine 顺序当目录，标题取文档的 `<title>` 或首个 `<h1>`。

        只读每个文档的前 8KB —— 目录标题一定在文件头部，为 500 章的书按顺序
        全量解压正文纯属浪费。
        """
        out: list[dict] = []
        for entry in self.spine:
            if not entry["linear"]:
                continue
            href = entry["href"]
            if not self.has(href):
                continue
            item = self.manifest.get(entry["idref"]) or {}
            if item and not _is_document_item(item):
                continue
            out.append({"title": self._doc_title(href), "href": href, "children": []})
        return out

    def _doc_title(self, href: str) -> str:
        head = b""
        try:
            head = self.read_head(href)
        except WorkerError:
            return posixpath.splitext(posixpath.basename(href))[0]
        # XHTML 头部偶有非 UTF-8（声明成 gb2312），先按 UTF-8 宽松解，失败再按 gb18030
        for encoding in ("utf-8", "gb18030"):
            try:
                text = head.decode(encoding, errors="strict")
                break
            except UnicodeDecodeError:
                continue
        else:
            text = head.decode("utf-8", errors="replace")

        for pattern in (RE_TITLE, RE_H123):
            found = pattern.search(text)
            if found:
                title = strip_markup(found.group(1))
                if title:
                    return title[:TITLE_LIMIT]
        return posixpath.splitext(posixpath.basename(href))[0]


def _is_image_href(href: str) -> bool:
    return posixpath.splitext(href)[1].lstrip(".").lower() in IMAGE_EXTS


# ---------------------------------------------------------------- 扁平化


def _tree_depth(nodes: list[dict]) -> int:
    if not nodes:
        return 0
    return 1 + max((_tree_depth(node.get("children") or []) for node in nodes), default=0)


def _unwrap_single(nodes: list[dict]) -> list[dict]:
    """顶层只有一个带子节点的「包装层」时把它拆掉。

    只能拆**标题看得出是包装层**的那一层（「目录」「正文」「Contents」）。
    纯结构判断是不够的：`第一部 > 第一卷 > 章` 与 `目录 > 章` 形状完全一样，
    按形状无条件拆会把真正的分部标题吃掉、整本书少一层。

    拆掉的好处是整本书不会多出一个点了没反应的 level 0 根节点。
    """
    while len(nodes) == 1 and nodes[0].get("children") and RE_WRAPPER_TITLE.match(nodes[0].get("title") or ""):
        nodes = nodes[0]["children"]
    return nodes


def _first_href(node: dict) -> str | None:
    if node.get("href"):
        return node["href"]
    for child in node.get("children") or []:
        found = _first_href(child)
        if found:
            return found
    return None


def _walk(nodes: list[dict], level: int, out: list[dict]) -> None:
    for node in nodes:
        if len(out) >= MAX_CHAPTERS:
            return
        href = _first_href(node)
        # 整棵子树都没有可跳转目标 → 这行目录点了没反应，直接丢
        if not href:
            continue
        title = node.get("title") or posixpath.splitext(posixpath.basename(href))[0] or "未命名"
        out.append({"title": title[:TITLE_LIMIT], "level": min(level, 2), "href": href})
        _walk(node.get("children") or [], level + 1, out)


def flatten_tree(nodes: list[dict]) -> list[dict]:
    """把目录树压成带 `level` 的扁平列表。

    **层级语义与 TXT 一致：0 = 卷/部，1 = 章/回，2 = 更细。**
    树深度决定顶层的起点：
    - 只有一层 → 顶层就是章，`level = 1`
    - 有两层及以上 → 顶层是卷，`level = 0`，往下依次 +1（超过 2 一律压到 2）

    这样「卷/章」结构的书和「平铺章节」的书都能得到正确的层级，
    而不是靠书名或标题文字去猜。
    """
    nodes = _unwrap_single(nodes)
    base = 1 if _tree_depth(nodes) <= 1 else 0
    out: list[dict] = []
    _walk(nodes, base, out)
    return out


# ---------------------------------------------------------------- 封面落盘


def write_cover(data: bytes, href: str, dest_dir: str) -> dict:
    """把封面字节写成缓存文件，文件名由内容哈希决定。

    用内容哈希而不是「书名.jpg」有两个原因：
    1. 同一张封面重复导入不会产生一堆副本（幂等）；
    2. 避免用书名拼文件名带来的非法字符与超长路径问题。
    """
    ext = image_ext(data, href)
    if ext is None:
        return {"coverPath": None, "reason": "invalid-image"}

    digest = hashlib.sha1(data).hexdigest()[:16]
    name = f"cover_{digest}.{ext}"
    target = os.path.join(dest_dir, name)

    if not os.path.exists(target):
        os.makedirs(dest_dir, exist_ok=True)
        # 先写临时文件再 os.replace：并发导入同一本书时不会读到半张图
        tmp = f"{target}.{os.getpid()}.tmp"
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, target)

    width, height = _image_size(data)
    return {
        "coverPath": target,
        "coverFile": name,
        "bytes": len(data),
        "width": width,
        "height": height,
        "reason": None,
    }


def _image_size(data: bytes) -> tuple[int | None, int | None]:
    """尺寸只用于 UI 占位比例，取不到就返回 (None, None)，绝不因此判失败。"""
    try:
        from io import BytesIO

        from PIL import Image

        with Image.open(BytesIO(data)) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001 —— Pillow 不在、格式不支持都走这里
        return None, None


def open_epub(path: str) -> EpubBook:
    return EpubBook(path)
