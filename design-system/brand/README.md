# 品牌视觉资产（Brand Assets）

> **受众**：改 README 首图 / 架构图 / 应用图标的人（含 AI agent）。
> **状态**：稳定 · **最后核对**：2026-11-02
> 一句话：AutoCodeFlow 的标志、README 首图、架构图、桌面端图标**全部由脚本生成**，
> SVG 是唯一事实源；改图 = 改 `scripts/brand/build-brand-assets.py` 里的文案与布局，
> 不要手改导出的 PNG。

---

## 1. 资产清单

| 资产 | 源（改这里） | 产物 | 用在哪 |
|---|---|---|---|
| 品牌标志 | `design-system/brand/svg/acf-mark.svg` | 同名 | favicon、文档站 logo、README 首图 |
| README 首图 | `design-system/brand/svg/banner-{en,zh}.svg` | `docs/assets/banner-{en,zh}.png` | `README.md` / `README.en.md` / `README.zh.md` |
| 架构图 | `design-system/brand/svg/architecture-{en,zh}.svg` | `docs/assets/architecture-{en,zh}.png` | README「Architecture / 系统架构」小节 |
| 应用图标 | `design-system/brand/svg/acf-mark-512.svg` | `apps/executor-desktop/assets/icon.{png,ico,icns}` | 桌面执行器打包 |
| 托盘图标 | 同上（换色） | `apps/executor-desktop/assets/tray-*.png` | 桌面执行器系统托盘 |

吉祥物候选与出图提示词见 [mascot-prompts.md](mascot-prompts.md)（目前**未启用**：仓库里落地的是几何标志）。

## 2. 怎么改

```bash
# 1) 改 scripts/brand/build-brand-assets.py 里的 COPY / ARCH 文案与布局
python3 scripts/brand/build-brand-assets.py     # 写 SVG（需要 Chrome 量字）
./scripts/brand/render-brand-assets.sh          # 写 PNG + 桌面图标
```

两条命令都要跑：**只跑第一个**会留下「源图已改、PNG 还是旧的」；**只跑第二个**会拿旧 SVG 重新栅格化。

`render-brand-assets.sh` 支持子命令：`banner` / `architecture` / `icon` / `all`（默认）。

也可用 `npm run brand:svg`（只出 SVG）/ `npm run brand:render`（只出 PNG）。

### 输出尺寸与体积

- **渲染 1x，不渲染 2x**：README 里图片按 `width="100%"` 显示，GitHub 正文约 900px 宽，
  1760px 的位图已经等于 2 倍图。翻到 3520px 只会让首图从 288KB 涨到 845KB，肉眼在 900px
  容器里分辨不出。要印刷版时 `SCALE=2 ./scripts/brand/render-brand-assets.sh`。
- **只量化架构图，不量化首图**：架构图 415KB → 61KB 且肉眼无差别（大面积平色 + 细线）；
  首图量化到 256 色虽然能到 35KB，但右上角的径向辉光会出现抖动噪点与块状边缘。
  `NO_OPTIMIZE=1` 可跳过量化。
- 当前基线：首图各约 290KB（24 位），架构图各约 62KB（256 色）。

### 为什么用无头 Chrome 栅格化

本机 `convert`（ImageMagick）走 MSVG 内部渲染器，对 `letter-spacing`、字体回退
（Lato + Noto Sans CJK SC）、`feDropShadow` 都不能忠实还原，中文会渲染成方框。
Chrome 的排版结果 == 设计器里看到的结果。

### 为什么文字宽度要实测

`build-brand-assets.py` 用 Chrome 的 `getComputedTextLength()` 实测每个字符串的宽度，
再按实测宽度排版（首图的 `AutoCode‖Flow`、能力标签的换行、架构图 chip 的右对齐都依赖它）。
按字数估算会让字标中间裂开一道 90px 的缝、或让标签冲出画布。

没有 Chrome 时脚本会退化成「按字号估算宽度」并在 stderr 告警——**能出图，但排版不保证**，
CI 与正式出图不要走这条路。

## 3. 色板（与代码同源）

`scripts/brand/build-brand-assets.py` 里的 `C` 字典与
`apps/admin-web/src/theme/tokens.ts` 的 `DESIGN_TOKENS` 对齐：

