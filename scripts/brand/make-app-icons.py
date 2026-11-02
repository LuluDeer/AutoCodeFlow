#!/usr/bin/env python3
"""从品牌标志源图生成桌面执行器的应用图标与托盘图标。

用法：python3 scripts/brand/make-app-icons.py <mark-1024.png> [输出目录]

为什么不用 electron-icon-builder：那是个 npm 包，需要联网装依赖；
这里直接用 Pillow（仓库 CI 已有）+ 手写 ICNS 容器，产物完全可复现。

产物：
  icon.png   1024×1024（electron-builder 的 Linux/通用源）
  icon.ico   16/24/32/48/64/128/256（Windows 任务栏、开始菜单、标题栏）
  icon.icns  ic07..ic14 + ic11/ic12（macOS Finder / Dock / 菜单栏）
  tray-{online,offline,pending}@2x.png  32×32 托盘状态图标

托盘图标约定：形状恒定（品牌圆角方块 + 双箭头），**颜色才表示状态**
（在线绿 / 离线红 / 启动中黄）。状态靠颜色区分而不是靠形状变化，
是托盘图标的常规做法：形状变了用户会以为是另一个程序。
"""

from __future__ import annotations

import pathlib
import struct
import sys

from PIL import Image, ImageDraw

STATE_COLORS = {
    "online": (34, 197, 94),  # #22C55E
    "offline": (239, 68, 68),  # #EF4444
    "pending": (245, 158, 11),  # #F59E0B
}
CANVAS = (11, 18, 32)  # #0B1220，与品牌画布同色

# ICNS 容器里各 type 字段对应的像素尺寸（见 Apple 的 ICON 数据格式）
ICNS_TYPES = [
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 32),
    ("ic12", 64),
    ("ic13", 256),
    ("ic14", 512),
]


HEX = [(32, 6.2), (53.8, 18.8), (55.8, 22.3), (55.8, 41.7), (53.8, 45.2),
       (34, 58), (30, 58), (10.2, 45.2), (8.2, 41.7), (8.2, 22.3), (10.2, 18.8), (30, 6.2)]


def hex_mark(size: int, color: tuple[int, int, int]) -> Image.Image:
    """画品牌标志：实心六边形 + 透明挖空的箭头（与 acf-mark.svg 同几何、同语义）。

    挖空在 PIL 里靠 alpha 相减：先把六边形画满，再用箭头的笔画做一张遮罩扣掉，
    这样托盘图标放在任何托盘底色上，箭头露出的都是系统底色，而不是一块脏黑色。
    """
    s = size / 64.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(x * s, y * s) for x, y in HEX], fill=color + (255,))

    cut = Image.new("L", (size, size), 0)
    cd = ImageDraw.Draw(cut)
    w = max(round(7.4 * s), 2)
    pts = [(25 * s, 19.5 * s), (40 * s, 32 * s), (25 * s, 44.5 * s)]
    cd.line(pts, fill=255, width=w, joint="curve")
    r = w / 2
    for px, py in (pts[0], pts[-1]):  # 圆头
        cd.ellipse([px - r, py - r, px + r, py + r], fill=255)

    alpha = img.getchannel("A")
    img.putalpha(Image.eval(Image.merge("L", [alpha]), lambda v: v))
    a = img.getchannel("A").point(lambda v: v)
    img.putalpha(Image.composite(Image.new("L", (size, size), 0), a, cut))
    return img


def make_tray(size: int, state: str) -> Image.Image:
    """托盘图标：深色圆角方块 + 状态色双箭头（形状恒定，颜色表状态）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=round(size * 0.234), fill=CANVAS + (255,))
    mark = hex_mark(size, STATE_COLORS[state])
    img.alpha_composite(mark)
    return img


def write_icns(png_by_size: dict[int, Image.Image], path: pathlib.Path) -> None:
    """手写 ICNS 容器：每段是 4 字节 type + 4 字节长度（含头）+ PNG 负载。"""
    chunks = bytearray()
    for type_name, px in ICNS_TYPES:
        img = png_by_size.get(px)
        if img is None:
            continue
        import io

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        payload = buf.getvalue()
        chunks += type_name.encode("ascii") + struct.pack(">I", len(payload) + 8) + payload
    path.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + bytes(chunks))


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    src = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path("apps/executor-desktop/assets")
    out.mkdir(parents=True, exist_ok=True)

    mark = Image.open(src).convert("RGBA")
    if mark.size != (1024, 1024):
        mark = mark.resize((1024, 1024), Image.LANCZOS)

    mark.save(out / "icon.png")

    sizes = [16, 24, 32, 48, 64, 128, 256]
    mark.save(out / "icon.ico", sizes=[(s, s) for s in sizes])

    by_size: dict[int, Image.Image] = {}
    for _, px in ICNS_TYPES:
        if px not in by_size:
            by_size[px] = mark.resize((px, px), Image.LANCZOS)
    write_icns(by_size, out / "icon.icns")

    for state in STATE_COLORS:
        make_tray(32, state).save(out / f"tray-{state}@2x.png")

    print(f"icons written to {out}")


if __name__ == "__main__":
    main()
