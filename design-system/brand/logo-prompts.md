# 标志出图提示词（Logo / App Icon）

> **受众**：想用 AI 出图工具（GPT Image、Seedream、Midjourney…）做标志的人。
> **状态**：稳定 · **最后核对**：2026-11-02
> 一句话：仓库里落地的是矢量标志（`acf-mark.svg`，见 [README.md](README.md)）；
> 本文件解决的是「怎么让图生模型吐出**能用的标志**，而不是一张插画」。

---

## 1. 先看参考系到底做对了什么

点名的那四个图标，共同点不是「好看」，是**信息量极小**：

| 图标 | 剪影 | 细节 | 颜色 | 16px 剩下什么 |
|---|---|---|---|---|
| Docker | 一头鲸鱼 | 背上几个方块 | 1 蓝 + 白 | 一条鱼 + 几个凸起 |
| GitHub | 猫 | 无（全靠轮廓） | 1 黑 + 白 | 一个圆 + 两只耳 |
| Firefox | 狐狸抱住地球 | 无 | 2–3 橙 + 紫 | 一个环 + 一圈弧 |
| Clash | 猫头 | 无 | 1–2 | 一个带耳的圆 |

**判据只有一条：缩到 16px 之后，还剩下几个可辨认的形状？** 剩下「一个轮廓 + 一处镂空」
就成立。剩下三个以上，或者靠渐变、立体、小道具撑辨识度，就不成立。

所以给模型下提示词时，最该写进去的不是「可爱」「科幻」「科技感」，
而是 **flat vector logo mark / single silhouette / negative space / two colors / no text**。

## 2. 为什么之前那版提示词会翻车

上一版写的是「chibi（Q 版）角色 + 围裙 + 扳手 + 终端窗口 + 数据流线」。
这是**插画**的写法——六个元素、三处道具、需要明暗交代体积。模型会老实全部画出来：

- 256px 看很热闹；
- 32px 变成一团彩色噪点；
- 而且**没法改**：路径是位图里长出来的，换个主色要重画整张。

同理，`mascot`、`cute`、`cartoon character`、`3D render`、`clay`、`sticker`
这些词一出现，模型基本就告别标志了。

## 3. 三个能用的提示词模板

> 前提：**先确定形状，再让模型去画**。形状不写清楚，模型只会给你一只漂亮的动物。
> 下面三条对应试过的三个方向，A 是已落地那个。

### A · 六边形 + 负空间箭头（已落地，推荐）

```text
Flat vector logo mark: one rounded hexagon silhouette in vivid green #22C55E,
with a single arrow pointing right cut out of its center as transparent negative
space. Only two elements, nothing else. No gradient, no shading, no outline, no
highlights, no gloss, no texture, no text, no letters. Perfectly centered on a
plain very dark navy #0B1220 rounded square, generous empty margin on all sides,
crisp hard edges, geometric app-icon style like Docker or GitHub's mark, readable
when shrunk to 16 pixels, 1:1, 1024x1024
```

### B · 单色剪影动物（如果还是想要动物）

```text
Flat vector logo mark: a beaver head reduced to three shapes only — one rounded
head silhouette, two small round ears, one square tooth notch cut out as
transparent negative space at the bottom center. Solid bright green #22C55E,
see-through cut-outs, no eyes, no fur, no whiskers, no gradient, no outline,
no text. Pure silhouette, readable at 16 pixels, centered on a plain very dark
navy #0B1220 rounded square, 1:1, 1024x1024
```

### C · 猫头（Clash 那种：圆 + 两只尖耳）

```text
Extremely minimal flat logo mark: a cat head silhouette made of one circle plus
two sharp triangular ears, one thin negative-space slit for the muzzle. Single
solid green #22C55E on a plain very dark navy #0B1220 background, no eyes, no
whiskers, no gradient, no outline, no text, geometric, centered, 1:1, 1024x1024
```

### 反向提示词（每条都要带）

```text
illustration, cartoon character, mascot, sticker, cute chibi, 3d render, clay,
plastic, gradient mesh, glossy highlight, drop shadow, glow, texture, fur,
detailed shading, multiple objects, background scene, text, letters, watermark,
signature, thin hairline strokes, cluttered
```

### 各工具的参数

