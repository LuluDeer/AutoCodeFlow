#!/usr/bin/env python3
"""狐狸形象资产：源 PNG → 深色底板标志 + favicon/logo 副本。

为什么单独一个脚本（而不是并进 build-brand-assets.py）：
  · `build-brand-assets.py` 是**矢量**资产（首图 / 架构图 / 六边形标志）的生成器，
    全部用 SVG 路径描述，改一个字重排一次；
  · 狐狸是**位图**源（`design-system/brand/source/*.png`，人手出的图），
    仓库里没有、也不该有它的矢量稿——照着画一遍只会得到一个「形似而神不似的替身」，
    而 README §4 记过教训：标志必须能从源文件重现，否则「改了源图忘了改线上」迟早发生。
  两条流水线的事实源不同（矢量路径 vs 位图），混在一个脚本里会让两边都难读。

这个脚本做什么：
  1. 把**裸形白狐**（source/acf-mark-bare.png）合成到品牌深色圆角底板上
     —— 底板沿用六边形标志的同一几何与同一描边，色值取自品牌色板
     （`tokens.ts` 的 backgroundDark 偏亮档 #0B1220 + 强调绿描边）；
  2. 输出 1024（执行器应用图标源）与 256（favicon / 站点 logo）两档；
  3. 把 256 档**内嵌成 SVG**（base64 PNG），
     这样 favicon 与文档站 logo 仍然是单文件、无需改 HTML/配置里的引用路径；
  4. 写两份落地副本（admin-web 的 favicon、docs-site 的 logo）。

为什么底板用品牌深色而不是直接用 source/acf-mark-bg.png：
  那张带底板的图是**模型自己配的蓝紫渐变**，与仓库色板（强调绿 #22C55E /
  画布 #0B1220）没有任何关系，README §3 要求「图与 tokens.ts 同源」；
  而裸形是白狐——直接放浅色桌面上会**隐身**（实测）。深色底板同时解决两件事。

用法：python3 scripts/brand/build-fox-assets.py
"""

from __future__ import annotations

import base64
import pathlib

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "design-system/brand/source"
GEN_DIR = ROOT / "design-system/brand/generated"
SVG_DIR = ROOT / "design-system/brand/svg"

# 与 build-brand-assets.py 的 C 字典同源（tokens.ts：backgroundDark 偏亮档 / accent）
CANVAS = (11, 18, 32)  # #0B1220
STROKE = (34, 197, 94)  # #22C55E

# 与 mark_svg() 同一几何（64 单位网格）：圆角 14.976、内描边 0.75
CANVAS_PX = 1024
RADIUS = round(CANVAS_PX * (14.976 / 64))
BORDER = round(CANVAS_PX * (0.75 / 64))
BORDER_OPACITY = 0.22


def load_bare() -> Image.Image:
    """裸形白狐（透明底）。缺失即报错——不许用带底板那版顶替，理由见文件头。"""
    path = SRC_DIR / "acf-mark-bare.png"
    if not path.exists():
        raise SystemExit(
            f"缺少源图 {path}\n"
            "  需要一张透明底的狐狸图（不带底板）。\n"
            "  带底板那版（acf-mark-bg.png）的蓝紫渐变与品牌色板不一致，"
            "仓库判据 README §3 要求图与 tokens.ts 同源。"
        )
    return Image.open(path).convert("RGBA")


def compose(mark: Image.Image, size: int) -> Image.Image:
    """把狐狸合成到品牌深色圆角底板上。"""
    canvas = Image.new("RGBA", (size, size), CANVAS + (255,))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=round(size * (14.976 / 64)), fill=CANVAS + (255,)
    )
    # 内描边：与六边形标志同一条（绿色 22% 透明），把底板和页面背景分开
    draw.rounded_rectangle(
        [BORDER * size // 1024, BORDER * size // 1024, size - 1 - BORDER * size // 1024, size - 1 - BORDER * size // 1024],
        radius=round(size * (14.226 / 64)),
        outline=STROKE + (int(255 * BORDER_OPACITY),),
        width=max(1, size // 512),
    )
    # 狐狸占底板约 78%，留出安全边距（README §4：任务栏/圆形头像/浏览器标签会裁到主体）
    inner = round(size * 0.78)
    fox = mark.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.alpha_composite(fox, (off, off))
    return canvas


def svg_with_embedded_png(png_path: pathlib.Path, size: int) -> str:
    """把 PNG 内嵌进 SVG：单文件、浏览器可直接当 favicon 用，引用路径不用改。"""
    b64 = base64.b64encode(png_path.read_bytes()).decode("ascii")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img">\n'
        f"  <title>AutoCodeFlow</title>\n"
        f'  <image width="{size}" height="{size}" '
        f'xlink:href="data:image/png;base64,{b64}"/>\n'
        f"</svg>\n"
    )


def main() -> None:
    bare = load_bare()
    GEN_DIR.mkdir(parents=True, exist_ok=True)

    full = compose(bare, CANVAS_PX)
    full_path = GEN_DIR / "acf-fox-1024.png"
    full.save(full_path, optimize=True)

    small = compose(bare, 256)
    small_path = GEN_DIR / "acf-fox-256.png"
    small.save(small_path, optimize=True)

    svg = svg_with_embedded_png(small_path, 256)
    (SVG_DIR / "acf-fox.svg").write_text(svg, encoding="utf-8")

    # 落地副本：favicon 与文档站 logo 只能吃静态文件
    (ROOT / "apps/admin-web/public/acf-fox.svg").write_text(svg, encoding="utf-8")
    (ROOT / "packages/docs-site/public/logo.svg").write_text(svg, encoding="utf-8")

    for p in (full_path, small_path):
        print(f"  {p.relative_to(ROOT)}  {p.stat().st_size // 1024} KB")
    print(f"  design-system/brand/svg/acf-fox.svg  {len(svg) // 1024} KB")


if __name__ == "__main__":
    main()
