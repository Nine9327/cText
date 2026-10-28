"""EPUB 章节 XHTML → 安全 HTML（M2-03）。

**为什么净化放在 Python 侧**：EPUB 是不可信输入（任意来源下载的包），而 `html`
字段最终会被塞进渲染层的 `v-html`。净化必须发生在**进入 DOM 之前**，并且只有
Python 手上有 zipfile（图片要从包里抽出来）。Node 侧只拿到一个已经干净的字符串。

三条边界：

1. **标签白名单**：只保留真正表达「书的内容」的标签（段落、标题、强调、列表、
   表格、图片）。`script/style/iframe/svg/link…` 一律连同子树丢弃；`div/span/a`
   这类纯布局容器**脱壳保子**——它们的语义由阅读器自己的排版决定，
   EPUB 自带的 class/id 一旦留下来，样式就跟着进来了。
2. **属性白名单**：`img` 只留 `src/alt`，表格单元格只留 `colspan/rowspan`。
   **不留 class/style/id**：这是「外部 CSS/字体不污染全局」的实现方式——
   没有选择器可挂，EPUB 的样式表就没有作用点（我们也不加载它）。
3. **图片走自定义协议**：`<img src="../Images/x.jpg">` 会被换成
   `ctext-asset://asset/<sha1-16>.<ext>`，字节落到 `destDir`。文件名用内容哈希，
   同一张图被多章引用只落一份，重复解析也幂等。
"""

from __future__ import annotations

import hashlib
import os
import posixpath

from lxml import etree

from epub import image_ext, resolve_href

# 保留的标签（外加脱壳的容器标签，见 UNWRAP）
ALLOWED_TAGS = {
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "sub",
    "sup",
    "blockquote",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "caption",
    "img",
}

VOID_TAGS = {"br", "hr", "img"}

# 只脱壳、不保留标签的容器：内容要，样式不要
UNWRAP_TAGS = {
    "div",
    "span",
    "a",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "figure",
    "figcaption",
    "font",
    "center",
    "small",
    "big",
    "label",
    "body",
    "html",
}

# 连同子树一起丢掉：脚本、样式表、媒体、表单、SVG/MathML（它们能带自己的脚本与外部引用）
DROP_TAGS = {
    "script",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "video",
    "audio",
    "canvas",
    "svg",
    "math",
    "link",
    "meta",
    "base",
    "form",
    "input",
    "button",
    "select",
    "textarea",
    "noscript",
    "template",
    "head",
    "title",
}

