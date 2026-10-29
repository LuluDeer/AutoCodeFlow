# Executor Desktop — 桌面端设计系统覆盖（apps/executor-desktop）

> 依 MASTER.md 顶部 LOGIC 约定：`pages/[page-name].md` 存在时其规则覆盖 Master。
> **本文件覆盖 MASTER.md 中与桌面端冲突的深色规则**（深底 `#020617`、CTA `#22C55E`、
> Google Fonts 在线引入等）；桌面端冲突处以本文件为准，其余沿用 Master。
>
> 取值实读基线：`apps/executor-desktop/src/renderer/styles/`（tokens/base/components/pages
> 四文件）与 `apps/executor-desktop/src/main/window-manager.ts`（V4-1 后实读，非转抄）。

## 1. 适用范围与文件现状

- 适用 `apps/executor-desktop` 渲染层（`src/renderer/styles/`）。
- 样式载体：tokens / base / components / pages 四文件；令牌值以 tokens.css 为载体。
- V4（2026-10-05，`docs/archive/audits/ux-v4-audit-redesign-2026-10-05.md`）新增：内嵌品牌字体、
  共享 ConfirmBar / EmptyState / LogLineList 组件、顶栏合并、collapsible 过渡——
  详见 §4/§6/§8。

## 2. 设计语言：明亮专业风（Quiet Precision）

浅灰画布 + 白色卡片 + 发丝描边 + 浅阴影 + 克制的品牌绿；工具型桌面应用的清晰与
克制优先于装饰（与 Master 的深色 IoT 仪表盘语言相反）。

- 层级靠「灰底白卡 + 发丝描边 + 浅阴影」表达，**不用发光与渐变堆砌**
  （V4 已收口最后的两处光环：cfg-nav-dirty / agent-status-dot）；
- 品牌绿只用于主 CTA 文字底与正向状态，不做大面积铺色；
- **标识态不占用状态色**（V4-1）：「当前生效」类标识用中性蓝灰标签
  （`.app-badge-current` = surface-2 底 / text2 字 / strong 描边），绿色只归结果态；
- 语义状态一律「深字 + 低饱和浅底 + 半透明描边」，保证浅色系 AA 对比。

## 3. 色彩令牌（:root 实读）

### 基础面 / 描边

| 角色 | 令牌 | 值 |
|------|------|-----|
| 画布 / 应用底色 | `--bg`（=`--color-background`） | `#f5f6f8` |
| 白卡 surface | `--surface-0`（`--surface-1` 同值沿用） | `#ffffff` |
| hover / 次级抬升 | `--surface-2` | `#f0f2f6` |
| active / 分段选中 | `--surface-3` | `#e8ebf1` |
| 发丝线 | `--border` | `#e6e9ef` |
| 强描边（输入框、分段控件） | `--border-strong` | `#d4d9e2` |
| 日志内衬（白卡上的浅灰终端区） | `--log-bg` | `#f7f8fa` |

### 文本

| 角色 | 令牌 | 值 |
|------|------|-----|
| 正文 | `--text`（=`--color-foreground`） | `#1a2230` |
| 次级 | `--text2` | `#414c5e` |
| 次级文本（灰画布上 4.78:1 过 AA） | `--text3` | `#616e83` |
| 装饰性填充（状态点/图标，2.58:1 禁用于正文） | `--text4` | `#98a2b3` |

### 品牌绿与语义色

| 角色 | 令牌 | 值 |
|------|------|-----|
| 品牌绿（主 CTA 底、正向、focus ring） | `--color-primary` / `--accent` / `--color-ring` | `#15803d` |
| 品牌绿 hover | `--accent-hover` | `#166531` |
| 状态绿 | `--green` | `#16a34a` |
| 红 | `--red`（深字/hover 用 `#b91c1c`） | `#dc2626` |
| 琥珀 | `--yellow`（深字用 `#b45309`） | `#d97706` |
| 蓝 | `--blue`（深字用 `#1d4ed8`） | `#2563eb` |
| 紫 | `--purple`（深字用 `#7e22ce`） | `#9333ea` |

