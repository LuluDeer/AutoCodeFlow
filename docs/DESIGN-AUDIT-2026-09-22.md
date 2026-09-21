# AutoCodeFlow 设计与交互品质专项审计（2026-09-22）

> 分支 `develop`，HEAD 起点 `496157ad`。阶段一为三路只读审计（任务族 / 应用执行器族 / 横切体系+executor-desktop renderer），全部经源码回读 + 既有守卫交叉验证。
> 已先读 `docs/UX-AUDIT-2026-09-21.md`（44 条闭环）、`docs/ENG-AUDIT-2026-09-21.md`（0P0/8P1/21P2），**凡已闭环/守卫已钉项一律不重复**。
> 截图巡检：dev server 实测可启动（vite v8.2.2，5199 返回 200），受登录凭证限制，PrivateRoute 后页面未截图，结论以源码+守卫证据为准（详见末尾）。

## 顶部进度表

| # | 级别 | 条目 | 状态 | commit |
|---|---|---|---|---|
| D-P1-1 | P1 | 任务列表调度列 fixed_rate≥60s 二次包裹出「每 2 分钟 秒」 | ✅ | 6e28d211 |
| D-P1-2 | P1 | 剪贴板诚实性守卫缺口：AppDeploymentPage 静默 catch、ExecutionDetailPage 无 fallback | ✅ | 4832f71e |
| D-P2-01 | P2 | 全仓 Alert `message=` 迁移残留（~12 处）统一为 `title=` | ✅ 分片A+B | 4832f71e |
| D-P2-02 | P2 | 依赖图/详情页 runtime、status 等裸枚举未本地化 | ✅ 分片A+B | 4832f71e |
| D-P2-03 | P2 | timeout=0（不限时）在详情页显示 `-` | ✅ | 6e28d211 |
| D-P2-04 | P2 | 仪表盘 SSE 状态点色硬编码 hex，未走语义令牌 | ✅ | 6e28d211 |
| D-P2-05 | P2 | 依赖图节点可点击但无键盘可达 | ✅ | 6e28d211 |
| D-P2-06 | P2 | 依赖图当前节点阴影硬编码旧 antd 蓝 | ✅ | 6e28d211 |
| D-P2-07 | P2 | 依赖图整 Tab 加载用裸居中 Spin | ✅ | 6e28d211 |
| D-P2-08 | P2 | AppDeploymentPage Tag 无效 `background: ${color}15` 死样式 | ✅ | 4832f71e |
| D-P2-09 | P2 | 9 处时间格式化手写 toLocaleString，未统一 formatDateTime | ✅ | 4832f71e |
| D-P2-10 | P2 | 两表分页器缺 showTotal，总数口径不一致 | ✅ | 4832f71e |
| D-P2-11 | P2 | 6 处硬编码英文文案未走 i18n | ✅ | 4832f71e |
| D-P2-12 | P2 | ExecutorPackages 推送失败直接抛 e.message 技术串 | ✅ | 4832f71e |
| D-P2-13 | P2 | admin-web 缺 prefers-reduced-motion 兜底（desktop 有） | ✅ | 4832f71e |
| D-P2-14 | P2 | 两页 Tabs 状态未入 URL，刷新丢失 | ✅ | 4832f71e |
| D-P2-15 | P2 | `--color-ring` 为语义错乱死令牌 | ✅ | 4832f71e |
| D-P2-16 | P2 | 品牌渐变内联重复 5 处，未收 token | ✅ | 6e28d211 |

---

## P0

无。未发现布局破坏、不可用或不可逆误操作路径。

---

## P1（2 条）

### D-P1-1 ｜ 任务列表「调度」列把已本地化的「N 分 M 秒」再塞进「每 X 秒」模板，渲染出「每 2 分钟 秒」
- **证据**：`apps/admin-web/src/pages/TaskListPage.tsx:336-343`。`fixedRate=120` → 先得 `label='2 分钟'`，再被外层 `t('taskList.schedule.sec',{sec:label})` 包成 **「每 2 分钟 秒」**；`=125` → 「每 2 分 5 秒 秒」。`<60s` 分支只套一次模板正常，故仅 ≥60s 任务中招。词条见 `locales/zh.ts:221-223`。
- **问题**：列表调度列是值班首查项，周期单位自相矛盾直接影响判断。
- **改法**：≥60s 分支直接 `return <Text>{label}</Text>`，去掉外层包裹。成本极小。

