#!/usr/bin/env python3
"""把渲染出来的真彩 PNG 量化到 256 色（视觉无损，体积约 1/3）。

为什么值得：Chrome 截出来的暗色渐变图带抖动噪点，24 位 PNG 压不动——
架构图 425KB，README 首屏在手机网络上要多等几百毫秒。这些图的真实色数只有几十种，
量化到调色板后体积降到 1/8，肉眼分辨不出差别。

**用 FASTOCTREE 而不是 MEDIANCUT**：MEDIANCUT 会优先保住大面积色，
把交通灯那三个 5px 的饱和色点压成土褐色，同时在绿色辉光区留下明显的块状条纹；
FASTOCTREE 保色更均匀，实测渐变平滑、色点完整。
"""

import pathlib
import sys

from PIL import Image

for arg in sys.argv[1:]:
    path = pathlib.Path(arg)
    before = path.stat().st_size
    img = Image.open(path).convert("RGB")
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(
        path, optimize=True
    )
    after = path.stat().st_size
    print(f"  {path.name}: {before // 1024}KB → {after // 1024}KB")