每个语义色带 `*-bg`（约 8%~10% 透明底）与 `*-border`（约 30%~35% 透明描边）变体。

**状态色唯一映射**（V4 重申）：运行中=蓝、成功/在线=绿、失败/离线=红、启动/等待=琥珀
（呼吸动效仅此一档，全端 1.2s）、停止/未启用=灰。徽章只准查既有变体，不得新造同义色。

**DOC-01 对比度结论（覆盖 MASTER 的 Accent/CTA `#22C55E`）**：`#22C55E` 配白字对比度
约 2.1:1，不过 WCAG AA，弃用；桌面端主 CTA 用 `#15803d`（白字约 4.6:1 达标）。

## 4. 字体（V4-1 起内嵌生效）

品牌字体已内嵌 latin 子集 woff2（`src/renderer/fonts/`，vite 打包进产物，
`font-src 'self'` 直接合法；SIL OFL，`fonts/LICENSE.txt` 随分发）：

- `--font-body`：**Fira Sans**（400/600/700 已内嵌）→ Segoe UI / system-ui / 微软雅黑
  等系统回落（中文始终走回落链）；
- `--font-mono`：Cascadia Code（Win11 自带）→ **Fira Code**（400/500 已内嵌，可变字体
  单文件）→ Consolas 等等宽回落；
- 新增字重必须同步补充 woff2 并保持 SIL OFL 许可文件；禁止引入在线字体（CSP 红线）。

## 5. 版式与层级

- **字号阶梯**（唯一允许的字号取值，新样式禁止裸 px 字号）：
  11 / 12 / 13 / 14 / 16 / 20 / 24（`--fs-xs/sm/base/md/lg/xl/2xl`）。
- **间距**：走 `--space-*` 数字刻度 4 / 8 / 12 / 16 / 24 / 32；禁止随手写 px。
- **圆角**：`--radius-xs..2xl` = 4 / 6 / 8 / 10 / 12 / 16 / 20。
- **阴影**：浅色系低透明度大模糊柔和投影，`--shadow-xs/sm/md/lg/xl` 逐级抬升。
- **动效**：颜色过渡用 standard 贝塞尔；入场/位移用 `--ease-out` decel 曲线；
  浮现类统一 `--anim-in`（200ms）；展开/收起走 `.collapsible` 结构级过渡
  （grid-template-rows 0fr→1fr，220ms，内容常驻挂载 + 收起态 inert）；
  全局受 `prefers-reduced-motion` 收口。
- **顶栏（V4-1）**：`.topbar` 单行（≥900px：brand + tabs + 窗控同排，48px）；
  <900px 折行回两行。拖拽区 = brand 与 tabs 容器空白；双击空白最大化
  （命中按钮不触发）。**拖拽区内的一切可交互元素必须显式
  `-webkit-app-region: no-drag`**（`.tab`、`.titlebar-btn` 均有）——否则真实
  鼠标点击被窗口拖拽吞掉；Playwright 合成点击不经过 OS 的 app-region 命中
  测试，此类缺陷 e2e 抓不到，改动后必须真机验证。

## 6. 组件清单（已实装，简表）