### D-P1-2 ｜ 剪贴板诚实性守卫缺口：两处未纳管文件仍裸 `navigator.clipboard` + 静默失败
- **证据**：
  - `AppDeploymentPage.tsx:92-98`：`try{ writeText; success } catch { /* 静默 */ }`，失败零反馈。
  - `ExecutionDetailPage.tsx:879-884`：`navigator.clipboard.writeText(...)`，非安全上下文下 `navigator.clipboard` 为 undefined，同步 TypeError，`.then` 链根本不建立——成功失败均无提示。
  - 对照：`ux04`（clipboard-honesty）守卫已把「裸 clipboard、无 fallback、失败静默」钉为反模式，但只覆盖 ApiKeysSettings / EventSubscriptionsSettings / ExecutorInstallWizardPage 三文件，漏了这两处。
- **问题**：复制的恰是排障核心（部署错误文本、traceId），用户点复制零反馈、粘出来是空的。
- **改法**：两处改走 `utils/clipboard.ts` 的 `copyText()`（ExecutionDetailPage:1152 日志复制已在用同文件两套并存），并把这两个 file 加进 ux04 守卫覆盖清单。成本低。

---

## P2（16 条，低风险打磨）

### D-P2-01 ｜ 全仓 Alert `message=` 迁移残留（antd 6.6.2 已 deprecated）
- **证据**（约 12 处）：`components/TaskDependencyGraph.tsx:155,163`；`ApplicationDetailPage.tsx:120`；`AppDeploymentPage.tsx:615,676`；`ExecutionDetailPage.tsx:1443`；`ExecutorDetailPage.tsx:683,724`；`settings/EventSubscriptionsSettings.tsx:119,128,546`；相邻 `ApiKeysSettings.tsx:95,221`。每文件内部均「多数已 title=、个别漏改」。`node_modules/antd/es/alert/Alert.d.ts:50` 标注 `@deprecated please use title instead`。
- **改法**：批量 `message=`→`title=`，文案不动。

### D-P2-02 ｜ runtime / 任务状态裸枚举未本地化
- **证据**：`TaskListPage.tsx:415` 运行时列直出 `python/node/shell`；`TaskDetailPage.tsx:385` failed/inactive 落裸英文；`ApplicationListPage.tsx:399`、`ApplicationDetailPage.tsx:348,514`、`ExecutorPackagesPage.tsx:308` 同概念在筛选下拉已是 `Node.js/Python/Shell`，表格却直出小写原值，对不上号。
- **改法**：复用/抽 `runtimeLabel()`，与筛选下拉同源；状态复用 `taskList.status.*` 映射，未知值兜底显示原值。

### D-P2-03 ｜ timeout=0（不限时）在详情页显示 `-`
- **证据**：`TaskDetailPage.tsx:534` `{task.timeout ? … : '-'}`，0 为 falsy → 显示 `-`。上轮已明确 0=不限时，详情页与表单语义不一致。
- **改法**：0 时渲染「不限时」文案。

### D-P2-04 ｜ 仪表盘 SSE 状态点色硬编码 hex
- **证据**：`DashboardPage.tsx:70-74` 返回 `#22c55e/#f59e0b/#94a3b8`，与 `theme/tokens.ts` 的语义色重复定义。
- **改法**：改从 SEMANTIC_COLORS 取值。

### D-P2-05 ｜ 依赖图节点可点击但无键盘可达
- **证据**：`TaskDependencyGraph.tsx:211-228` 节点 `div onClick` 无 `tabIndex/onKeyDown`（同文件 118-120 热力条行已正确实现键盘跳转，此处漏）。
- **改法**：补 `tabIndex={0}` + Enter/Space 触发。

### D-P2-06 ｜ 依赖图当前节点阴影硬编码旧 antd 蓝
- **证据**：`TaskDependencyGraph.tsx:226` `rgba(22,119,255,0.25)`（#1677ff），与品牌绿体系不符；ux09 已把焦点环同色旧蓝清掉，此处漏。
- **改法**：换品牌绿/语义 token。

### D-P2-07 ｜ 依赖图整 Tab 加载用裸居中 Spin
- **证据**：`TaskDependencyGraph.tsx:85` `if(loading) <Spin/>`；ux08 守卫自陈「页内小控件 Spin 允许」，不违规，但整块 Tab 加载与全站 PageSkeleton 观感不一致。
- **改法**：改 PageSkeleton（table 变体）。

