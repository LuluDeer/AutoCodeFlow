# 桌面客户端 UI v4 审计与升级改造方案（2026-10-05，全新独立轮）

> 审计对象：`apps/executor-desktop` **v3 终验后的当前工作区态**（今日 R1–R5 全绿落地的未提交代码）。
> 审计范围：主窗四 Tab（状态/配置/历史/应用）、全屏日志查看器 ×3、向导、titlebar/Tab 壳层、
> 系统托盘、系统通知、更新横幅、ErrorBoundary、窄窗（800×720）与宽屏（2000px）双通道。
> 审计方法：渲染层全量源码精读（App/5 页/7 组件/四样式文件/i18n ≈5,800 行 + 样式 ≈3,100 行）
> + 主进程 UI 面（window-manager/tray/notifier/ipc-handlers/index）
> + `e2e/.screenshots/` 21 张 v3 终验实拍逐页目验（含窄窗通道）。
> 与前轮关系：**全新独立轮，不受 v3 方案与既定取舍约束**。v3 已解决项不再列入；
> v3 落地后新引入/仍残留的问题全部重新取证。上轮明确搁置、本轮按更高标准重启的项
> （字体、ConfirmBar、高度过渡、Agent 引导卡）标注「v3 遗留」并给出本轮结论。
> 本文是**升级方案**，不含代码改动。

---

## 0. 总评

v3 之后，桌面端处在「**干净但普通**」的水平：令牌体系、无障碍、失败显性化、日志三查看器合一
这些工程底座已经是同类 Electron 工具里的上游水平；逐张过图也没有明显破相的页面。
距离「高级质感」的差距不再是某个 bug，而是四件**结构性的事**：

1. **产品主对象缺位**：执行器在线时，四个页面没有一处能看到「现在正在跑什么任务、跑了多久」
   ——一个监控工具看不见自己的监控对象，这是 v4 最大的单项缺口；
2. **日志阅读器只合一了壳，没合一渲染**：trace 合并、到达动效、级别降噪三项核心阅读能力
   三个入口只覆盖了一个（详见 V-05/M-01），「同一对象一种渲染」的原则没有贯穿；
3. **视觉人格未建立**：品牌字体仍未内嵌（v3 遗留未做），整窗仍是系统默认字的「表单感」；
   「当前版本」冒用成功绿、胶囊嵌胶囊、原生 details 三角这些细节暴露出「统一」尚未完成到细节层；
4. **规范欠账到了必须组件化的时候**：五处确认条细节各异且 autoFocus 规则相反，
   配置页改了什么不可见、放弃修改不存在——再攒下去每次改页面都要重对一遍规范。

v4 主线：**「运行中任务」可见化 + 日志渲染管线归一 + 视觉人格（字体/状态色/层级）落地 +
交互规范组件化收口**。总量与 v3 相当，但每一项都是结构级，不是继续小修。

---

## 1. 审计问题清单

> 严重度：P0 = 影响核心任务完成 / 明显质感损伤；P1 = 高频摩擦或认知负担；P2 = 打磨项。
> 证据：源码 `file:line`（均为当前工作区态）或截图编号（`e2e/.screenshots/`）。

### 1.1 视觉质感

| # | 级 | 问题 | 证据 |
|---|----|------|------|
| V-01 | P0 | **品牌字体缺位（v3 遗留，本轮必做）**：`--font-body` 首选 Fira Sans 但安装包未内嵌、CSP 又禁在线字体（`font-src 'self' data:` 其实允许内嵌）——实际整窗渲染 Segoe UI/雅黑，数字走 Consolas。全部截图可证。这是「高级质感」与「系统表单感」的最大单项差 | `tokens.css:102-110`；`index.html` CSP；截图 01–23 |
| V-02 | P0 | **配置页宽屏右半空转**：表单限宽 980px 且左对齐，2000px 窗口下右侧 ~55% 全灰；五个分区页全部如此（连接页尤其空）。v3 的「宽屏不空转」原则只落了历史/应用，配置页被漏掉 | `pages.css:1203-1209`；截图 04/05/06/07/08 |
| V-03 | P1 | **顶部 chrome 双层条吃掉 90px**：titlebar 44px + tabs 46px 两层横条，且拖拽区/品牌区/导航区分裂在两层。日志工作台的每一像素纵向都宝贵，宽屏下两条浅灰白横叠观感松散 | `base.css:105-235`；截图 02 |
| V-04 | P1 | **日志行前导噪声第二轮**：级别徽章 min-width 44px 带底色，400 行 INFO 形成整屏「蓝色斑马墙」，级别视觉权重压过正文；行号 56 + 时间 96 + 级别 44 的固定前导 ~200px，2000px 宽下正文仍只占一半 | `components.css:417-432`；截图 03 |
| V-05 | P1 | **trace 合并未覆盖状态页预览**：共享 LogViewer 有 trace 块合并，但状态页预览直接 `<FormattedLogText text={line.text} />` 不传 hideTrace/无块首 chip——预览里 `[23fb6898]` 逐行重复（406 行同 trace），与全屏查看器同一数据两种渲染 | `StatusWindow.tsx:763` vs `LogViewer.tsx:326-349`；截图 02 |
| V-06 | P1 | **「当前版本」冒用成功绿**：`app-badge-current` 绿底绿字绿点系，与「成功/在线」正向态同色——「当前生效」是标识态不是结果态，状态色语义表被污染 | `pages.css:1049`；截图 13 |
| V-07 | P1 | **层级语言未压缩**：白卡+边框+阴影三件套逐卡叠加（历史组头内统计再嵌一层 border+bg+999 胶囊，视觉重过任务名）；`cfg-nav-dirty` 与 `agent-status-dot` 的 3-4px 光环是「无发光」基线的两处漏网 | `pages.css:647,1196,1363`；截图 09 |
| V-08 | P2 | **原生 details marker 未定制**：配置页「详情」折叠用浏览器默认实心三角，绿色小字+黑三角观感粗糙、平台渲染不一 | `pages.css:1249-1257`；截图 07 |
| V-09 | P2 | **空态三个物种**：列表空态 48px 灰图块、向导欢迎页绿卡 hero、日志行内小字空态——同是「没有内容」三种视觉语言 | `pages.css:731-766,1490-1515`；`components.css:437-450` |
| V-10 | P2 | **中西文混排无规范**：全角/半角括号（「Agent（实验性）」vs「Agent (实验性)」式混用）、`v1.4.3` 与中文间距、`·` 与 `/` 分隔符密度不一 | i18n 表 + 各页硬编码文案；截图多处 |

