"""EPUB 样本生成器 —— 只用于自检与本地核对，不进生产链路。

真书样本无法进仓库（体积 + 版权），而 EPUB 的结构差异恰恰全在「清单怎么写」上：
OPF 放哪、目录用 nav 还是 ncx、封面走哪条约定、href 是相对还是百分号编码。
所以样本必须**按结构参数化生成**，每种变体一份。

用法：
    from make_epub import build_epub, tiny_png
    build_epub(path, title="x", pages=[("Text/ch1.xhtml", "第一章")],
               nav_tree=[{"title": "第一章", "href": "Text/ch1.xhtml"}])

约定：`pages` / `nav_tree` / `ncx_tree` / `cover` 里的 href **一律相对 OPF 所在目录**。
生成器会自动把目录文件里的 href 改写成相对目录文件自身的位置（`nav_dir` / `ncx_dir`），
这样测试用例不必关心「nav 放在哪一层、要几层 `..`」。
"""

from __future__ import annotations

import posixpath
import struct
import zipfile
import zlib
from urllib.parse import quote
from xml.sax.saxutils import escape

MIMETYPE = "application/epub+zip"

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="{opf_path}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""


def tiny_png(width: int = 8, height: int = 8, color: tuple[int, int, int] = (30, 60, 120)) -> bytes:
    """手工拼一张合法 PNG。

    不依赖 Pillow 生成：自检要在「依赖缺失」时也能跑出有意义的结论，
    而且这几行比拉一个图像编码器更可控。
    """

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _xhtml(title: str, body: str = "", lang: str = "zh-CN") -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{lang}" lang="{lang}">\n'
        f"<head><meta charset=\"utf-8\"/><title>{escape(title)}</title></head>\n"
        f"<body><h1>{escape(title)}</h1><p>{escape(body)}</p></body>\n"
        "</html>\n"
    )


def _rel(href: str, base_dir: str) -> str:
    """把 OPF 目录相对的 href 改写成 `base_dir` 相对的 href。"""
    if not base_dir:
        return href
    return posixpath.relpath(href, base_dir)


def _hreffy(href: str, base_dir: str, encode: bool) -> str:
    """目录文件里实际写出去的 href。

    `encode=True` 时做百分号编码 —— 真实 EPUB（尤其 Sigil 之外的生成链）里
    中文文件名基本都是 `%E7%AC%AC...` 这种形式，不测这条路径等于没测中文书。
    """
    rel = _rel(href, base_dir)
    return quote(rel, safe="/") if encode else rel


def _nav_ol(tree: list[dict], base_dir: str, encode: bool = False) -> str:
    items: list[str] = []
    for node in tree:
        href = node.get("href")
        label = escape(node.get("title") or "")
        if href:
            body = f'<a href="{_hreffy(href, base_dir, encode)}">{label}</a>'
        else:
            # 非链接的分卷标题：真实 EPUB 里非常常见
            body = f"<span>{label}</span>"
        children = node.get("children") or []
        if children:
            body += _nav_ol(children, base_dir, encode)
        items.append(f"<li>{body}</li>")
    return "<ol>" + "".join(items) + "</ol>"


def _nav_doc(tree: list[dict], base_dir: str, title: str, encode: bool = False) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
        f"<head><title>{escape(title)}</title><meta charset=\"utf-8\"/></head>\n"
        '<body><nav epub:type="toc" id="toc"><h1>目录</h1>'
        f"{_nav_ol(tree, base_dir, encode)}</nav></body>\n"
        "</html>\n"
    )


def _ncx_points(tree: list[dict], base_dir: str, counter: list[int], encode: bool = False) -> str:
    out: list[str] = []
    for node in tree:
        counter[0] += 1
        order = counter[0]
        href = node.get("href")
        label = escape(node.get("title") or "")
        content = f'<content src="{_hreffy(href, base_dir, encode)}"/>' if href else ""
        children = _ncx_points(node.get("children") or [], base_dir, counter, encode)
        out.append(
            f'<navPoint id="np{order}" playOrder="{order}">'
            f"<navLabel><text>{label}</text></navLabel>{content}{children}</navPoint>"
        )
    return "".join(out)


def _ncx_doc(tree: list[dict], base_dir: str, title: str, encode: bool = False) -> str:
    points = _ncx_points(tree, base_dir, [0], encode)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        f'<head><meta name="dtb:uid" content="ctext-sample"/></head><docTitle><text>{escape(title)}</text></docTitle>'
        f"<navMap>{points}</navMap></ncx>\n"
    )