### D-P2-08 ｜ AppDeploymentPage Tag 无效 `background: ${color}15` 死样式
- **证据**：`AppDeploymentPage.tsx:402`。color 是 antd 预设色名（green/blue/…），拼成 `"green15"` 非法 CSS，浏览器整段丢弃，底色从未生效。
- **改法**：删掉该行 background 让 Tag 自身配色生效，或用 token.colorPrimaryBg。

### D-P2-09 ｜ 9 处时间格式化手写 toLocaleString，未统一 formatDateTime
- **证据**：`ExecutorDetailPage.tsx:263`；`ApplicationDetailPage.tsx:190,193,538,566`；`NotificationSettingsPage.tsx:362`；`settings/index.tsx:304`；`EventSubscriptionsSettings.tsx:208`。项目已有 `utils/timeFormat.ts` 共享 `formatDateTime`。
- **改法**：统一替换。

### D-P2-10 ｜ 两表分页器缺 showTotal，总数口径不一致
- **证据**：`ApplicationListPage.tsx` 主表无 showTotal；`ApplicationDetailPage.tsx:352-358` TasksTab 无 showTotal（同页 VersionHistory/Releases 都有）。
- **改法**：补 `showTotal: n => t(...)`。

### D-P2-11 ｜ 6 处硬编码英文文案未走 i18n
- **证据**：`ExecutionDetailPage.tsx:1306` `Attempt #`；`ExecutorDetailPage.tsx:584` recharts `CPU %`；`settings/index.tsx:587,596,616` `API Base URL/API Key/Ollama Host`；`EventSubscriptionsSettings.tsx:469` 列 `URL`。
- **改法**：补 zh/en 双键本地化。

### D-P2-12 ｜ ExecutorPackages 推送失败直接抛 e.message 技术串
- **证据**：`ExecutorPackagesPage.tsx:258` 直接 `(e as Error).message`（axios 英文串）；同文件 276/286 已用 `getErrMsg`。
- **改法**：改 `getErrMsg(e, t(...))`。

### D-P2-13 ｜ admin-web 缺 prefers-reduced-motion 兜底
- **证据**：`index.css`（293 行）无 reduced-motion 块；运动源在 `:124/:139-143/:226`。`executor-desktop/src/renderer/styles/app.css:1892` 已有同款块——desktop 有、web 反而漏。
- **改法**：index.css 末尾追加同款 reduce 块（只压 transition/animation，不动焦点环）。

### D-P2-14 ｜ 两页 Tabs 状态未入 URL，刷新丢失
- **证据**：`NotificationSettingsPage.tsx:669-671` 纯本地 state；`settings/index.tsx:726` Tabs 非受控永远回第一页。对照 ApplicationDetailPage:813、ExecutionDetailPage:229 已用 `?tab=`。
- **改法**：照抄 useSearchParams `?tab=` 方案（可复用 normalizeTabKey）。

### D-P2-15 ｜ `--color-ring` 为语义错乱死令牌
- **证据**：`index.css:32/94` 定义 `#22c55e`，但注释自承 MASTER 语义 Ring=#0F172A；全仓已无运行时消费者（dashboard 卡片已迁到 warning 色）。留着值错语义也错的令牌必踩坑。
- **改法**：删除该变量（或改回 #0f172a 对齐 MASTER）。

### D-P2-16 ｜ 品牌渐变内联重复 5 处，未收 token
- **证据**：`MainLayout.tsx:461,660`；`LoginPage.tsx:120,210,263`。改品牌色要逐处找，与 tokens.ts 单源原则相悖。
- **改法**：tokens.ts 增 `brandGradient` 常量（或 BrandMark 共享组件）。

---

## 证伪记录（查过但不报，避免重复翻案）