### 1.2 信息架构

| # | 级 | 问题 | 证据 |
|---|----|------|------|
| I-01 | P0 | **「运行中任务」全域不可见**：执行器在线时正在执行哪些任务、各跑了多久，四个页面都看不到。状态页只有「运行中 1」计数（今日概览条），历史页要先知道任务名再展开找。监控工具看不见监控对象，用户排障第一步就被卡住 | `StatusWindow.tsx:330-340`（running 仅用于计数/停机确认）；截图 02 |
| I-02 | P1 | **Tab 顺序与使用频率倒挂**：低频的「配置」占第二位（Ctrl+2），排障主路径「历史/应用」在 3/4。使用频率应是 状态 > 历史 > 应用 > 配置 | `App.tsx:12`（TAB_ORDER）；截图 02 |
| I-03 | P1 | **状态页右栏价值密度低**：连接三项与配置页完全重复、日志文件卡与全屏查看器侧栏重复；窄窗 <1100px 时右栏拆卡**插到日志上方**（order:-1），日志——监控工具的主角——反而被推到视口外 | `pages.css:1616-1637`；截图 02/21 |
| I-04 | P1 | **「关于与更新」分区混装三种心智、两种保存契约无标注**：日志级别/通知开关走「保存」，开机自启走独立 IPC **即时生效**，同屏三种开关行为不同且无视觉区分；未保存圆点只覆盖入表字段 | `ConfigPage.tsx:101-107,241-252,900-929` |
| I-05 | P1 | **历史组折叠头不透出失败原因**：排障主场景「哪次失败、为什么」必须展开才见 errorMessage；折叠头只有「N 失败」计数。失败组应在折叠态就有一行错误摘要 | `HistoryPage.tsx:604-612,652`；截图 09 |
| I-06 | P2 | **应用列表不预告「为什么没有应用日志」**：scheduled 模式与未常驻运行两种原因要等点进查看器空态才区分；版本行的虚线「执行日志」钮两种场景同款，困惑前置不可免 | `AppsPage.tsx:206-232,678-689`；截图 16 |
| I-07 | P2 | **双语剪刀差持续扩大**：配置页全双语，其余四页+向导+titlebar 硬编码中文；v3 新组件键已入表但页面骨架未迁。英文系统用户仍是「托盘英文+界面中文」 | `i18n.ts:20-21`；各页源码 |

### 1.3 交互流程

| # | 级 | 问题 | 证据 |
|---|----|------|------|
| X-01 | P0 | **五处确认条细节各异、autoFocus 规则相反（v3 欠账组件化）**：停机确认 autoFocus 在危险主钮「确认停止」，应用卸载确认 autoFocus 却在「取消」——同类 alertdialog 默认焦点相反，键盘用户一次 Enter 一个直接执行危险动作、另一个取消；Esc 一处明示不绑定；ConfirmBar 组件化是 v3 STATE 明确遗留项 | `StatusWindow.tsx:687` vs `AppsPage.tsx:653`；`HistoryPage.tsx:478-489`；STATE 偏差 1 |
| X-02 | P1 | **配置页无「改动清单」与「放弃修改」**：isDirty 只有 footer 一行字+nav 圆点，改了哪些字段、旧值→新值不可见；想反悔只能逐字段手改回原值。「查看更改」与「放弃」是配置类工具的标配 | `ConfigPage.tsx:234-239,976-985` |
| X-03 | P1 | **日志查看器是死端**：看到错误行后无「打开日志文件/复制该行/查看该任务其他执行」任何后续动线；历史查看器只绑单条记录，排障要在列表↔查看器间反复横跳重进 | `HistoryPage.tsx:168-251`；`LogViewer.tsx:232-372`（无文件/邻次入口） |
| X-04 | P1 | **失败通知信息量仍薄**：正文只有任务名+耗时，无退出码/失败阶段；用户从通知到「知道为什么失败」至少三次跳转。meta 已有 exitCode（纯数字，属 notifier-rules 安全白名单口径） | `notifier.ts:206-214`；`notifier-rules.ts` 白名单 |
| X-05 | P2 | **列表页搜索无快捷键**：查看器有 Ctrl+F，历史/应用页搜索框无任何快捷键——同一「搜索」动作两种口径 | `App.tsx:176-186`（仅 Ctrl+1..4）；`LogViewer.tsx:212-221` |
| X-06 | P2 | **「清空显示」易误读且不可逆**：状态页与「查看日志/底部」并排，点击即清当前显示（有 title 说明但钮面无），新用户会误读为删日志文件 | `StatusWindow.tsx:742`；截图 02 |

