#!/usr/bin/env bash
# 把 design-system/brand/svg/*.svg 栅格化成 README 用的 PNG，并生成桌面端图标。
#
# 为什么用无头 Chrome 而不是 ImageMagick：本机 `convert` 走的是 MSVG 内部渲染器，
# 对 `text` 的 letter-spacing、字体回退（Lato + Noto Sans CJK SC）和 `feDropShadow`
# 都不能忠实还原，导出的中文字形会变成方框。Chrome 的排版结果 == 作者在设计器里看到的结果。
#
# 用法：
#   ./scripts/brand/render-brand-assets.sh            # 全部
#   ./scripts/brand/render-brand-assets.sh banner     # 只重出首图
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SVG_DIR="$ROOT/design-system/brand/svg"
OUT_DIR="$ROOT/docs/assets"
DESKTOP_ASSETS="$ROOT/apps/executor-desktop/assets"
SCALE="${SCALE:-1}"
ONLY="${1:-all}"

CHROME="${CHROME:-google-chrome}"
command -v "$CHROME" >/dev/null || { echo "need Chrome/Chromium on PATH (set CHROME=...)" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1x 而不是 2x：README 里图片按 100% 宽度显示（GitHub 正文约 900px），
# 1760px 的位图已经等于 2 倍图，再翻倍只是把仓库变大——两张 PNG 从 300KB 涨到 845KB，
# 而肉眼在 900px 的容器里分辨不出来。需要 4K 印刷版时 SCALE=2 手动跑。
#
# raster <svg> <out.png> <css-w> <css-h> [bg]
raster() {
  local svg="$1" out="$2" w="$3" h="$4" bg="${5:-#0B1220}"
  cat >"$tmp/page.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:${bg};overflow:hidden}
img{display:block;width:${w}px;height:${h}px}</style>
<img src="file://$svg">
HTML
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor="$SCALE" --window-size="$w,$h" \
    --default-background-color=00000000 \
    --screenshot="$out" "file://$tmp/page.html" >/dev/null 2>&1
  echo "  $out"
}

mkdir -p "$OUT_DIR"
if [[ "$ONLY" == "all" || "$ONLY" == "banner" ]]; then
  echo "banner:"
  raster "$SVG_DIR/banner-en.svg" "$OUT_DIR/banner-en.png" 1760 468
  raster "$SVG_DIR/banner-zh.svg" "$OUT_DIR/banner-zh.png" 1760 468
fi
if [[ "$ONLY" == "all" || "$ONLY" == "architecture" || "$ONLY" == "arch" ]]; then
  echo "architecture:"
  raster "$SVG_DIR/architecture-en.svg" "$OUT_DIR/architecture-en.png" 1760 1180
  raster "$SVG_DIR/architecture-zh.svg" "$OUT_DIR/architecture-zh.png" 1760 1180
fi
if [[ "$ONLY" == "all" || "$ONLY" == "icon" ]]; then
  echo "app icon:"
  # 狐狸形象（位图源 → 深色底板 → 1024）：桌面任务栏 / 快捷方式 / Alt-Tab 用它。
  # 注意：六边形 SVG 标志**不再**喂给桌面图标——它保留给托盘与文档站以外的地方，
  # 桌面图标按 2026-11-02 的决定改用狐狸（见 design-system/brand/README.md §5）。
  python3 "$ROOT/scripts/brand/build-fox-assets.py" >/dev/null
  python3 "$ROOT/scripts/brand/make-app-icons.py" \
    "$ROOT/design-system/brand/generated/acf-fox-1024.png" "$DESKTOP_ASSETS"
fi

# PNG 体积：只量化**架构图**，首图保持 24 位真彩。
# 实测（1760 宽，同一次渲染）：
#   架构图  415KB → 61KB，量化到 256 色后肉眼无差别（大面积平色面板 + 细线，色数本来就少）；
#   首图    288KB → 35KB，但右上角的大半径径向辉光会出现可见的抖动噪点与块状边缘——
#           那不是省 250KB 能换的。有渐变/辉光的图不要量化。
# 用 NO_OPTIMIZE=1 可跳过量化（例如要把 PNG 再拿去做二次编辑时）。
optimize() {
  python3 "$ROOT/scripts/brand/quantize-png.py" "$@"
}
if [[ "${NO_OPTIMIZE:-0}" != "1" ]]; then
  echo "optimize:"
  if [[ "$ONLY" == "all" || "$ONLY" == "architecture" || "$ONLY" == "arch" ]]; then
    optimize "$OUT_DIR/architecture-en.png" "$OUT_DIR/architecture-zh.png"
  fi
fi

echo "done"