- **Modal 焦点陷阱/Esc/Tab 顺序**：CommandPalette 用 antd Modal 天然焦点陷阱，`a11y-focus.test.tsx` 已实测焦点归位、↑↓ 跟随、Esc 归还触发元素；MainLayout 移动抽屉 Esc 亦归还汉堡。已闭环。
- **焦点环旧蓝/对比度不足**：ux09 已换 `--color-focus-ring` 并在测试里现算亮/暗面 ≥3:1。已闭环。
- **明暗双主题色板不翻转/暗色不可见**：ux01/ux02 已修 `--color-secondary` 当正文与登录页 `#333`；tokens.ts 双消费单源。已闭环。
- **头部面包屑重复**：P1-21 已修，`MainLayout.pageSelfRendersBreadcrumb()` + ux21 守卫钉死。
- **命令面板三态/行内动作**：P2-5 已补静态导航，loading/error/noResults 齐全；executors/app 全量拉取、tasks 只搜首页是文件头自陈的已知取舍，非缺陷。
- **深链不可达/菜单高亮丢失**：router 全覆盖，`selectedKey` 对 `/tasks/new`、`/executors/:id` 等正确回落，静态路由优先于 `:id`。
- **CodeBlock 固定暗色**（ExecutorInstallWizardPage:124）：复制安装命令的终端块，明暗主题下都该是终端观感，刻意设计。
- **首屏 Table loading + 空态骨架双 spinner**（ApplicationListPage）：骨架占位+加载指示的刻意组合，非缺陷。
- **执行器离线通知堆叠**：offline 用 `duration:0`、online 用 `duration:6`，语义正确。
- **ExecutionDetail 切记录旧日志回写**：已用双序号守卫。
- **轮询闪烁打断**：轮询均走轻量 fetchDeployments（不 setLoading），包管理 30s 且弹窗打开时跳过。
- **UUID 长串**：已 ellipsis + Tooltip 全文。
- **登录 TOTP 第二步无「返回账号」**：密码已对，无需回退，刻意流程。
- **登录 prefix 图标 `#ccc`**：亮/暗卡面均可读，antd 前缀惯例，列设计建议。
- **TaskTemplates 分类/响应式网格**：ux10 已钉 categoryLabel 走 t()，xs24/sm12/lg8/xl6 正确。
- **表格窄屏**：`.ui09-hide-mobile` + scroll.x 双保险已在，且 index.css:262-320 注释记录上轮 375px 实测修复。
- **executor-desktop renderer**：单暗色 OLED 主题，令牌完整（76 变量），有 prefers-reduced-motion、tab 语义/aria 齐全、错误态 role=alert。问题仅：无 i18n（界面全中文、Suspense 兜底写死英文 Loading）、Tab 无 roving arrow-key、Tab 不持久化、`--color-ring:#0f172a` 与 admin-web 漂移。**列入设计建议，不计级**（desktop 非本轮主交付面）。

---

## 设计建议（偏好类，不计 P 级）

1. 主操作按钮白字 on `#22C55E` ≈ 2.28:1，低于 WCAG AA；品牌绿已被团队刻意保留（ux09 注释），若无障碍优先可只把按钮文字背景加深到 `#16a34a`。
2. 通知铃铛无未读信号：需后端真实 unread 字段，当前无假红点是对的。
3. 安装向导/表单占位符硬编码中文：i18n 已声明「未迁移页逐页迁」，属既定渐进路线。
4. 头部 768–1024px 中宽屏长面包屑+右侧控件挤压未能截图确认，建议下次真机补测。
5. CodeBlock 用通用 monospace 栈，未消费 `--font-mono`。
6. EventSubscriptions 死信 payload `slice(0,80)` 截断后无展开入口。
7. NotificationSettings 渠道 Switch 异步启停期间无 disabled/loading。
8. HistoryModal 名为 Drawer 实为 Modal（命名与形态不符）。

---

## 截图巡检覆盖

| 项 | 结果 |
|---|---|
| dev server 启动 | ✅ 实测 vite v8.2.2 ready，5199 返回 200，确认即停 |
| 登录页明/暗 | ⚠️ 未截图，暗色已由 ux02 守卫锁定 |
| 仪表盘/任务/应用/执行器/命令面板 明+暗 | ❌ 未截图（无登录凭证），结论全部基于源码+守卫证据 |
| 375px/中宽屏溢出 | ⚠️ 未目视；窄屏修复已由上轮 375px 实测落地并注释留痕 |

## 证据强度声明
- P1-1 经 i18n 词条反向验算复现（「每 2 分钟 秒」/「每 2 分 5 秒 秒」）。
- 所有 file:line 均逐条读码确认；P2-01 经全仓正则确认仅 ~12 处 `message=`。
- 本轮未改任何源码；dev server 仅启动确认即停，工作区未改。