| 组件 | 变体 / 说明 |
|------|------|
| `.btn` | 默认描边钮；`btn-primary` / `btn-success`（#15803d 实底白字）；`btn-danger`；`btn-danger-ghost`（含 `btn-outline-danger`）；尺寸 `btn-sm` / `btn-lg` |
| `.badge` | `badge-success` / `badge-blue`（运行中）/ `badge-pending`（等待，呼吸动效）/ `badge-error` / `badge-offline` / `badge-stopped` |
| `.app-badge` | 应用行内徽标：`app-badge-current`（**中性标识**，V4-1 去 绿）/ `app-badge-running`（蓝+呼吸）/ `app-badge-scheduled`（dashed 中性，V4-5） |
| `.input` | 默认描边；focus 绿环；`.error` 红态 |
| `.toggle` | `toggle-row` + track/thumb，选中态 `--green`；即时生效项加 `.cfg-inline-tag` |
| `.info-banner` | 默认蓝（中性提示）；`.warn` 琥珀；`.danger` 红 |
| `.confirm-bar`（V4-4） | 共享 ConfirmBar：`danger`（红，破坏性）/ `impact`（琥珀，高影响）；主钮统一 autoFocus、Esc=取消、焦点归还 |
| `.empty-state`（V4-5） | 空态家族（EmptyState 组件，page 档）：虚线框 + 48px 灰图标底板 + 标题/说明/行动区 |
| `.collapsible`（V4-5） | 结构级展开过渡：`[data-open]` 驱动 0fr→1fr；内容常驻挂载，收起态 `inert` |
| `.cfg-guide-card`（V4-3） | 配置页右栏引导卡（三步/三行式，无警示色） |
| `.log-viewer` / `.log-fullscreen` | 浅灰终端内衬；行渲染收口 `LogLineList`（trace 块合并、到达动效、行内复制/打开文件）；INFO 级别无底色降噪（V4-2） |
| `.topbar` / `.tabs` | 合并单行顶栏（V4-1）；Tab 导航（active 绿下划线生长动效） |

## 7. 窗口红线（主进程侧，渲染层无法自查）

`BrowserWindow.backgroundColor` 必须等于 `--bg` **`#f5f6f8`**（window-manager.ts 的
status / wizard 两窗均已对齐）。教训：frameless + transparent 在部分 Windows 机器上
整窗复合失败（WIN-DISPLAY / 1.4.3 Hotfix），改实心底色后，窗口底色与 CSS `--bg`
不一致又会出现底色割裂/闪色——两者必须逐字相等。**V4 未触碰该值。**

## 8. 演进状态

- 2026-10 v3：令牌翻转、四文件拆分、日志工作台三合一、信息架构重组（详见
  `docs/archive/audits/ux-audit-desktop-2026-10-05.md`）；
- 2026-10 V4（`docs/archive/audits/ux-v4-audit-redesign-2026-10-05.md`，当日全五期落地）：内嵌品牌字体、
  状态色语义修正（标识态中性化）、顶栏合并（90px→48px）、Tab 按频率重排
  （状态→历史→应用→配置）、日志渲染管线归一（LogLineList：预览/全屏同管线 +
  INFO 降噪 + 行内工具）、状态页活动条「运行中任务」可见化 + 右栏「最近失败」、
  配置页宽屏双栏（cfg-main/cfg-aside，≥1400px）+ 引导卡、ConfirmBar 五处收口、
  配置改动清单/放弃修改、展开高度过渡、空态家族、门面四件入 shell.* 双语键；