### 1.4 操作引导

| # | 级 | 问题 | 证据 |
|---|----|------|------|
| G-01 | P1 | **Agent 配置页术语墙仍在（v3 规划未落地）**：subtitle 一句 60+ 字含 4 个概念；权限档位选项主文案是内部枚举名（「minimal——什么都不做（Agent 仅辅助，高合规）」）。v3 §2.4 规划的「这是什么/开启后会发生什么/如何收紧」引导卡在 STATE 无落地记录 | `ConfigPage.tsx:726-744,770-777`；截图 07 |
| G-02 | P1 | **应用页空态行动出口错位**：无应用时主按钮是「立即刷新」——刷新解决不了「没有应用」，真正下一步在管理后台；空态文案说了后台却无可操作的说明出口 | `AppsPage.tsx:521-531`；截图 12 |
| G-03 | P2 | **stopped+未配置的启动失败无前置引导**：从未配置时点「启动执行器」必然失败，错误条给原因不给路径；`adminApiUrl` 为空的 stopped 态可把主钮变「先完成配置」 | `StatusWindow.tsx:492-505,657-672` |
| G-04 | P2 | **关窗语义文案不精确**：close-tip 说「窗口已最小化到托盘」，实际主窗 X 是 `win.close()` 销毁+应用驻留（无 hide 拦截），下次打开是重建。「最小化」与「关闭但驻留」是两种心智，首次教育文案应说准 | `App.tsx:280`；`ipc-handlers.ts:1001-1004`；`index.ts:79` |

### 1.5 动效体验

| # | 级 | 问题 | 证据 |
|---|----|------|------|
| M-01 | P1 | **到达动效三个入口只覆盖一个**：`arriveAnimation` 仅应用页查看器传入；历史查看器 running 1.5s 轮询新行无到达感；状态页预览区也没有。E-02 实际只做了 1/3，三查看器行为再次分叉 | `AppsPage.tsx:191`（唯一传入点）；`HistoryPage.tsx:226-249`；`StatusWindow.tsx:762-764` |
| M-02 | P1 | **展开/收起高度跳变（v3 遗留）**：history-runs 与 app-group-details 是条件渲染+runsIn 淡入，容器高度瞬跳；宽屏多组同屏时布局抖动明显。v3 以「风险/收益不划算」搁置——本轮给出低风险实现路径后应重启 | `pages.css:653,969`；`HistoryPage.tsx:616-665`；`AppsPage.tsx:609-718` |
| M-03 | P2 | **状态翻转仍靠颜色过渡**：hero 图块/边框/徽章颜色 transition 已有，但状态大字与描述文本是硬替换；v3 §2.6 规划的 crossfade 未落地 | `StatusWindow.tsx:645-648`；`pages.css:96-105` |
| M-04 | — | **已达标不动**：入场体系（panelIn/overlayIn/runsIn/slideUp）、`--anim-in` 统一、pulse 全端 1.2s、reduced-motion 全局收口、按钮 active 位移克制——v4 全部保持 | `base.css:251-296`；`tokens.css:158-170` |

---

## 2. v4 设计方案（「任务运行台」）

### 2.1 设计原则（追加第 6 条，其余沿用 v3 五条）

1. 一页一主对象（状态=运行实况、历史=执行时间线、应用=版本资产、配置=表单）；
2. 一种概念一个颜色——**新增：标识态不占用状态色**（「当前生效」用中性蓝灰，绿色只归结果态）；
3. 宽屏不空转——**本轮补齐配置页**；
4. 渐进披露（默认路径只给能直接用的默认值）；
5. 动效只表达因果（入场一次、状态变化过渡、增量有到达感）；
6. **同一对象一种渲染（v4 新增总纲）**：日志行无论出现在预览/全屏/任何入口都走同一条渲染
   管线；确认条全端一个组件；空态一个家族。凡同类元素出现第三处仍手写，即视为违规。

### 2.2 S1 视觉基底「Quiet Precision」

- **内嵌品牌字体（V-01 终结项）**：`assets/fonts/` 内嵌 Fira Sans woff2（400/600/700，
  Latin subset，SIL OFL 许可允许内嵌分发）+ Fira Code（400/500，日志与代码场景），
  共 ~350KB 预算；`@font-face` 走本地资产，CSP `font-src 'self'` 直接合法；
  中文回落系统（Segoe UI/雅黑）不变。字阶/行高不动——只换字体不动版式，回归面最小。
- **状态色映射表组件化**：新增 TS 常量 `STATUS_SEMANTICS`（status→badge 变体+文案），
  各页徽章只准查表；`app-badge-current` 改中性变体 `badge-neutral`（蓝灰底/描边，无绿），
  「当前 v1.4.3」与「成功」从此在 3 米外可区分。
- **层级压缩**：历史日期桶内的组卡共享一张卡壳（桶内分隔线替代逐卡边框）；
  组头统计拆掉嵌套胶囊（`history-stat-summary` 的 border+bg+999 圆角），改「2 成功 · 1 失败 · 3 次」
  纯文字+语义色点；`cfg-nav-dirty`/`agent-status-dot` 去光环改实心点。