# 属性白名单：其余一律丢弃（含 class/style/id 与所有 on* 事件）
ALLOWED_ATTRS = {
    "img": {"src", "alt"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}

# 单张图片体积上限（压缩炸弹防护）；超过就当作「这张图没有」
MAX_IMAGE_BYTES = 16 * 1024 * 1024

# 单章图片数量上限：病态 EPUB 可能塞几千张，全抽出来会把章节打开拖成分钟级
MAX_IMAGES = 200

# 章节 XHTML 体积上限
MAX_XHTML_BYTES = 8 * 1024 * 1024

ASSET_SCHEME = "ctext-asset"
ASSET_HOST = "asset"


def local_name(tag: object) -> str:
    """`{http://www.w3.org/1999/xhtml}p` → `p`。注释/PI 不是字符串，返回空串。"""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _escape_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(text: str) -> str:
    return _escape_text(text).replace('"', "&quot;")


def _norm(text: str | None) -> str:
    return " ".join((text or "").split())


def _asset_name(data: bytes, href: str) -> str | None:
    """内容哈希命名。扩展名按**魔数**判，不信清单/扩展名（M1-05 的教训）。"""
    ext = image_ext(data, href)
    if not ext:
        return None
    return f"{hashlib.sha1(data).hexdigest()[:16]}.{ext}"


class ChapterRenderer:
    """把一个 XHTML 文档树渲染成安全 HTML 片段。"""

    def __init__(self, book, href: str, dest_dir: str | None, title: str | None = None) -> None:
        self.book = book
        self.base_dir = posixpath.dirname(href)
        self.dest_dir = dest_dir
        self.title = _norm(title) if title else ""
        self.parts: list[str] = []
        self.images = 0
        self.dropped_images = 0
        self.dropped_title = False

    # ------------------------------------------------------------ 对外
    def render(self, root: etree._Element) -> str:
        self._children(root)
        return "".join(self.parts).strip()

    # ------------------------------------------------------------ 内部
    def _children(self, node: etree._Element) -> None:
        if node.text:
            self.parts.append(_escape_text(node.text))
        for child in node:
            self._element(child)
            if child.tail:
                self.parts.append(_escape_text(child.tail))

    def _element(self, node: etree._Element) -> None:
        tag = local_name(node.tag)
        if not tag or tag in DROP_TAGS:
            return
        if tag not in ALLOWED_TAGS:
            # 未知/容器标签：脱壳保留子节点（正文不能因为一个 <div> 就整段消失）
            self._children(node)
            return
        if tag == "img":
            self._image(node)
            return

        # `itertext()` 而不是 `text_content()`：后者是 lxml.html 的方法，etree 元素没有
        heading_text = _norm("".join(node.itertext())) if tag in {"h1", "h2", "h3"} else ""
        if not self.dropped_title and heading_text and heading_text == self.title:
            # 章节标题已经在 DTO 里了，正文里再出现一遍就是双标题
            self.dropped_title = True
            return

        attrs = self._attrs(tag, node)
        mark = len(self.parts)
        if tag in VOID_TAGS:
            self.parts.append(f"<{tag}{attrs}/>")
            return

        self.parts.append(f"<{tag}{attrs}>")
        self._children(node)
        if len(self.parts) == mark + 1:
            # 空段落（EPUB 里大量存在）不该占一段的行距
            del self.parts[mark:]
            return
        self.parts.append(f"</{tag}>")

    def _attrs(self, tag: str, node: etree._Element) -> str:
        allowed = ALLOWED_ATTRS.get(tag)
        if not allowed:
            # 白名单里没有这个标签 = 一个属性都不留（class/style/id 全丢）
            return ""
        out: list[str] = []
        for raw_name, value in node.attrib.items():
            name = local_name(raw_name)
            if name in allowed:
                out.append(f' {name}="{_escape_attr(value)}"')
        return "".join(out)

    def _image(self, node: etree._Element) -> None:
        if self.images >= MAX_IMAGES:
            self.dropped_images += 1
            return
        src = (node.get("src") or "").strip()
        if not src or src.startswith("data:"):
            self.dropped_images += 1
            return
        real = resolve_href(self.base_dir, src)
        if not real or not self.book.has(real):
            # 清单里没有这张图（包残缺 / 引用了外部 URL）：直接不输出，
            # 留一个坏图标比少一张图更让人困惑
            self.dropped_images += 1
            return
        try:
            data = self.book.read(real, limit=MAX_IMAGE_BYTES)
        except Exception:  # noqa: BLE001 —— 单张图坏了不该让整章打不开
            self.dropped_images += 1
            return
        name = _asset_name(data, real)
        if not name:
            self.dropped_images += 1
            return
        self._write_asset(name, data)
        alt = (node.get("alt") or "").strip()[:200]
        suffix = f' alt="{_escape_attr(alt)}"' if alt else ""
        self.parts.append(f'<img src="{ASSET_SCHEME}://{ASSET_HOST}/{name}"{suffix}/>')
        self.images += 1

    def _write_asset(self, name: str, data: bytes) -> None:
        if not self.dest_dir:
            return
        target = os.path.join(self.dest_dir, name)
        if os.path.exists(target):
            return
        os.makedirs(self.dest_dir, exist_ok=True)
        # 先写临时文件再改名：并发读同一本书的两章时不会读到半个文件
        tmp = f"{target}.tmp"
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, target)


def render_chapter(
    book, href: str, root: etree._Element, dest_dir: str | None, title: str | None = None
) -> tuple[str, int, int]:
    """返回 `(html, 图片数, 丢弃的图片数)`。"""
    renderer = ChapterRenderer(book, href, dest_dir, title)
    html = renderer.render(root)
    return html, renderer.images, renderer.dropped_images