| 角色 | Hex | 出处 |
|---|---|---|
| 强调绿 | `#22C55E` | `tokens.ts` `accent` / `DESIGN_TOKENS.accent` |
| 深色画布 | `#0B1220` | 品牌画布（`tokens.ts` 的 `backgroundDark` #020617 偏亮一档，用于图） |
| 面板 | `#0E1828` | `tokens.ts` `muted` #1A1E2F 的图用变体 |
| 描边 | `#22334D` / `#2E4767` | `tokens.ts` `borderDark` #334155 的图用变体 |
| 正文 | `#F8FAFC` | `tokens.ts` `foregroundOnDark` |

**改色时两边一起改**：`tokens.ts` 改的是 UI，`build-brand-assets.py` 改的是图。

### 一条容易踩的坑：绿色对比度

`#22C55E` 与白色文字的对比度约 2.1:1，**不过 WCAG AA**。
`apps/admin-web` 里的主按钮用的是 `#15803d`（约 4.6:1），由
`apps/admin-web/src/__tests__/primary-button-contrast.ux.test.ts` 双向钉住。

图里不受这条约束（图不是正文，且深色底上的亮绿本身就高对比），
但**不要**把 `#22C55E` 直接当白字底色用。

## 4. 标志的设计约束

标志是 **圆角六边形剪影 + 一处透明挖空的箭头**。它照的是 Docker / GitHub / Firefox /
Clash 那一路「开发者工具图标」的做法：**16px 下只剩一个轮廓和一处镂空**。插画、渐变、
立体、道具在这个尺寸全部消失，只会变成一团脏东西——所以这里只有两个元素，没有第三个。

改标志前先读 `scripts/brand/build-brand-assets.py` 里的 `mark_svg()` 注释，四条硬约束：

| 约束 | 值 | 违反的后果 |
|---|---|---|
| 挖空必须**透明**（mask，不是画一个深色箭头） | — | 否则深底能用、浅底就废，得维护两套文件 |
| 六边形圆角半径 | 4/64 | 太小像螺母，太大像圆点 |
| 箭头笔画 | 7.4/64，圆头圆角 | 低于 6 在 16px 下会断成一串点 |
| 出框留白 | ≥ 6/64 | 任务栏 / 圆形头像 / 浏览器标签会裁到主体 |

语义：**六边形 = 执行器节点 / 蜂巢式编排；箭头 = 派发与执行的方向。**
这两件事正好是本产品区别于「又一个 cron 面板」的地方。

`mark_svg(size, background=False)` 出的是**裸形**（无底板），供浅色底、印刷、水印使用；
默认 `background=True` 出带深色圆角底板的版本，供 favicon 与应用图标使用。

### 试过但不用的方向

这些都在 `git log` 之前的迭代里画过，记下来免得下次再走一遍：

| 方案 | 为什么放弃 |
|---|---|
| 双箭头「≫」 | 少了「节点」，读起来只像快进键；16px 两笔会糊在一起 |
| 河狸 / 机器人 / 章鱼头 | 剪影能立住，但**语义变成「动物/玩具应用」**，和调度器的气质不搭 |
| 六边形 + 字母 A | 太像企业缩写标，且和第 1 个字以外的产品名没有关系 |
| AI 生成角色图 | 缩到 32px 就是一团色块；且模型给的路径无法复现、无法改色 |

## 5. 托盘图标的约定

形状恒定（圆角方块 + 双箭头），**颜色才表示状态**：

| 文件 | 颜色 | 状态 |
|---|---|---|
| `tray-online@2x.png` | 绿 `#22C55E` | 在线 |
| `tray-pending@2x.png` | 黄 `#F59E0B` | 启动中 |
| `tray-offline@2x.png` | 红 `#EF4444` | 离线 |

状态靠颜色区分而不是靠形状变化——形状变了用户会以为是另一个程序。

## 6. 落地副本必须同步

`apps/admin-web/public/acf-mark.svg` 与 `packages/docs-site/public/logo.svg`
是源文件的**逐字节副本**（favicon 与文档站 logo 只能吃静态文件）。
`build-brand-assets.py` 每次都会重写它们，所以「改了源图忘了改线上」不可能发生。