- **details marker 自定义**：summary 前置 12px chevron svg（展开 90° 旋转），全端一处样式。
- **顶部 chrome 合并（V-03）**：≥900px 时 titlebar 与 tabs 合并为一行——
  左 brand mark+标题（拖拽）、中段空白（拖拽）、tabs 居左中段、右窗控三钮；
  纵向 90px→48px，全部让给日志工作区。<900px（含窄窗通道）保持两行不动。
  双击中段空白最大化行为保留（Windows 惯例）。
- **空态家族（V-09）**：一个 `EmptyState` 组件三档尺寸（page/panel/inline），列表空态、
  日志空态、配置无诊断统一换装；图标底板、字号、行动钮位置一份规范。
- **混排规范（V-10）**：写进 CSS 头注释的三条铁律——中文语境半角括号内不加空格、
  版本号/端口等西文 token 与中文之间加 0.25em 间距（CSS `letter-spacing` 不可行，文案层用
  细空格或直接靠字体度量）、分隔符统一 `·`。随 S4 文案过一遍统一。

### 2.3 S2 日志阅读器 2.0——渲染管线归一（本方案最大抓手）

**抽 `LogLineList` 共享渲染层**（LogViewer 内部 + StatusWindow 预览共用）：
行渲染、trace 块合并（块首 chip + hideTrace）、到达动效（首屏不闪机制随组件走）、
窗口化加载更早。预览与全屏从「两个渲染路径」变成「一个渲染路径 + 两种容器」。

- V-05 终结：状态页预览自动获得 trace 合并；
- M-01 终结：预览与历史查看器开启 `arriveAnimation`（历史页 running 轮询 1.5s 有新行即闪绿底淡出）；
- V-04 降噪：INFO 徽章**去底色**（text3 纯文字），WARN/ERROR 保留浅底徽章；级别列
  44→36px；时间列 11px。三档级别的视觉权重第一次与发生频率成正比；
- 行级动线（X-03 一半）：日志行 hover 浮现行内「复制」钮；error/warn 行 hover 浮现
  「打开文件」（状态页=打开 today log，应用页=打开 app.log，历史页=定位该次执行）。

**查看器出口动线（X-03 另一半）**：
- 历史查看器顶栏加「上一执行 / 下一执行」切换（同 taskId 邻次，getHistory 数据已在内存），
  切换时行缓冲重建、title 徽章联动——排障不再回列表横跳；
- 查看器工具行尾部补「打开日志文件」（历史=revealExecLog、应用=openAppFolder、
  状态=openLogFile），与文件侧栏入口同源。

实现红线（对齐 v3 R2 教训）：**两步走**——第一步 LogLineList 原样迁移（行为零变化、
写实夹具回归通过），第二步才做降噪与动线。双时间戳合并/级别判定/CRLF/增量游标的
既有正确性投资不许在抽取中稀释。

### 2.4 S3 状态页「任务运行台」改造（I-01/I-03）

```
┌ hero（状态变体，现状保留）───────────────────────────────────┐
├ 活动条（today-summary 升级）：
│   今日 9 次执行 · 成功 6 · 失败 2 · 最近失败 03:37
│   ▶ 运行中：每日报表生成（已运行 12m）· 库存备份校验（已运行 2h）+1   │
│   ——右侧运行中区为本条新增段；数据源 getHistory 的 running 记录，
│      startTime 缺失时只显任务名不带时长；无运行中时此段不渲染。      │
│      整条仍是一个 button → 历史页（带 running 过滤语义）。          │
├ 主体双栏（现状保留）：左日志工作区吃满剩余高度                      │
│   右栏 320px：Agent 托管 → 日志文件 → 最近失败（新增，Top3，        │
│   行=时间+任务名一行截断，点击进历史并按 failed 过滤）              │
└──────────────────────────────────────────────────────────────┘
```

- 右栏「连接信息」降级为标题下一行摘要（平台地址+端口，复制保留），不再独占一卡——
  与配置页重复的三行是低频信息，不配常驻卡位；
- 窄窗（<1100px）右栏卡片移到日志区**下方**（删 `order:-1`），日志优先级高于连接信息；
- 「最近失败」与活动条共用 `allRecords` 派生，无新 IPC、无二次轮询。

### 2.5 S4 交互规范收口

- **ConfirmBar 共享组件（X-01 终结项，v3 欠账）**：`variant: 'danger' | 'impact'` 两变体；
  统一结构（strong 标题+说明+右置按钮组）、autoFocus 一律**危险主钮**、Esc=取消、
  Enter=主钮、入场 `fadeIn var(--anim-in)`；五处（清历史/停机/卸载/删版本/保存影响）
  全部换装，停机确认补 Esc。组件 props 即规范，第五处再写裸确认条即为违规。
- **配置页改动可视化（X-02）**：footer「未保存」行升级为可点开的**改动清单**
  （字段名 + 旧值→新值，数据 diff 自 `form/savedForm`，敏感字段掩码规则与 getAllMasked
  同口径）；旁加「放弃修改」（回滚 form→savedForm，dirty 圆点联动清空）。
- **即时生效标注（I-04）**：autolaunch 开关行加「即时生效」micro-tag（11px 中性 chip），
  需保存字段不标注——两种契约第一次在界面上可区分；「关于与更新」分区名不改，
  内部把「偏好（自启/通知）」与「运维（日志级别/检查更新）」拆成两个组卡。
- **搜索快捷键（X-05）**：历史/应用页 Ctrl+F 聚焦本页搜索框（查看器打开时优先查看器，
  事件冒泡顺序天然保证——查看器的 handler 在 document 上 preventDefault 即可）。
