"""生成应用图标（resources/icons/icon.ico + icon.png）。

为什么要脚本而不是丢一个二进制：图标要改（换配色、改字形）时能重跑，而不是找不到源文件。
设计约束：Windows 任务栏/标题栏最小会渲染到 16px，因此图形只用**大色块**，
不做细线、不做文字——细线在 16px 下会糊成灰边。

用法：pnpm make:icons
"""

import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "resources", "icons")

# 与渲染层设计令牌一致：--accent: 91 141 239
ACCENT_TOP = (110, 158, 248)
ACCENT_BOTTOM = (60, 104, 214)
PAGE = (255, 255, 255)
PAGE_EDGE = (214, 226, 250)

BASE = 1024  # 先画大图再缩，边缘才干净
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel(
            (0, y),
            tuple(round(top[c] + (bottom[c] - top[c]) * t) for c in range(3)),
        )
    return grad.resize((size, size))


def build() -> Image.Image:
    # 1. 圆角底板：渐变 + 圆角遮罩（半径 22% 是 Win11 图标的视觉惯例，再大就像药丸）
    plate = vertical_gradient(BASE, ACCENT_TOP, ACCENT_BOTTOM).convert("RGBA")
    plate.putalpha(rounded_mask(BASE, round(BASE * 0.22)))
    canvas = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    canvas.alpha_composite(plate)

    d = ImageDraw.Draw(canvas)

    # 2. 书本主体：两页 + 中缝。整体占比 56% 宽、44% 高，四周留白足够，
    #    16px 下仍能看出"翻开的书"而不是一个白方块。
    w, h = BASE, BASE
    left_x, right_x = 0.19 * w, 0.81 * w
    top_y, bottom_y = 0.28 * h, 0.74 * h
    gap = 0.016 * w  # 中缝宽
    radius = 0.035 * BASE

    def page(x0: float, x1: float, flip: bool) -> None:
        """单页。靠近中缝的一侧切直角，外侧切圆角，视觉上像纸张自然摊开。"""
        box = (x0, top_y, x1, bottom_y)
        d.rounded_rectangle(box, radius=radius, fill=PAGE)
        # 抹掉靠中缝的圆角，做出书脊处的折角
        if flip:
            d.rectangle((x1 - radius, top_y, x1, bottom_y), fill=PAGE)
        else:
            d.rectangle((x0, top_y, x0 + radius, bottom_y), fill=PAGE)

    page(left_x, w / 2 - gap, flip=True)
    page(w / 2 + gap, right_x, flip=False)

    # 3. 两页上各一条"文字行"：只用一条，多了在小尺寸下变脏
    line_h = 0.028 * h
    line_y = 0.55 * h
    d.rounded_rectangle(
        (0.27 * w, line_y, 0.45 * w, line_y + line_h), radius=line_h / 2, fill=PAGE_EDGE
    )
    d.rounded_rectangle(
        (0.55 * w, line_y, 0.73 * w, line_y + line_h), radius=line_h / 2, fill=PAGE_EDGE
    )

    return canvas


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    master = build()

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    # sizes 交给 Pillow 逐档 LANCZOS 缩放，比让系统自己缩清晰
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    png_path = os.path.join(OUT_DIR, "icon.png")
    master.resize((512, 512), Image.LANCZOS).save(png_path, format="PNG")

    print(f"wrote {ico_path} ({os.path.getsize(ico_path)} bytes, sizes={ICO_SIZES})")
    print(f"wrote {png_path} ({os.path.getsize(png_path)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