def build_epub(
    path: str,
    *,
    title: str = "测试书名",
    authors: list[tuple[str, str | None]] | None = None,
    language: str | None = "zh-CN",
    description: str | None = None,
    publisher: str | None = None,
    pub_date: str | None = None,
    version: str = "3.0",
    opf_dir: str = "OEBPS",
    opf_name: str = "content.opf",
    pages: list[tuple[str, str]] | None = None,
    nav_tree: list[dict] | None = None,
    nav_dir: str | None = None,
    ncx_tree: list[dict] | None = None,
    ncx_dir: str | None = None,
    cover: dict | None = None,
    encryption: dict | None = None,
    include_container: bool = True,
    percent_encode_hrefs: bool = False,
    extra_files: list[tuple[str, bytes]] | None = None,
) -> str:
    """生成一个结构可控的 EPUB。

    参数里的所有 href 都相对 OPF 目录；`cover` 形如
    `{"filename": "images/cover.jpg", "data": b"...", "how": "meta|properties|guide|filename",
      "media_type": "image/jpeg", "id": "cover-img"}`。
    """
    authors = authors or []
    if pages is None:
        seen: list[tuple[str, str]] = []

        def collect(tree):
            for node in tree:
                href = node.get("href")
                if href and all(href != existing for existing, _ in seen):
                    seen.append((href, node.get("title") or ""))
                collect(node.get("children") or [])

        collect(nav_tree or [])
        pages = seen

    opf_path = posixpath.join(opf_dir, opf_name) if opf_dir else opf_name
    opf_base = posixpath.dirname(opf_path)

    manifest: list[str] = []
    spine: list[str] = []
    guide: list[str] = []
    payload: list[tuple[str, bytes | str]] = []

    def zip_path(href: str) -> str:
        return posixpath.join(opf_base, href) if opf_base else href

    for index, (href, page_title) in enumerate(pages):
        item_id = f"p{index}"
        manifest.append(f'<item id="{item_id}" href="{href}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{item_id}"/>')
        payload.append((zip_path(href), _xhtml(page_title or f"第{index + 1}节", f"这是{page_title}的正文内容。")))

    if nav_tree:
        nav_href = posixpath.join(nav_dir, "nav.xhtml") if nav_dir else "nav.xhtml"
        attrs = ' properties="nav"' if version.startswith("3") else ""
        manifest.append(f'<item id="nav" href="{nav_href}" media-type="application/xhtml+xml"{attrs}/>')
        payload.append((zip_path(nav_href), _nav_doc(nav_tree, nav_dir or "", title, percent_encode_hrefs)))

    if ncx_tree:
        ncx_href = posixpath.join(ncx_dir, "toc.ncx") if ncx_dir else "toc.ncx"
        manifest.append(f'<item id="ncx" href="{ncx_href}" media-type="application/x-dtbncx+xml"/>')
        payload.append((zip_path(ncx_href), _ncx_doc(ncx_tree, ncx_dir or "", title, percent_encode_hrefs)))

    cover_meta = ""
    if cover:
        how = cover.get("how", "meta")
        cover_href = cover["filename"]
        cover_id = cover.get("id", "cover-img")
        props = ' properties="cover-image"' if how == "properties" else ""
        manifest.append(
            f'<item id="{cover_id}" href="{cover_href}" media-type="{cover.get("media_type", "image/jpeg")}"{props}/>'
        )
        payload.append((zip_path(cover_href), cover.get("data") or tiny_png()))

        if how == "meta":
            cover_meta = f'<meta name="cover" content="{cover_id}"/>'
        elif how == "guide":
            # EPUB2 的另一种写法：guide 指向一个封面页，页面里再放 <img>
            manifest.append('<item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/>')
            payload.append(
                (
                    zip_path("cover.xhtml"),
                    '<?xml version="1.0" encoding="utf-8"?>\n'
                    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>封面</title></head>'
                    f'<body><img src="{_rel(cover_href, "")}" alt="cover"/></body></html>',
                )
            )
            guide.append(f'<reference type="cover" title="封面" href="cover.xhtml"/>')

    creators = "".join(
        ('<dc:creator opf:role="%s">%s</dc:creator>' % (role, escape(name))) if role else
        ("<dc:creator>%s</dc:creator>" % escape(name))
        for name, role in authors
    )
    metadata = f"<dc:title>{escape(title)}</dc:title>{creators}"
    if language:
        metadata += f"<dc:language>{escape(language)}</dc:language>"
    if description:
        metadata += f"<dc:description>{escape(description)}</dc:description>"
    if publisher:
        metadata += f"<dc:publisher>{escape(publisher)}</dc:publisher>"
    if pub_date:
        metadata += f"<dc:date>{escape(pub_date)}</dc:date>"
    metadata += cover_meta

    spine_attr = ' toc="ncx"' if ncx_tree else ""
    guide_xml = f"<guide>{''.join(guide)}</guide>" if guide else ""

    opf_xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<package xmlns="http://www.idpf.org/2007/opf" version="{version}" unique-identifier="bookid">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">'
        f'<dc:identifier id="bookid">ctext-sample</dc:identifier>{metadata}</metadata>\n'
        f'<manifest>{"".join(manifest)}</manifest>\n'
        f'<spine{spine_attr}>{"".join(spine)}</spine>\n'
        f"{guide_xml}\n"
        "</package>\n"
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        # mimetype 必须是第一个条目且不压缩，否则严格校验器会认为不是 EPUB
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, MIMETYPE)

        if include_container:
            archive.writestr("META-INF/container.xml", CONTAINER_XML.format(opf_path=opf_path))
        archive.writestr(opf_path, opf_xml)

        for name, data in payload:
            archive.writestr(name, data)

        for extra_href, extra_data in extra_files or []:
            archive.writestr(zip_path(extra_href), extra_data)

        if encryption:
            refs = "".join(
                f'<enc:EncryptedData><enc:EncryptionMethod Algorithm="{encryption.get("algorithm", "http://www.w3.org/2001/04/xmlenc#aes256-cbc")}"/>'
                f'<enc:CipherData><enc:CipherReference URI="{target}"/></enc:CipherData></enc:EncryptedData>'
                for target in encryption["targets"]
            )
            archive.writestr(
                "META-INF/encryption.xml",
                '<?xml version="1.0" encoding="utf-8"?>\n'
                '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" '
                f'xmlns:enc="http://www.w3.org/2001/04/xmlenc#">{refs}</encryption>',
            )

    return path