- **清空显示（X-06）**：从页面工具行移除，能力并入全屏查看器工具行（「清空显示」本是
  查看器级能力）；页面级只留「查看日志 / 底部」。
- **托盘菜单补「打开应用」**（X-04 顺带）：菜单已覆盖状态/配置/历史，补齐第四 Tab；
- **通知补退出码（X-04）**：failed 且 exitCode 有值时正文追加「退出码 {N}」——
  纯数字，符合 notifier-rules 白名单口径；notifier-rules selftest 同步一例。

### 2.6 S5 信息架构微调

- **Tab 重排（I-02）**：TAB_ORDER 改为 `status → history → apps → config`；
  Ctrl+1..4 与 roving tabindex 事实源同数组自动跟随；localStorage 持久化的是 tab key
  非 index，旧值无损。**不改 Tab 名**（「状态监控/配置/历史/应用」文案与 e2e 断言解耦保留）。
- **历史组头失败摘要（I-05）**：`failCount>0` 时组头下方渲染最近一条 failed 记录的
  errorMessage 一行截断（红字 11px，title 全文）——「哪次失败为什么」折叠态即答；
  数据已全部在 `group.runs`，零 IPC。
- **scheduled 前置预告（I-06）**：应用组头在 `runMode==='scheduled'` 时加「定时」
  chip（数据在 `entry.runMode`），版本行虚线钮文案同步「执行日志（定时应用）」——
  空态教育从点进后前移到列表层。
- **双语剪刀差（I-07）**：本轮把「门面四件」入 CFG_TEXTS——Tab 标题、titlebar 品牌/ edition、
  向导步骤名、四页 PageHeader 标题（量 <40 键，暴露面最大）；正文迁移仍列二期。

### 2.7 S6 动效

- **展开高度过渡（M-02 重启）**：展开区改**常驻挂载 + hidden + `grid-template-rows: 0fr→1fr`**
  过渡（220ms `--ease-out`）。两个展开区（history-runs / app-group-details）内部均无
  轮询/IPC effect，常驻挂载无副作用成本；AppsPage 依赖 `MutationObserver(panel hidden)`
  的页面级刷新机制不受影响（那是 tab 级架构 F-21，页内展开区常驻不触碰）。收起方向
  对称过渡；reduced-motion 自动收口。
- **状态大字 crossfade（M-03）**：hero 状态大字/描述在 status 变化时 120ms 旧态淡出
  新态淡入（key 触发 fadeIn 即可，不做双层 DOM）。
- **明确不做**：数字变化 flash、方向性 Tab 过渡、装饰性微交互——不符合「动效只表达因果」。

---

## 3. 改造范围

### 3.1 渲染层

| 层 | 内容 | 涉及文件 |
|----|------|---------|
| 新增组件 | ConfirmBar、EmptyState、LogLineList（或同职责 hook）、STATUS_SEMANTICS 常量 | `components/` |
| 页面改造 | 状态页（活动条运行中区+右栏重排+窄窗顺序）、历史页（组头失败摘要+arriveAnimation）、应用页（scheduled chip+ConfirmBar 换装+空态出口）、配置页（宽屏双栏+改动清单/放弃+即时生效标注+Agent 引导卡）、向导（文案+空态家族） | 5 个 `pages/*.tsx` |
| 壳层 | titlebar/tabs ≥900px 合并、Tab 重排、Ctrl+F 列表搜索、关窗文案修正 | `App.tsx`、`base.css` |
| 查看器 | LogLineList 抽取、INFO 降噪、行内复制/打开文件、邻次切换、打开文件入口 | `LogViewer.tsx`、`FormattedLogText.tsx`、`StatusWindow.tsx` |
| 样式 | @font-face、badge-neutral、层级压缩、chrome 合并、collapsible 高度过渡、空态家族 | `styles/` 四文件 |
| i18n | S5 门面四件 + S3/S4 新组件文案（zh/en 成对，N-04 guard 钉住） | `i18n.ts` |

### 3.2 主进程（少量、谨慎）

- `notifier.ts`：failed 通知正文补退出码（读取 meta.exitCode，白名单口径）；
- `tray.ts`：菜单补「打开应用」回调（复用 windowManager.sendSwitchTab('apps') 通道形态）；
- `window-manager.ts`：**不改**（画布色 #f5f6f8 红线不触碰，chrome 合并是渲染层布局）。

### 3.3 资产与打包

- `assets/fonts/*.woff2` + electron-builder `extraResources` 增配 fonts 目录；
- vite 静态资产在 dev/打包双形态的路径解析验证（对齐 tray 图标双路径探测先例）。

### 3.4 验收与回归

- `e2e/screenshots.cjs` 21 张重录为 v4 基线（新增：2000px 配置页双栏、合并 chrome 两态）；
- `renderer.selftest.mjs`：CFG_TEXTS 键位对齐断言随新键扩展；样式断言文件改读四文件入口；
- `e2e/desktop-smoke.spec.js` / `n10-desktop.spec.js` / `ui-audit.cjs` 随文案/DOM 同步
  （依赖文案清单见 UX-UPGRADE-STATE「e2e 依赖文案清单」节）；
- 手工清单：字体渲染（Windows 无 Fira 机器实测回落）、Ctrl+数字/Ctrl+F 全页走查、
  五处确认条键盘动线（Tab 顺序/Esc/Enter 逐处）、展开过渡与 scrollIntoView 共存、
  2000px/800px 双通道。

