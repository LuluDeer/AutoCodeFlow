#!/usr/bin/env python3
"""品牌视觉资产生成器：标志 / README 首图 / 架构图（SVG 是唯一事实源）。

为什么要有这个脚本（而不是继续手搓 PNG）：
  仓库里的 `docs/assets/banner-{en,zh}.png` 与 `architecture-{en,zh}.png` 此前是
  「一次性位图」——没有源文件，改一个字要重画整张图，四个副本各自漂移，且与
  `apps/admin-web/src/theme/tokens.ts` 的色板没有任何机械约束。现在布局、色板、
  文案都收在这个文件里：SVG 由脚本产出，PNG 由 `scripts/brand/render-brand-assets.sh`
  用无头 Chrome 按 2x 栅格化。改文案只改 `COPY` / `ARCH`，四个文件不会跑偏。

  文字宽度用无头 Chrome 的 `getComputedTextLength()` 实测而不是按字数估算——
  估算会让「AutoCode‖Flow」之间裂开一道 90px 的缝、让能力标签冲出画布。

不改的东西：README 引用的文件名保持 `docs/assets/banner-{en,zh}.png`、
`architecture-{en,zh}.png`，markdown 不用动。

用法：
  python3 scripts/brand/build-brand-assets.py      # 写 SVG（需要 Chrome 量字）
  ./scripts/brand/render-brand-assets.sh           # SVG → PNG + 桌面图标
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap

ROOT = pathlib.Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------------------
# 品牌色板——与 apps/admin-web/src/theme/tokens.ts 同步（改这里时两边一起改）
# ---------------------------------------------------------------------------
C = {
    "canvas": "#0B1220",
    "panel": "#0E1828",
    "panel_hi": "#13223A",
    "panel_deep": "#0A1424",
    "stroke": "#22334D",
    "stroke_hi": "#2E4767",
    "ink": "#F8FAFC",
    "ink2": "#A9B8CC",
    "ink3": "#7C90AB",
    "ink4": "#52657F",
    "green": "#22C55E",
    "green_light": "#4ADE80",
    "green_deep": "#15803D",
    "blue": "#60A5FA",
    "amber": "#F59E0B",
    "sky": "#7DD3FC",
    "red": "#F87171",
    "yellow": "#FBBF24",
}

FONT_SANS = "'Lato','Noto Sans CJK SC','DejaVu Sans',sans-serif"
FONT_MONO = "'DejaVu Sans Mono','Noto Sans Mono','Liberation Mono',monospace"


# ---------------------------------------------------------------------------
# 文字宽度：探针跑两遍（第一遍只收集字符串，第二遍用实测宽度排版）
# ---------------------------------------------------------------------------
class Metrics:
    """`m(text, size, weight, mono, ls)` → 宽度 px。"""

    def __init__(self, widths: dict[tuple, float] | None = None):
        self.widths = widths or {}
        self.pending: dict[tuple, float] = {}

    def __call__(self, s: str, size: float, weight: int = 400, *, mono: bool = False, ls: float = 0) -> float:
        key = (s, round(size, 2), weight, mono, round(ls, 2))
        if key in self.widths:
            return self.widths[key]
        # 探针阶段的估值只用于「有没有越界」的自检，不参与最终排版。
        est = sum(1.0 if ord(ch) > 0x2E80 else (0.60 if mono else 0.52) for ch in s) * size + ls * max(len(s) - 1, 0)
        self.pending[key] = est
        return est


def measure_with_chrome(items: list[tuple]) -> dict[tuple, float]:
    """用无头 Chrome 实测 SVG 文本宽度（字体回退与 letter-spacing 都按真实排版算）。"""
    chrome = _chrome()
    rows = []
    for i, (s, size, weight, mono, ls) in enumerate(items):
        fam = FONT_MONO if mono else FONT_SANS
        rows.append(
            f'<text id="t{i}" font-family="{fam}" font-size="{size:g}" font-weight="{weight}" '
            f'letter-spacing="{ls:g}" xml:space="preserve">{esc(s)}</text>'
        )
    html = (
        "<!doctype html><meta charset=\"utf-8\"><body><pre id=\"out\">pending</pre>"
        f"<svg id=\"s\" width=\"10\" height=\"10\">"
        + "".join(rows)
        + "</svg><script>document.fonts.ready.then(()=>{"
        "const s=document.getElementById('s');const out=[];"
        "for(const el of [...s.querySelectorAll('text')]){out.push(el.getComputedTextLength());}"
        "document.getElementById('out').textContent=JSON.stringify(out);});</script></body>"
    )
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "m.html"
        p.write_text(html, encoding="utf-8")
        dom = subprocess.run(
            [chrome, "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=4000", "--dump-dom", f"file://{p}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    m = re.search(r'<pre id="out">(\[.*?\])</pre>', dom, re.S)
    if not m:
        raise RuntimeError("text measurement failed (no #out payload)")
    widths = json.loads(m.group(1).replace("&quot;", '"').replace("&amp;", "&"))
    return {tuple(k): float(v) for k, v in zip(items, widths)}


def _chrome() -> str:
    import os
    import shutil

    for name in (os.environ.get("CHROME"), "google-chrome", "chromium", "chromium-browser", "google-chrome-stable"):
        if name and shutil.which(name):
            return name
    raise RuntimeError("need Chrome/Chromium to measure text (set CHROME=/path/to/chrome)")


# ---------------------------------------------------------------------------
# 基础绘制原语
# ---------------------------------------------------------------------------
def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, *, size=16, fill=None, weight=400, mono=False, anchor="start", ls=0, opacity=None) -> str:
    attrs = [
        f'x="{x:g}"',
        f'y="{y:g}"',
        f'font-family="{FONT_MONO if mono else FONT_SANS}"',
        f'font-size="{size:g}"',
        f'font-weight="{weight}"',
        f'fill="{fill or C["ink"]}"',
    ]
    if anchor != "start":
        attrs.append(f'text-anchor="{anchor}"')
    if ls:
        attrs.append(f'letter-spacing="{ls:g}"')
    if opacity is not None:
        attrs.append(f'opacity="{opacity:g}"')
    return f'<text {" ".join(attrs)} xml:space="preserve">{esc(s)}</text>'


def rect(x, y, w, h, *, rx=0, fill="none", stroke=None, sw=1, opacity=None, extra="") -> str:
    parts = [f'x="{x:g}"', f'y="{y:g}"', f'width="{w:g}"', f'height="{h:g}"']
    if rx:
        parts.append(f'rx="{rx:g}"')
    parts.append(f'fill="{fill}"')
    if stroke:
        parts.append(f'stroke="{stroke}" stroke-width="{sw:g}"')
    if opacity is not None:
        parts.append(f'opacity="{opacity:g}"')
    if extra:
        parts.append(extra)
    return f'<rect {" ".join(parts)}/>'


def pill(x, y, w, h, *, fill="#12233A", stroke=None) -> str:
    return rect(x, y, w, h, rx=h / 2, fill=fill, stroke=stroke or C["stroke"], sw=1)


# ---------------------------------------------------------------------------
# 标志（mark）：深色圆角方块 + 双箭头「流」
#
# 设计约束（写下来是为了以后别改坏）：
#   * 16px 下必须可辨 ⇒ 只有两笔，笔画 7/64，圆头圆角，不用细线/描边嵌套；
#   * 只用两个色相（navy 底 / 绿流），小尺寸不出彩色噪点；
#   * 出框留白 ≥ 8/64，任务栏与浏览器标签裁切都不吃主体；
#   * 第二笔压到 38% 不透明度 ⇒ 读出「一串任务往前走」的方向感，而不是一个播放键。
# ---------------------------------------------------------------------------
def mark_svg(size: int = 64, *, background: bool = True) -> str:
    """标志：圆角六边形剪影 + 透明挖空的方向箭头。

    为什么是「剪影 + 负空间」而不是插画（参考 Docker 的鲸鱼、GitHub 的猫、
    Firefox 的狐狸抱地球、Clash 的猫头）：这几家的图标在 16px 下都只剩**一个轮廓**
    和**一处镂空**。细节、渐变、立体感在 32px 以下全部消失，只会变成一团脏东西。
    所以这里只有两个元素，没有第三个。

    三个关键约束，改之前先读：
      1. **挖空必须是透明的**（mask 而不是画一个深色箭头）——这样同一份文件在深色底
         露出深色箭头、在浅色底露出白色箭头，一套文件通吃，不用维护亮/暗两版。
      2. 六边形的**圆角半径 4/64**：太小像螺母，太大像圆点；4 在 32px 与 256px 都稳。
      3. 箭头笔画 7.4/64、圆头圆角；低于 6 在 16px 下会断成一串点。

    语义：六边形 = 执行器节点 / 蜂巢式编排；箭头 = 派发与执行的方向。
    这两件事正好是本产品区别于「又一个 cron 面板」的地方。
    """
    r = size * 0.234
    k = size / 64.0

    def p(v: float) -> str:
        return f"{v * k:g}"

    # 圆角六边形（顶点在左右，上下为平边）：8.2..55.8 × 6.2..58
    hex_path = (
        f"M{p(32)} {p(6.2)} L{p(53.8)} {p(18.8)} a{p(4)} {p(4)} 0 0 1 {p(2)} {p(3.5)} "
        f"V{p(41.7)} a{p(4)} {p(4)} 0 0 1 -{p(2)} {p(3.5)} L{p(34)} {p(58)} "
        f"a{p(4)} {p(4)} 0 0 1 -{p(4)} 0 L{p(10.2)} {p(45.2)} a{p(4)} {p(4)} 0 0 1 -{p(2)} -{p(3.5)} "
        f"V{p(22.3)} a{p(4)} {p(4)} 0 0 1 {p(2)} -{p(3.5)} L{p(30)} {p(6.2)} a{p(4)} {p(4)} 0 0 1 {p(4)} 0 Z"
    )
    arrow = f"M{p(25)} {p(19.5)} L{p(40)} {p(32)} L{p(25)} {p(44.5)}"

    bg = ""
    if background:
        bg = (
            f'<rect width="{size}" height="{size}" rx="{r:g}" fill="url(#mark-bg)"/>'
            f'<rect x="{0.75:g}" y="{0.75:g}" width="{size - 1.5:g}" height="{size - 1.5:g}" '
            f'rx="{max(r - 0.75, 0):g}" fill="none" stroke="{C["green"]}" stroke-opacity="0.22" '
            f'stroke-width="{max(size / 64, 1):g}"/>'
        )
    return textwrap.dedent(
        f"""\
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="AutoCodeFlow">
          <defs>
            <linearGradient id="mark-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="{C["panel_hi"]}"/>
              <stop offset="1" stop-color="{C["canvas"]}"/>
            </linearGradient>
            <linearGradient id="mark-hex" x1="0.15" y1="0" x2="0.85" y2="1">
              <stop offset="0" stop-color="#31D46E"/>
              <stop offset="1" stop-color="{C["green_deep"]}"/>
            </linearGradient>
            <mask id="mark-cut">
              <rect width="{size}" height="{size}" fill="#fff"/>
              <path d="{arrow}" fill="none" stroke="#000" stroke-width="{p(7.4)}"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </mask>
          </defs>
          {bg}
          <path d="{hex_path}" fill="url(#mark-hex)" mask="url(#mark-cut)"/>
        </svg>
        """
    )


def mark_inline(size: int, x: float, y: float) -> str:
    body = mark_svg(size).split(">", 1)[1].rsplit("</svg>", 1)[0]
    return f'<g transform="translate({x:g},{y:g})">{body}</g>'


# ---------------------------------------------------------------------------
# 24×24 线性图标（架构图卡片用）——纯几何，1.7 描边，20~22px 下仍清晰
# ---------------------------------------------------------------------------
GLYPHS = {
    "browser": '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9.2h18"/>'
    '<circle cx="6.2" cy="7.1" r=".85" fill="currentColor" stroke="none"/>',
    "cli": '<path d="M5 7.5l4.6 4.5L5 16.5"/><path d="M12.5 17h6.5"/>',
    "spark": '<path d="M12 3.2l2.15 6.65L20.8 12l-6.65 2.15L12 20.8l-2.15-6.65L3.2 12l6.65-2.15z"/>',
    "cube": '<path d="M12 3.4l7.4 4.3v8.6L12 20.6l-7.4-4.3V7.7z"/><path d="M4.6 7.7L12 12l7.4-4.3"/>'
    '<path d="M12 12v8.6"/>',
    "hex": '<path d="M12 3.3l7.2 4.15v8.3L12 20.7l-7.2-4.15v-8.3z"/><circle cx="12" cy="12" r="2.3"/>',
    "nodes": '<circle cx="12" cy="5.6" r="2.4"/><circle cx="5.8" cy="18" r="2.4"/>'
    '<circle cx="18.2" cy="18" r="2.4"/><path d="M12 8v4.6M10.2 13.4l-2.9 2.5M13.8 13.4l2.9 2.5"/>',
    "run": '<circle cx="12" cy="12" r="8.2"/><path d="M10.2 8.6l6 3.4-6 3.4z"/>',
    "monitor": '<rect x="3" y="5" width="18" height="11.6" rx="2.2"/><path d="M9 20.6h6M12 16.6v4"/>',
}


def glyph(name: str, x: float, y: float, box: float, color: str) -> str:
    """圆角小底板 + 线性图标；`currentColor` 借 stroke 着色，避免每个 path 重复写色值。"""
    g = GLYPHS[name]
    s = box / 24.0
    return (
        f'<g transform="translate({x:g},{y:g})">'
        f'{rect(0, 0, box, box, rx=box * 0.28, fill=color, opacity=0.10)}'
        f'<g transform="scale({s:g})" fill="none" stroke="{color}" stroke-width="1.7" '
        f'stroke-linecap="round" stroke-linejoin="round" color="{color}">{g}</g></g>'
    )


# ---------------------------------------------------------------------------
# README 首图
# ---------------------------------------------------------------------------
COPY = {
    "en": {
        "name_a": "AutoCode",
        "name_b": "Flow",
        "tagline": "The open-source automation runtime",
        "sub": "Scripts, desktops and AI agents on one auditable scheduler",
        "chips": ["cron · webhook · DAG", "Windows & Linux", "MCP + SDK", "self-hosted"],
        "foot": "AGPL-3.0  ·  TypeScript + Python  ·  executors never open an inbound port",
        "term": [
            ("$", "acf task trigger order-sync --wait", "cmd"),
            ("→", "execution 8a24c…3ce1 queued · executor-win-03", "info"),
            ("·", "[order-sync] upserted 1500 orders", "out"),
            ("✓", "status=success   duration=412ms", "ok"),
        ],
    },
    "zh": {
        "name_a": "AutoCode",
        "name_b": "Flow",
        "tagline": "开源的自动化执行运行时",
        "sub": "定时脚本 · 桌面操作 · AI Agent，收进同一张可审计的调度台",
        "chips": ["Cron / Webhook / DAG", "桌面自动化", "Claude & Cursor", "私有化部署"],
        "foot": "AGPL-3.0  ·  TypeScript + Python  ·  执行器只拉取，不暴露入站端口",
        "term": [
            ("$", "acf task trigger order-sync --wait", "cmd"),
            ("→", "execution 8a24c…3ce1 queued · executor-win-03", "info"),
            ("·", "[order-sync] upserted 1500 orders", "out"),
            ("✓", "status=success   duration=412ms", "ok"),
        ],
    },
}

BW_, BH_ = 1760, 468


def banner(lang: str, m: Metrics) -> str:
    c = COPY[lang]
    o: list[str] = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BW_} {BH_}" width="{BW_}" height="{BH_}" role="img">')
    o.append(
        f"""<defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0C1424"/>
        <stop offset="0.55" stop-color="{C["canvas"]}"/>
        <stop offset="1" stop-color="#080E18"/>
      </linearGradient>
      <radialGradient id="glow-green" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="{C["green"]}" stop-opacity="0.20"/>
        <stop offset="1" stop-color="{C["green"]}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glow-blue" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="{C["blue"]}" stop-opacity="0.12"/>
        <stop offset="1" stop-color="{C["blue"]}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="flow-text" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="{C["green"]}"/>
        <stop offset="1" stop-color="#6EE7A8"/>
      </linearGradient>
      <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="{C["green_light"]}" stop-opacity="0.9"/>
        <stop offset="0.4" stop-color="{C["stroke_hi"]}" stop-opacity="0.85"/>
        <stop offset="1" stop-color="{C["stroke_hi"]}" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="card-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#15263F"/>
        <stop offset="1" stop-color="{C["panel"]}"/>
      </linearGradient>
      <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="{C["green"]}" stop-opacity="0"/>
        <stop offset="0.45" stop-color="{C["green_light"]}" stop-opacity="0.95"/>
        <stop offset="1" stop-color="{C["green"]}" stop-opacity="0"/>
      </linearGradient>
      <filter id="soft" x="-30%" y="-30%" width="160%" height="190%">
        <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000" flood-opacity="0.55"/>
      </filter>
      <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
        <path d="M44 0H0V44" fill="none" stroke="#7C93B4" stroke-opacity="0.05" stroke-width="1"/>
      </pattern>
    </defs>"""
    )

    o.append(rect(0, 0, BW_, BH_, fill="url(#bg)"))
    o.append(rect(0, 0, BW_, BH_, fill="url(#grid)"))
    o.append('<ellipse cx="1270" cy="10" rx="520" ry="300" fill="url(#glow-green)"/>')
    o.append('<ellipse cx="110" cy="480" rx="420" ry="240" fill="url(#glow-blue)"/>')

    # ---- 左：标志 + 字标 + 标语 + 能力标签 ----
    o.append(mark_inline(92, 112, 92))

    name_size = 62
    o.append(text(232, 168, c["name_a"], size=name_size, weight=900, ls=-1.6))
    w_a = m(c["name_a"], name_size, 900, ls=-1.6)
    o.append(text(232 + w_a, 168, c["name_b"], size=name_size, weight=900, fill="url(#flow-text)", ls=-1.6))
    rule_w = m(c["name_a"] + c["name_b"], name_size, 900, ls=-1.6) + 68
    o.append(rect(232, 200, rule_w, 1.4, fill="url(#rule)"))

    o.append(text(232, 252, c["tagline"], size=31, weight=500))
    o.append(text(232, 290, c["sub"], size=19, fill=C["ink2"]))

    # 能力标签：按实测宽度排，越界就换行（换行也不会压到页脚）
    x, y = 232.0, 316.0
    chip_fs = 14
    max_x = 906
    for label in c["chips"]:
        w = m(label, chip_fs, 500) + 40
        if x + w > max_x:
            x, y = 232.0, y + 48
        o.append(pill(x, y, w, 36, fill="#15253A", stroke=C["stroke"]))
        o.append(f'<circle cx="{x + 17:g}" cy="{y + 18:g}" r="3.1" fill="{C["green"]}"/>')
        o.append(text(x + 28, y + 23.5, label, size=chip_fs, weight=500, fill=C["ink2"]))
        x += w + 10

    o.append(text(112, 430, c["foot"], size=14, mono=True, fill=C["ink4"]))

    # ---- 右：终端卡片（用一次真实执行讲清「自动化」）----
    cx, cy, cw, ch = 942, 76, 706, 316
    o.append(f'<g filter="url(#soft)">{rect(cx, cy, cw, ch, rx=18, fill="url(#card-bg)", stroke=C["stroke_hi"], sw=1.4)}</g>')
    o.append(
        f'<path d="M{cx} {cy + 44} V{cy + 18} a18 18 0 0 1 18 -18 h{cw - 36} a18 18 0 0 1 18 18 V{cy + 44} Z" '
        f'fill="#0A1220" opacity="0.94"/>'
    )
    o.append(rect(cx, cy + 43.4, cw, 1.2, fill=C["stroke"]))
    for i, color in enumerate((C["red"], C["yellow"], C["green_light"])):
        o.append(f'<circle cx="{cx + 26 + i * 20:g}" cy="{cy + 22:g}" r="5.2" fill="{color}" opacity="0.85"/>')
    o.append(text(cx + 96, cy + 27, "acf · terminal", size=13.5, mono=True, fill=C["ink3"], ls=0.4))
    o.append(text(cx + cw - 26, cy + 27, "~/autoflow", size=13, mono=True, fill=C["ink4"], anchor="end"))
    o.append(rect(cx - 0.6, cy + 96, 2.6, ch - 190, fill="url(#edge)"))

    colors = {"cmd": C["sky"], "info": C["ink3"], "out": C["ink2"], "ok": C["green_light"]}
    ty = cy + 92
    for g, body, kind in c["term"]:
        o.append(text(cx + 40, ty, g, size=16, weight=700, mono=True, fill=C["green"] if kind == "cmd" else colors[kind]))
        o.append(text(cx + 64, ty, body, size=15.5, mono=True, fill=colors[kind]))
        ty += 46
    o.append(text(cx + 40, cy + ch - 24, "● live", size=12.5, mono=True, fill=C["green"], ls=0.5))
    o.append(text(cx + cw - 40, cy + ch - 24, "3 executors online · queue 0", size=12.5, mono=True, fill=C["ink4"], anchor="end"))

    o.append("</svg>")
    return "\n".join(o)


# ---------------------------------------------------------------------------
# 架构图
# ---------------------------------------------------------------------------
ARCH = {
    "en": {
        "title": "AutoCodeFlow architecture",
        "sub": "Three layers, one direction of trust: clients call the control plane, executors only pull.",
        "bands": [
            {
                "n": "01",
                "name": "CLIENTS",
                "note": "where work starts",
                "tint": C["blue"],
                "cards": [
                    ("browser", "admin-web", "console", "browser · React SPA"),
                    ("cli", "acf CLI", "command line", "acf task · logs · replay"),
                    ("spark", "MCP Server", "AI agents", "Claude · Cursor · Codex"),
                    ("cube", "SDK", "in-task", "@autocodeflow/sdk · autoflow-sdk"),
                ],
            },
            {
                "n": "02",
                "name": "CONTROL PLANE",
                "note": "owns every scheduling decision and every record",
                "tint": C["green"],
                "cards": [],
            },
            {
                "n": "03",
                "name": "EXECUTION PLANE",
                "note": "stateless · pull-only · no inbound ports",
                "tint": C["amber"],
                "cards": [
                    ("nodes", "executor-node", "JS / Shell", ":8002 · Docker or host"),
                    ("run", "executor-python", "Python", ":8001 · uv multi-version"),
                    ("monitor", "executor-desktop", "Desktop / local automation", "Windows & Linux · tray app"),
                ],
            },
        ],
        "api": ("hex", "admin-api", "scheduling · callbacks · RBAC · audit · notifications"),
        "api_chips": ["Cron / rate / webhook / DAG", "Leases & concurrency gates", "Retries · timeouts · alerts"],
        "stores": [
            ("PostgreSQL 16", "state, audit log, migrations"),
            ("Redis 7 · BullMQ", "queue, leases, rate limits"),
            ("private npm / PyPI", "artifact registry"),
        ],
        "edge_down": "REST / SSE",
        "edge_up": "register · heartbeat · claim · callback",
        "foot": "Deployment: Docker Compose (single node / staging)  ·  source mode (production)  ·  multi-instance HA",
        "legend": ("call · REST / SSE from clients", "pull · executors never listen"),
    },
    "zh": {
        "title": "AutoCodeFlow 系统架构",
        "sub": "三层一条信任方向：客户端调用控制面，执行面只拉取、不接受入站连接。",
        "bands": [
            {
                "n": "01",
                "name": "客户端",
                "note": "所有工作的起点",
                "tint": C["blue"],
                "cards": [
                    ("browser", "admin-web", "控制台", "浏览器 · React SPA"),
                    ("cli", "acf CLI", "命令行", "acf task · 日志 · 重放"),
                    ("spark", "MCP Server", "AI Agent", "Claude · Cursor · Codex"),
                    ("cube", "SDK", "任务内", "@autocodeflow/sdk · autoflow-sdk"),
                ],
            },
            {
                "n": "02",
                "name": "控制面",
                "note": "持有全部调度决策与审计记录",
                "tint": C["green"],
                "cards": [],
            },
            {
                "n": "03",
                "name": "执行面",
                "note": "无状态 · 只拉取 · 不暴露入站端口",
                "tint": C["amber"],
                "cards": [
                    ("nodes", "executor-node", "JS / Shell", ":8002 · Docker 或宿主机"),
                    ("run", "executor-python", "Python", ":8001 · uv 多版本"),
                    ("monitor", "executor-desktop", "桌面 / 本地自动化", "Windows 与 Linux · 托盘应用"),
                ],
            },
        ],
        "api": ("hex", "admin-api", "调度 · 回调 · RBAC · 审计 · 通知"),
        "api_chips": ["Cron / 固定频率 / Webhook / DAG", "租约与并发闸", "重试 · 超时 · 告警"],
        "stores": [
            ("PostgreSQL 16", "状态、审计日志、迁移"),
            ("Redis 7 · BullMQ", "队列、租约、限流"),
            ("私有 npm / PyPI", "制品仓库"),
        ],
        "edge_down": "REST / SSE",
        "edge_up": "注册 · 心跳 · 领任务 · 回调",
        "foot": "部署形态：Docker Compose（单机 / staging）  ·  源码模式（生产）  ·  多实例 HA",
        "legend": ("调用 · 客户端走 REST / SSE", "拉取 · 执行器从不监听端口"),
    },
}

AW_, AH_ = 1760, 1180
BX, BWD, PAD, GAP = 88, 1584, 34, 18
BAND1_Y, BAND1_H = 196, 176
BAND2_Y, BAND2_H = 462, 300
BAND3_Y, BAND3_H = 852, 246


def arch(lang: str, m: Metrics) -> str:
    a = ARCH[lang]
    o: list[str] = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {AW_} {AH_}" width="{AW_}" height="{AH_}" role="img">')
    o.append(
        f"""<defs>
      <linearGradient id="abg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0C1524"/>
        <stop offset="1" stop-color="{C["canvas"]}"/>
      </linearGradient>
      <radialGradient id="aglow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="{C["green"]}" stop-opacity="0.09"/>
        <stop offset="1" stop-color="{C["green"]}" stop-opacity="0"/>
      </radialGradient>
      <pattern id="adots" width="28" height="28" patternUnits="userSpaceOnUse">
        <circle cx="1.2" cy="1.2" r="1.1" fill="#8FA6C4" fill-opacity="0.09"/>
      </pattern>
      <linearGradient id="card2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#12213A"/>
        <stop offset="1" stop-color="{C["panel"]}"/>
      </linearGradient>
      <marker id="arrow" viewBox="0 0 12 12" refX="8.5" refY="6" markerWidth="6.5" markerHeight="6.5" orient="auto">
        <path d="M1 1 L10 6 L1 11 Z" fill="{C["green_light"]}"/>
      </marker>
      <marker id="arrow-amber" viewBox="0 0 12 12" refX="8.5" refY="6" markerWidth="6.5" markerHeight="6.5" orient="auto">
        <path d="M1 1 L10 6 L1 11 Z" fill="{C["amber"]}"/>
      </marker>
      <filter id="acard" x="-25%" y="-45%" width="150%" height="210%">
        <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.5"/>
      </filter>
    </defs>"""
    )
    o.append(rect(0, 0, AW_, AH_, fill="url(#abg)"))
    o.append(rect(0, 0, AW_, AH_, fill="url(#adots)"))
    o.append('<ellipse cx="1500" cy="120" rx="420" ry="300" fill="url(#aglow)"/>')

    # ---- 页眉 ----
    o.append(mark_inline(52, 88, 46))
    o.append(text(156, 84, a["title"], size=36, weight=900, ls=-0.5))
    o.append(text(88, 128, a["sub"], size=18, fill=C["ink2"]))

    # 图例：两条边语义不同（调用 vs 拉取），不标清就只是装饰
    lx, ly = 1232, 60
    o.append(rect(lx - 20, ly - 8, 408, 84, rx=12, fill="#0C1728", stroke=C["stroke"], sw=1))
    o.append(f'<path d="M{lx} {ly + 14} h34" stroke="{C["green_light"]}" stroke-width="2.6" fill="none" marker-end="url(#arrow)"/>')
    o.append(text(lx + 48, ly + 19, a["legend"][0], size=13.5, mono=True, fill=C["ink2"]))
    o.append(f'<path d="M{lx} {ly + 52} h34" stroke="{C["amber"]}" stroke-width="2.4" stroke-dasharray="6 5" fill="none" marker-end="url(#arrow-amber)"/>')
    o.append(text(lx + 48, ly + 57, a["legend"][1], size=13.5, mono=True, fill=C["ink2"]))

    # ---- 三层容器 ----
    band_geom = [(BAND1_Y, BAND1_H), (BAND2_Y, BAND2_H), (BAND3_Y, BAND3_H)]
    for (by, bh), band in zip(band_geom, a["bands"]):
        tint = band["tint"]
        o.append(rect(BX, by, BWD, bh, rx=18, fill=tint, opacity=0.045))
        o.append(rect(BX, by, BWD, bh, rx=18, stroke=tint, sw=1.2, extra='opacity="0.28"'))
        o.append(rect(BX, by + 26, 4, bh - 52, rx=2, fill=tint, extra='opacity="0.8"'))
        o.append(text(BX + PAD, by + 42, band["n"], size=13, weight=700, mono=True, fill=tint, ls=2))
        o.append(text(BX + PAD + 36, by + 42, band["name"], size=17, weight=700, ls=2.2))
        note_x = BX + PAD + 36 + m(band["name"], 17, 700, ls=2.2) + 22
        o.append(text(note_x, by + 42, band["note"], size=14.5, fill=C["ink3"]))

    # ---- 客户端 ----
    cw = (BWD - PAD * 2 - 3 * GAP) / 4
    for i, (ic, name, role, detail) in enumerate(a["bands"][0]["cards"]):
        x = BX + PAD + i * (cw + GAP)
        y = BAND1_Y + 62
        o.append(f'<g filter="url(#acard)">{rect(x, y, cw, 88, rx=13, fill="url(#card2)", stroke=C["stroke_hi"], sw=1.1)}</g>')
        o.append(rect(x + 14, y, cw - 28, 1.2, fill="#7C93B4", opacity=0.22))
        o.append(glyph(ic, x + 18, y + 28, 32, C["blue"]))
        o.append(text(x + 62, y + 36, name, size=19, weight=700, mono=True))
        o.append(text(x + 62, y + 58, role, size=14, weight=500, fill=C["blue"]))
        o.append(text(x + 62, y + 77, detail, size=12.5, fill=C["ink3"]))

    # ---- 控制面 ----
    ic, api_name, api_sub = a["api"]
    ax, ay = BX + PAD, BAND2_Y + 62
    aw = BWD - PAD * 2
    o.append(f'<g filter="url(#acard)">{rect(ax, ay, aw, 96, rx=13, fill="url(#card2)", stroke=C["stroke_hi"], sw=1.1)}</g>')
    o.append(rect(ax + 14, ay, aw - 28, 1.2, fill="#7C93B4", opacity=0.22))
    o.append(glyph(ic, ax + 20, ay + 32, 32, C["green"]))
    o.append(text(ax + 64, ay + 42, api_name, size=21, weight=700, mono=True))
    o.append(text(ax + 64, ay + 70, api_sub, size=14.5, fill=C["ink3"]))
    # 能力 chips：右对齐，从卡片右边往回排，避免和中/英文标题宽度耦合
    chip_fs = 13.5
    total = sum(m(label, chip_fs, 500) + 30 for label in a["api_chips"]) + 10 * (len(a["api_chips"]) - 1)
    cxp = ax + aw - 22 - total
    for label in a["api_chips"]:
        w = m(label, chip_fs, 500) + 30
        o.append(pill(cxp, ay + 32, w, 32, fill="#14263B"))
        o.append(text(cxp + 15, ay + 53, label, size=chip_fs, weight=500, fill=C["ink2"]))
        cxp += w + 10

    sy = ay + 114
    sw3 = (BWD - PAD * 2 - 2 * GAP) / 3
    for i, (name, detail) in enumerate(a["stores"]):
        x = BX + PAD + i * (sw3 + GAP)
        o.append(rect(x, sy, sw3, 82, rx=12, fill=C["panel_deep"], stroke=C["stroke"], sw=1))
        o.append(f'<circle cx="{x + 20:g}" cy="{sy + 32:g}" r="3.6" fill="{C["green"]}" opacity="0.6"/>')
        o.append(text(x + 36, sy + 38, name, size=15.5, weight=700, mono=True, fill=C["ink2"]))
        o.append(text(x + 20, sy + 64, detail, size=13, fill=C["ink3"]))

    # ---- 执行面 ----
    ew = (BWD - PAD * 2 - 2 * GAP) / 3
    for i, (ic, name, role, detail) in enumerate(a["bands"][2]["cards"]):
        x = BX + PAD + i * (ew + GAP)
        y = BAND3_Y + 62
        o.append(f'<g filter="url(#acard)">{rect(x, y, ew, 152, rx=13, fill="url(#card2)", stroke=C["stroke_hi"], sw=1.1)}</g>')
        o.append(rect(x + 14, y, ew - 28, 1.2, fill="#7C93B4", opacity=0.22))
        o.append(glyph(ic, x + 22, y + 22, 36, C["amber"]))
        o.append(text(x + 70, y + 44, name, size=18, weight=700, mono=True))
        o.append(text(x + 70, y + 68, role, size=14, weight=500, fill=C["amber"]))
        o.append(text(x + 22, y + 96, detail, size=13, fill=C["ink3"]))
        o.append(rect(x + 22, y + 112, ew - 44, 1, fill=C["stroke"]))
        o.append(text(x + 22, y + 136, "pull → execute → report", size=12.5, mono=True, fill=C["ink4"]))

    # ---- 层间连线 ----
    mid = BX + BWD / 2
    o.append(f'<path d="M{mid} {BAND1_Y + BAND1_H} V{BAND2_Y - 4}" stroke="{C["green_light"]}" stroke-width="2.6" fill="none" marker-end="url(#arrow)"/>')
    lw = m(a["edge_down"], 13.5, 500, mono=True) + 32
    o.append(pill(mid + 24, BAND1_Y + BAND1_H + 18, lw, 30, fill="#0F1E32"))
    o.append(text(mid + 40, BAND1_Y + BAND1_H + 38, a["edge_down"], size=13.5, mono=True, fill=C["ink2"]))

    o.append(
        f'<path d="M{mid} {BAND2_Y + BAND2_H} V{BAND3_Y - 4}" stroke="{C["amber"]}" stroke-width="2.4" '
        f'stroke-dasharray="7 6" fill="none" marker-end="url(#arrow-amber)"/>'
    )
    lw = m(a["edge_up"], 13.5, 500, mono=True) + 32
    o.append(pill(mid + 24, BAND2_Y + BAND2_H + 18, lw, 30, fill="#0F1E32"))
    o.append(text(mid + 40, BAND2_Y + BAND2_H + 38, a["edge_up"], size=13.5, mono=True, fill=C["ink2"]))

    o.append(text(BX, 1146, a["foot"], size=14, mono=True, fill=C["ink4"]))
    o.append("</svg>")
    return "\n".join(o)


# ---------------------------------------------------------------------------
def build(m: Metrics) -> dict[str, str]:
    return {
        "design-system/brand/svg/acf-mark.svg": mark_svg(64),
        "design-system/brand/svg/acf-mark-512.svg": mark_svg(512),
        "design-system/brand/svg/banner-en.svg": banner("en", m),
        "design-system/brand/svg/banner-zh.svg": banner("zh", m),
        "design-system/brand/svg/architecture-en.svg": arch("en", m),
        "design-system/brand/svg/architecture-zh.svg": arch("zh", m),
        # 落地副本：favicon 与文档站 logo 必须和源文件同字节，避免「改了源图没改线上」
        "apps/admin-web/public/acf-mark.svg": mark_svg(64),
        "packages/docs-site/public/logo.svg": mark_svg(64),
    }


def main() -> None:
    """两遍排版：第一遍收集所有待测字符串（宽度只是估值），第二遍用实测宽度重排。"""
    probe = Metrics()
    build(probe)
    try:
        widths = measure_with_chrome(list(probe.pending))
    except Exception as exc:  # 没有 Chrome 时仍产出可用的 SVG（估值排版），但要说清降级了
        print(f"warn: text measurement unavailable ({exc}); falling back to estimated widths", file=sys.stderr)
        widths = probe.pending

    for rel, content in build(Metrics(widths)).items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"wrote {rel} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