| 工具 | 关键设置 |
|---|---|
| **GPT Image / GPT-4o 图像** | 提示词尽量短、命令式；**贴一张参考图**（Docker 或 GitHub 的图标）并加一句 "match this level of simplicity"——这一招比改词有效得多 |
| **Seedream（即梦）** | 用中文描述 + 结尾加「矢量标志，扁平，纯色，负空间，极简，无文字」；风格选「平面设计 / 标志」而不是「插画」；否定词写进提示词尾部 |
| **Midjourney** | `--style raw --s 50 --ar 1:1`；logo 类必须压低 `--s`，否则自动加戏 |
| **SDXL / Flux** | 正向加 `flat vector logo, simple shapes, silhouette, two colors`；反向全量贴上面那段 |

## 4. 出图之后必须做的一步：描成矢量

模型给的永远是位图，**不能直接进仓库**：

1. 选出轮廓最干净的一张（通常是 6 张里最"空"的那张）；
2. 丢进 Inkscape（`路径 → 位图描摹`，阈值拉到只剩黑/白两色）或 Figma 的 trace 插件；
3. 在 64×64 网格上手工重画关键几何（对齐中心、统一笔画宽度）；
4. 换成本仓库色板（`#22C55E` / `#0B1220`）；
5. 落成 `scripts/brand/build-brand-assets.py` 里的 `mark_svg()`，再 `npm run brand:build`。

第 3 步不能省。描摹出来的路径通常是几百个锚点的锯齿，改不了尺寸也改不了颜色。

**更省事的路**：跳过模型，直接把形状写清楚，用矢量工具画。
`design-system/brand/svg/acf-mark.svg` 就是这么来的——1 条路径 + 1 个 mask，没有别的。

## 5. 验收清单

1. **16px**：还认得出是一个带箭头的六边形吗？（认不出就退回更简单的形）
2. **灰度**：去色后轮廓还立得住吗？
3. **深底 + 浅底**：同一份文件两边都要能用——所以挖空必须是透明的。
4. **和 Docker / GitHub 并排**：笔画粗细、圆角、留白是不是同一档？并排看立刻露馅。
5. **和产品对不对得上**：它说的是「节点 + 派发」，还是只说了「我是一只动物」？

## 6. 吉祥物（不是标志）

如果确实还需要一个「会说话的角色」用于社区、周边、文档插图——那是另一条线：
它出现在**大于 256px** 的场合，不承担 16px 的辨识任务，也不需要和标志同形。
这种场合才轮到 chibi / 围裙 / 扳手那一套写法。

### 已落地：狐狸（2026-11-02）

本仓库现在有**一只狐狸**（`design-system/brand/source/acf-mark-bare.png`），
但它**不占据标志位**——分工是：

| 位置 | 用谁 | 为什么 |
|---|---|---|
| 桌面执行器应用图标（任务栏 / 桌面快捷方式 / Alt-Tab） | **狐狸** | 产品形象，出现在人的视野里，要辨识度与亲和力 |
| 中台 favicon、文档站 logo | **狐狸** | 同上（内嵌 256 位图，引用路径不变） |
| 托盘图标（在线/离线/启动中） | **六边形** | 状态语汇：形状恒定、颜色表状态；16–24px 下狐狸不可辨 |
| 语义解读（节点 / 派发方向） | **六边形** | 狐狸不承载产品语义 |

所以第 5 节那条验收「它说的是『节点 + 派发』，还是只说了『我是一只动物』？」
——**答案可以分两层给**：标志层必须说清前者，形象层可以只是后者。

**代价（实测，别凭感觉推翻）**：

1. **16px 下狐狸是一团糊**——Windows 任务栏正是 16–24px，那里靠六边形撑；
2. **色板不同源**——原图是模型配的蓝紫渐变，与 `#22C55E` 无关；落地时由
   `build-fox-assets.py` 把狐狸合成到**品牌深色底板**上，让底板与色板同源；
3. **体积变大**——位图源压不动（1024 PNG 368KB，`.icns` 408KB），六边形 SVG 只有 1KB。

第 2、3 条是「位图当源」的固有代价：AI 出的图**没有矢量稿**，也就没有「改颜色」这件事。
接受它，或者自己描一份矢量稿（但照描的路径改不了尺寸也改不了颜色，见第 4 节）。