### 3.5 明确不做（防花哨与防过度工程）

不做暗色主题（令牌体系已具备可翻转性，列为长期项；本轮成本/收益不匹配）、不引 UI 框架、
不做日志虚拟滚动重写、不做 4 页存量文案全量 i18n 迁移（继续二期）、不改 Tab 命名、
不做插画体系、不做数字动画、不动 CSP/安全架构/常驻挂载 tab 级架构。

---

## 4. 落地分期

| 期 | 内容 | 量级 | 备注 |
|----|------|------|------|
| **V4-1 视觉基底** | 字体内嵌+@font-face、badge-neutral/STATUS_SEMANTICS、层级压缩、details marker、Tab 重排、关窗文案修正 | 中 | 无逻辑改动；e2e Ctrl+数字断言同步 |
| **V4-2 日志管线归一** | LogLineList 抽取（原样迁移→门禁）→ 预览 trace/arrive、INFO 降噪、行内复制/打开文件、邻次切换、清空显示迁移 | 大 | 回归风险最高，严格执行两步走；写实夹具保留 |
| **V4-3 状态页任务运行台** | 活动条运行中区、右栏重排（连接降级+最近失败）、窄窗 order 修正、配置页宽屏双栏+Agent 引导卡 | 中 | 活动条与停机确认共用 allRecords，不加 IPC |
| **V4-4 交互收口** | ConfirmBar 五处换装、配置改动清单/放弃、即时生效标注、搜索快捷键、托盘「打开应用」、通知退出码 | 中 | 含少量主进程；五处 DOM 变更 e2e 逐处验证 |
| **V4-5 动效与引导收尾** | 展开高度过渡（常驻挂载+grid-rows）、状态大字 crossfade、历史组头失败摘要、scheduled chip、空态家族/出口修正、门面四件 i18n | 小-中 | 常驻挂载改动需回归 AppsPage MutationObserver |

顺序 V4-1→V4-5，每期独立可发布；V4-2 与 V4-3 无依赖可并行（文件所有权互斥）。

---

## 5. 落地风险提示

1. **LogLineList 抽取是最高回归风险单点（同 v3 R2）**：双时间戳合并/级别判定/增量游标/
   失败重试的正确性投资都在渲染输入侧。必须原样迁移先行、夹具回归通过后再动视觉；
   实时行与文件行的 `id` 稳定性（到达动效误判整屏为新行的旧坑）要在新旧两路径各验一遍。
2. **字体打包链路是新引入的外部依赖面**：woff2 未进 extraResources 时打包态 404 →
   静默回落系统字体（不炸但白做）；dev/打包/裸 electron 三形态路径都要探测（QA-12 先例）；
   Fira 系列为 SIL OFL 可内嵌，License 文件须随分发。CSP 不需要放宽（self 即可），
   严禁走 Google Fonts 在线引入。
3. **chrome 合并动三块敏感面**：`-webkit-app-region` 拖拽命中区重划（tabs/窗控钮必须
   no-drag）、双击最大化保留、e2e 依赖 titlebar aria 文案（最大化窗口/还原窗口/关闭窗口）
   与「欢迎使用」等 smoke 锚点。合并只在 ≥900px 生效，窄窗通道像素级不动。
4. **Tab 重排砸 Ctrl+数字预期与断言**：`TAB_ORDER` 是 roving tabindex、Ctrl+1..4、
   TAB_SWITCH_EVENT 白名单三处共源，改动本身安全；但 e2e 里「Ctrl+2=配置」类断言、
   tab tooltip 文案（`（Ctrl+N）`）必须同步。localStorage 存 key 不存 index，无迁移问题。
5. **ConfirmBar 换装=五处 DOM 结构变更**：`role="alertdialog"`/autoFocus/Esc 行为逐处
   过键盘动线；停机确认的「确认前文案不动」红线（running 计数具体数字）在组件 props 里保持。
6. **展开高度过渡与页面机制互相作用**：history 自动展开首组（userToggled 语义）、
   AppsPage 展开后 `scrollIntoView(nearest)`、搜索态多卡自动展开——三处都要在
   常驻挂载+过渡下复验；过渡期间 `scrollHeight` 变化可能让「nearest」算少，必要时
   过渡结束后再滚（rAF 双帧）。
7. **配置页改动清单的掩码口径**：executorToken 在 diff 里必须掩码（与
   `configStore.getAllMasked` 同规则），否则改动清单变成密钥泄露面。
8. **文案即断言（持续成立）**：活动条/失败摘要/scheduled chip/即时生效 tag 的新文案
   一律进 smoke/ui-audit 依赖清单；新键 zh/en 成对，N-04 guard 钉住。
9. **MASTER/覆盖文档同步**：`design-system/autocodeflow/pages/executor-desktop.md`
   须随 V4-1 回写（字体、badge-neutral、chrome、EmptyState），否则下轮接手者按 v3 基线造页。

---

## 6. 证据附录

- 实拍截图（v3 终验态，2026-10-05 03:45）：`apps/executor-desktop/e2e/.screenshots/`
  01–23；本轮逐页目验：01/01b（向导）、02/21（状态宽/窄）、03（全屏日志）、
  04/05/06/07/08（配置五分区）、09（历史）、12/13/16（应用三态）、23（历史窄窗）。
