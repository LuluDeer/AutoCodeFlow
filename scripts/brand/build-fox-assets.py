#!/usr/bin/env python3
"""狐狸形象资产：源 PNG → 透明底标志 + favicon/logo 副本。

为什么单独一个脚本（而不是并进 build-brand-assets.py）：
  · `build-brand-assets.py` 是**矢量**资产（首图 / 架构图 / 六边形标志）的生成器，
    全部用 SVG 路径描述，改一个字重排一次；
  · 狐狸是**位图**源（`design-system/brand/source/acf-mark-bare.png`，人手出的图），
    仓库里没有、也不该有它的矢量稿。
  两条流水线的事实源不同（矢量路径 vs 位图），混在一个脚本里会让两边都难读。

这个脚本做什么：
  1. 把裸形狐狸**紧裁**到内容边界（源图 1254² 里狐狸只占 83%，直接缩放会显得小）；
  2. 补成正方形、四周留 8% 安全边距（任务栏 / 圆形头像 / 浏览器标签会裁到主体）；
  3. 输出 1024（执行器应用图标源）与 256（favicon / 站点 logo）两档；
  4. 把 256 档**内嵌成 SVG**（base64 PNG），favicon 与文档站 logo 仍是单文件；
  5. 写两份落地副本（admin-web 的 favicon、docs-site 的 logo）。

**为什么是透明底、没有底板**（2026-11-02 改）：
  第一版把狐狸合成到品牌深色圆角底板上（怕白狐在浅色桌面上隐身）。实测在任务栏 /
  托盘里它就是个**深色贴纸**——满幅方块，与旁边那些自带透明轮廓的系统图标并排时
  尤其难看。而狐狸本身并不靠底板才看得见：它是**灰蓝头 + 淡紫身 + 白脸**，
  浅底深底都立得住（实测 24px 以上都清楚）。底板只解决「16px 下的对比」，
  却用「每个尺寸都像贴纸」来付账——不值。所以去掉底板，图标回归「浮空图形」。

用法：python3 scripts/brand/build-fox-assets.py
"""

from __future__ import annotations

import base64
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "design-system/brand/source"
GEN_DIR = ROOT / "design-system/brand/generated"
SVG_DIR = ROOT / "design-system/brand/svg"

# 安全边距：四周各留 8%（README §4 的「出框留白」纪律，六边形那边是 6/64）
MARGIN = 0.08


def load_bare() -> Image.Image:
    """裸形狐狸（透明底）。缺失即报错。"""
    path = SRC_DIR / "acf-mark-bare.png"
    if not path.exists():
        raise SystemExit(
            f"缺少源图 {path}\n"
            "  需要一张透明底的狐狸图（不带底板）。"
        )
    return Image.open(path).convert("RGBA")


def normalize(mark: Image.Image, size: int) -> Image.Image:
    """紧裁到内容边界 → 补正方形 → 留安全边距 → 缩放到目标尺寸。"""
    bbox = mark.getbbox()
    if bbox is None:  # 全透明图：直接缩放，避免 getbbox 返回 None 后续崩
        return mark.resize((size, size), Image.LANCZOS)
    content = mark.crop(bbox)
    side = max(content.size)
    pad = round(side * MARGIN)
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    canvas.alpha_composite(
        content,
        ((side - content.size[0]) // 2 + pad, (side - content.size[1]) // 2 + pad),
    )
    return canvas.resize((size, size), Image.LANCZOS)


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

    full = normalize(bare, 1024)
    full_path = GEN_DIR / "acf-fox-1024.png"
    full.save(full_path, optimize=True)

    small = normalize(bare, 256)
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