- 2026-10-27 V5 第一版（Config / Apps 重做，未发布）：
  - 配置页从“字段清单”改为“设置工作台”：左栏 176px（英文 208px）+ 单行分组导航
    （基础 / 运行时 / 系统）+ 设置搜索；内容区连续面板 + 180px 标签列的设置行
    （`components/SettingRow.tsx`），控件列自适应、输入框封顶 560px；右栏
    「当前生效」显示连接状态/平台地址/对外地址/并发/Agent 档位/重启提示；
    Agent 权限矩阵改为纵向「本地设置 / 当前生效」两行式，避免 310px 右栏三列挤压；
    新增 URL/端口/密钥/域名失焦校验（只提示，不改 clamp/save 语义）。
  - 应用页从“卡片墙”改为“运行台账”：≥1100px 表格视图（应用/当前版本/版本数/
    运行状态/最近部署/日志/操作），<1100px 紧凑列表（60px 两行，无内联展开）；
    两者点击同一右侧详情抽屉（版本列表、危险操作）；**卡片视图与内联展开已移除**
    （量化审计：卡片 83 描边/26 阴影 vs 表格 27/20；折叠卡 163 字符/39 叶子 vs
    紧凑行 39 字符/11 叶子）。筛选扩为全部/运行中/有当前版本/无当前版本/名称未知/
    有日志，排序扩为最近部署/名称/版本数/运行中优先；头像按 appId 哈希到 6 组
    低饱和色；无当前版本/无日志在表格中显示为 `—`（title 保留完整文案）。
    抽屉内发起的删除/卸载确认条渲染在抽屉 body 顶部（避免被 fixed 抽屉盖住）；
    日志查看器打开时 Esc 只关查看器，不连带关闭抽屉。
  - 历史页从“双列任务分组卡片 + 内联展开”改为“执行台账”：单列按开始时间倒序，
    吸顶日期桶（今天/昨天/近 7 天/更早）；每行 52–56px，状态 + 任务名 + 开始时间
    + 时长 + 一行失败摘要 + 日志/定位；执行 ID 收进详情（不再占行宽）；任务改为
    顶部筛选 select，不再作为页面骨架。≥1400px 右侧 400px 详情面板，<1400px 为
    抽屉，<900px 为整宽详情页；详情含开始/结束/时长/退出码/完整 ID 复制/完整错误/
    日志/定位/导出/同任务最近 5 次。首次加载宽屏自动选中最近一条，窄窗不自动
    打开抽屉。量化：描边 166→88，默认态从 9 张组卡 + 456 叶子改为单列台账 +
    详情面板；触控目标/截断/横向溢出 0。
  - 样式载体：`styles/pages/config-v5.css`、`apps-v5.css`、`history-v5.css`，由
    `main.tsx` 在 `pages.css` 之后导入；新类名统一 `cfgx-` / `appx-` / `historyx-`
    前缀，遗留 `.cfg-*` / `.app-*` / `.history-*` 类名保留给 e2e 与未迁移区域。
  - 纯函数：`apps-view.ts`（筛选、排序、头像色相）；新增词条统一
    `cfgx.*` / `appx.*` / `historyx.*`，与既有双语表同表对齐。
- 本文记录的令牌现值为桌面端事实源；修改样式须同步更新本文。

## 9. UI 量化审计（`npm run audit:metrics`）

截图只能判断“有没有明显坏掉”，判断不了“松不松、挤不挤、对齐不对齐”。桌面端
内置一套基于真实渲染 DOM 的量化探针（`e2e/ui-metrics.cjs`，输出到
`e2e/.metrics/`）：

- `metrics.json` / `metrics.txt`：每个页面 × 尺寸一行的结构化指标；
- `*-overlay.png`：8px 网格 + 关键容器描边，肉眼核对边界与内容填充。

指标口径与建议阈值：

| 指标 | 含义 | 建议 |
|------|------|------|
| `coverage` | 内容区域 8px 网格被“有文字/控件/底色/描边”的叶子节点覆盖的比例 | 设置页 35–60%；表格 >50% |
| `rightVoid` / `bottomVoid` | 区域边缘到内容联合包围盒的空隙 | 两者都不应 >80px（除短页自然留白） |
| `controlFill` | 配置页每行「输入控件宽度 / 控件列宽度」 | ≥0.8（≥0.9 更佳）；低于 0.8 说明右侧空 |
| `rowGaps` | 标签右缘到控件左缘的间距 | 全页同一值（当前 16px） |
| `density` | 每 10 万 CSS px² 的字符数 / 叶子节点数 | 设置页 40–120 字符；表格 60–150 |
| `typography.distinctSizes` | 可见文本字号种类 | 同一视口 ≤4 |
| `boundaries.maxBorderDepth` | 描边/阴影祖先最大嵌套层数 | ≤3；>3 检查卡片套卡片 |
| `alignment.offGrid` | 高频左边缘中不在 4px 网格上的数量 | ≤4 |
| `truncated` | 无省略号的文本裁切 | 0 |
| `lowContrast` | 文本与合成后背景对比度 <4.5 | 0（半透明底色已做 alpha 合成） |

使用方式：改动前先跑一次留基线，改完再跑，对比同一 `label` 的数字；
`*-overlay.png` 与截图一起看，避免只靠肉眼。