- 关键源码定位：`StatusWindow.tsx:763`（预览无 trace 合并）、`LogViewer.tsx:326-349`
  （全屏 trace 块）、`AppsPage.tsx:191`（arriveAnimation 唯一传入点）、`AppsPage.tsx:653`
  与 `StatusWindow.tsx:687`（autoFocus 相反）、`pages.css:1049`（badge-current 绿）、
  `pages.css:1203-1209`（配置限宽左对齐）、`pages.css:1616-1637`（窄窗右栏 order:-1）、
  `App.tsx:12,280`（TAB_ORDER/close-tip 文案）、`ConfigPage.tsx:241-252,900-929`
  （两种保存契约）、`notifier.ts:206-214`（通知正文）、`ipc-handlers.ts:1001-1004`
  与 `index.ts:79`（关闭语义）、`tokens.css:102-110`（字体未内嵌自注）。
- 既有基线文档：`docs/UX-AUDIT-DESKTOP-2026-10-05.md`（v3 审计+落地记录）、
  `docs/UX-UPGRADE-2026-10-05-STATE.md`（v3 执行状态与偏差、e2e 依赖文案清单）。

---

## 7. 落地记录（V4 已于 2026-10-05 当日实施完成）

V4-1～V4-5 五期全部落地并通过终验。逐期门禁：`build:renderer + test:renderer` 每期全绿；
主进程涉改期（V4-4）`build:main + 全量 test:main（40+ 自测）+ tray-texts selftest` 全绿；
终验 `test:e2e（playwright，11/11）+ e2e/screenshots.cjs 21/21 + 关键页逐张过图`。

### 7.1 已落地（对照 §1 问题清单）

- **V4-1**：V-01 字体内嵌（Fira Sans 400/600/700 + Fira Code 可变，latin 子集
  woff2 随 vite 打包，SIL OFL 许可文件随附）；V-06 `app-badge-current` 中性化；
  V-07 层级压缩（统计胶囊拆除、两处光环收口）；V-08 details marker 自绘 chevron；
  V-03 顶栏合并（≥900px 单行 48px，窄窗折行回两行，双击按钮不触发最大化）；
  I-02 Tab 重排（状态→历史→应用→配置，Ctrl+1..4 随 TAB_ORDER 自动跟随）；
  G-04 关窗文案改实。基线截图重录 21/21。
- **V4-2**：V-05/M-01 日志渲染管线归一（新共享 `LogLineList`：trace 块合并 +
  到达动效 + 行号 + 行内工具，LogViewer 与状态页预览同管线；历史查看器开
  arriveAnimation）；V-04 INFO 级别降噪（去底色徽章、级别列 44→36px）；
  X-03 行内「复制此行」（全行 hover）/「打开日志文件」（warn/error 行）+
  历史查看器「上一次/下一次执行」切换（key=executionId 重建数据链路）；
  X-06「清空显示」迁入查看器工具行。
- **V4-3**：I-01 状态页活动条「运行中任务」明细（任务名+已运行时长，≤2 个+溢出
  计数，数据与计数同源无新 IPC）+ 右栏「最近失败」Top3 卡；I-03 连接信息降级
  两行摘要、窄窗右栏移到日志下方；V-02 配置页五分区 cfg-main/cfg-aside 双栏
  （≥1400px，右栏承载诊断/引导/低频说明）+ 连接三步引导卡 + G-01 Agent
  「这是什么/开启后果/如何收紧」引导卡；I-04 autolaunch「即时生效」micro-tag。
  实施中终验修正：窄窗（<1100px）状态页改自然滚动 + 日志区限高
  （原定高双行 grid 下 auto 右栏把 1fr 日志行压成 0 造成叠压，playwright 几何探测证实后修复）。
- **V4-4**：X-01 共享 `ConfirmBar`（danger/impact 两变体；主钮统一 autoFocus、
  Esc=取消、焦点归还触发钮；五处换装，四处页级旧确认样式删除并记清扫台账）；
  X-02 配置改动清单（字段级 旧→新 diff，密钥掩码）+「放弃修改」（含 textarea
  草稿回滚）；X-05 历史/应用页 Ctrl+F 聚焦搜索（查看器打开时让位）；
  X-04 失败通知补退出码（meta.exitCode 白名单口径）+ 托盘菜单补「打开应用」
  （tray-texts 双语键 / windowManager.openApps()）。
- **V4-5**：M-02 展开高度过渡（`.collapsible` 0fr→1fr，history-runs 与
  app-group-details 常驻挂载 + 收起态 inert，runsIn 随 data-open 重放）；
  M-03 状态大字/描述 key 重挂 120ms crossfade；I-05 历史组头折叠态失败摘要
  （最近 failed 的 errorMessage/退出码一行）；I-06 应用组头「定时」chip；
  V-09 `EmptyState` 空态家族（历史/应用页接入）+ G-02 应用页空态出口改序；
  I-07 门面四件入 `shell.*` 双语键（Tab 标题/titlebar/关窗提示/向导步骤名+
  加载占位，zh 值与硬编码逐字一致）。
- **文档**：`design-system/autocodeflow/pages/executor-desktop.md` 已回写 v4
  （字体、状态色语义、组件清单、顶栏、窗口红线不触碰声明）。

### 7.2 门禁结果

- `build:renderer` ✓；`test:renderer` 全 guard ✓（含 N-04 键位对齐——新增
  cfg.conn.guide* / cfg.agent.guide* / cfg.footer.* / cfg.gen.instantTag /
  shell.* 全部 zh/en 成对；UX走查⑤ 守卫随 shell.loading 接线同步更新）；
