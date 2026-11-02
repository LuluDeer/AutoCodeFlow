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

```
Flat vector logo mark: one rounded hexagon silhouette in vivid green #22C55E,
with a single arrow pointing right cut out of its center as transparent negative
space. Only two elements, nothing else. No gradient, no shading, no outline, no
highlights, no gloss, no texture, no text, no letters. Perfectly centered on a
plain very dark navy #0B1220 rounded square, generous empty margin on all sides,
crisp hard edges, geometric app-icon style like Docker or GitHub's mark, readable
when shrunk to 16 pixels, 1:1, 1024x1024
```

### B · 单色剪影动物（如果还是想要动物）

```
Flat vector logo mark: a beaver head reduced to three shapes only — one rounded
head silhouette, two small round ears, one square tooth notch cut out as
transparent negative space at the bottom center. Solid bright green #22C55E,
see-through cut-outs, no eyes, no fur, no whiskers, no gradient, no outline,
no text. Pure silhouette, readable at 16 pixels, centered on a plain very dark
navy #0B1220 rounded square, 1:1, 1024x1024
```

### C · 猫头（Clash 那种：圆 + 两只尖耳）

```
Extremely minimal flat logo mark: a cat head silhouette made of one circle plus
two sharp triangular ears, one thin negative-space slit for the muzzle. Single
solid green #22C55E on a plain very dark navy #0B1220 background, no eyes, no
whiskers, no gradient, no outline, no text, geometric, centered, 1:1, 1024x1024
```

### 反向提示词（每条都要带）

```
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

在此仓库里它**未启用**：`apps/executor-desktop/assets/` 目前用的是矢量标志。
要引入时必须守住一条——**favicon 继续用几何标志**，不要拿角色图去当 16px 图标。