- `build:main` ✓；全量 `test:main`（40+ 自测）✓；`tray-texts selftest` ✓
  （openApps 双语键入表）；
- `test:e2e` playwright **11/11** ✓（desktop-smoke 7 + N-10 3 + 配置页）；
  修复了两处用例与现行契约的脱节：①「主窗口记住尺寸」用例仍按 v3 前
  「点关窗即关窗」断言——C-04 首次关窗拦截是 v3 R4 落地、而 playwright 套件
  当时不在门禁内，属 v3 遗留回归，本 rigged 按现行契约改写（关窗→气泡→
  知道了→close），并锚定 `.close-tip` 作用域避开托盘提示条同名按钮；
  ②`screenshots.cjs` 历史页 fixture 文本断言被状态页右栏「最近失败」同名
  文本歧义命中（面板常驻挂载，getByText 命中隐藏元素）——锚定 `#history-panel`；
- `e2e/screenshots.cjs` **21/21** 重录 ✓；关键页（02/03/04/07/09/12/14/21/23）
  逐张过图确认。

### 7.3 偏差与说明

1. **字体打包走 vite 资产链而非 electron-builder extraResources**：woff2 经
   CSS `url()` 由 vite 直接打进 dist/renderer/assets（file:// 同源，CSP
   `font-src 'self'` 合法），免去了 extraResources 配置与三形态路径探测——
   §3.3 的 extraResources 方案被更简实现取代，红线（禁在线字体）不变。
2. **历史日期桶共享卡壳未实施**：桶内组合并卡壳与宽屏多列 grid 流冲突
   （桶容器会占据整行、破坏逐卡分列），V-07 的层级压缩以统计胶囊拆除 +
   光环收口落地，桶级合并留待 IA 再演进时评估。
3. **应用页查看器未加 onOpenFile**：应用查看器入口卡本身已有「打开目录」，
   且页级 notice 在查看器接管渲染期不可见，避免失败反馈断链；状态/历史两
   查看器已接入。
4. **「最近失败」点击暂不带 failed 过滤**：跨 Tab 过滤参数需要扩展
   TAB_SWITCH_EVENT 协议，本轮只切页不过滤（历史页已有失败 chip 一步可达）；
   列入后续可选项。
5. **一处 pre-existing 修复**：§7.2 所述 desktop-smoke 关窗用例为 v3 遗留
   失败（非本轮引入），已按现行契约修复——V4 门禁首次把 playwright 套件
   纳入，后续应保持。

---

## 8. 后续优化轮（2026-10-05 当日，A/B 两组全部落地）

V4 终验后按「还能优化什么」评估出 8 项，全部实施完成：

1. **应用清单扫描异步化**：`app-inventory.ts` 全量 `fs/promises` 化（原 readdirSync/
   statSync 在主进程每 10s 轮询，release 多时阻塞主线程；对齐 NETOPT-E 先例）。
   apps:list IPC 改 async，selftest 5 处调用点转 await，语义（目录级失败上抛/
   单条目跳过）逐字保留。`app-name-recovery` 因签名缓存稳态零 I/O，维持现状并注明。
2. **失败直达过滤**：`requestTabSwitch` 扩展可选 `historyStatusFilter` 参数
   （detail 对象形态、字符串形态向后兼容）；状态页「最近失败」点击直达历史页
   failed 过滤（HistoryPage 监听同一事件流消费过滤字段）。
3. **应用查看器「打开部署目录」**：行内 hover 入口（warn/error 行），失败反馈走
   LogViewer 新增 `notice` 槽（工具行下方 6s 自动消失，不与日志读取失败混用）。
4. **性能微优化**：历史/应用搜索过滤走 `useDeferredValue`（输入即时响应）；
   LogLineList 行组件 `React.memo` 化（hover/复制反馈只重渲染进出行）。
5. **混排规范全量清扫**：node 审计脚本扫 10 个文案文件——省略号 `…`/`...` 混用
   统一为 `...`（5 处）、向导确认页 `(自动) :` 改 `（自动）:`（审计其余命中为
   代码括号包中文参数的误报，非用户可见文案问题）。
6. **i18n 二期迁移（最大单项）**：旧四页 + 向导 + 共享组件内置文案全部入
   CFG_TEXTS（`status.* / history.* / apps.* / wizard.* / logviewer.* / ui.*`
   约 230 键，zh/en 成对，N-04 对齐守护自动覆盖）；**zh 值与原硬编码逐字一致**，
   zh 系统渲染零变化、e2e 中文锚点全数保住。三个源码字面量守卫（未知应用名/
   空态区分文案/跳过测试提示）改「键接线 + zh 值」双端锚定。
7. **轮询口径统一**：状态页今日概览 60s → 10s（与历史页同源同频，消除数字漂移）。
8. **trace 块边界行为核实**：读码确认窗口边界处块首 chip 会**正确重锚定**在
   窗口内该 trace 首行（加载更早后亦然），此前审计注记的「边界断块」实为
   正确行为——结论记录于此，无代码改动。

**终验门禁**：`build:renderer + test:renderer + 全量 test:main + test:e2e 11/11
+ screenshots 21/21 重录 + 关键页过图（02/01 无裸键名、文案与迁移前逐字一致）`。
**过程修复一处自伤**：HistoryPage 新过滤器监听引用 `TAB_SWITCH_EVENT` 未导入
（vite 无类型检查、build 不报），渲染树被 ErrorBoundary 兜底成兜底页——
probe 脚本抓到 console.error 后补导入；e2e 全绿确认恢复。
