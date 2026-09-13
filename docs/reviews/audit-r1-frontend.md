# admin-web + executor-desktop 深度审查（2026-09-14 @ 0ef3bbe）

> 评审范围：`apps/admin-web` 全部源码、`apps/executor-desktop` 全部源码（主进程/preload/渲染进程/打包/更新/与 admin-api 的通信面）；`design-system/` 以被引用方式核对（仅作为 token 语义来源，未发现被构建引用）。
> 方法声明：本报告所有结论均来自实际打开阅读的代码（阅读清单见 §1.3），每条发现附 `文件:行号` + ≤5 行摘录。环境 Windows + Git Bash，未运行 install/build/test，未修改任何现有文件。

---

## 一、全景与方法

### 1.1 目录规模统计

| 目录 | 文件数 | 行数 | 备注 |
|---|---|---|---|
| `apps/admin-web/src` (ts/tsx) | 188 | 49,246 | 含 `types/generated/api-types.ts` 7,394 行生成物 |
| ├ `pages/` | 34 文件 | 13,337 | 22 个路由页 + 10 个领域逻辑 ts |
| ├ `__tests__/` | 79 文件 | 15,893 | 测试占比约 32% |
| ├ `api/` | 20 文件 | 2,210 | client.ts 为统一 axios 封装 |
| ├ `components/` | 28 文件 | 3,824 | |
| ├ `hooks/` | 4 文件 | 430 | 3 个 SSE hook + useDebounce |
| ├ `locales/` | 2 文件 | 4,266 | zh/en 各约 2,130 行扁平 key |
| ├ `theme/` | 3 文件 | 294 | |
| └ `store/` `i18n/` `utils/` | 14 文件 | ~860 | |
| `apps/executor-desktop/src` | 27 文件 (ts/tsx) | ~4,100 | main 15 / preload 2 / renderer 7 |
| `apps/executor-desktop/resources/executor-node/index.js` | 1 | 59,099 | **2.1MB 内嵌 bundle 提交进 git** |

### 1.2 Top 15 大文件（admin-web，剔除生成物）

| 文件 | 行数 |
|---|---|
| pages/TaskFormPage.tsx | 1,147 |
| pages/ExecutionDetailPage.tsx | 1,024 |
| components/CommandPalette.tsx | 805 |
| pages/ExecutorInstallWizardPage.tsx | 723 |
| pages/ApplicationDetailPage.tsx | 718 |
| pages/settings/index.tsx | 698 |
| pages/NotificationSettingsPage.tsx | 681 |
| pages/TaskDetailPage.tsx | 673 |
| pages/ApplicationListPage.tsx | 662 |
| pages/AppDeploymentPage.tsx | 624 |
| layouts/MainLayout.tsx | 606 |
| pages/ExecutorDetailPage.tsx | 585 |
| pages/settings/EventSubscriptionsSettings.tsx | 534 |
| pages/TaskListPage.tsx | 502 |
| pages/UserManagementPage.tsx | 490 |

（executor-desktop 侧最大为 renderer/pages/Wizard.tsx 410 行、StatusWindow.tsx 361 行，规模健康。）

### 1.3 实际通读清单（非抽样，均全文阅读）

- **admin-web 全文**：`router.tsx`、`main.tsx`、`App.tsx`、`store/auth.ts`、`api/client.ts`、`api/auth.ts`、`api/logout.ts`、`api/queries.ts`、`api/tasks.ts`、`i18n/index.ts`、`theme/ThemeProviders.tsx`、`theme/store.ts`、`layouts/MainLayout.tsx`、`components/PrivateRoute.tsx`、`components/RequireAdmin.tsx`、`components/ErrorBoundary.tsx`、`components/CommandPalette.tsx`、`components/ParamsEditor.tsx`、`components/GlueEditor.tsx`、`components/ArtifactsList.tsx`、`components/task-form/TriggerPreview.tsx`、`hooks/useMetricsStream.ts`、`hooks/useExecutionsStream.ts`、`hooks/useExecutorLive.ts`、`hooks/useDebounce.ts`、`utils/timeFormat.ts`、`utils/error.ts`、`index.html`、`vite.config.ts`、`package.json`。
- **admin-web 核心页全文**：TaskFormPage、ExecutionDetailPage、TaskDetailPage、ExecutorDetailPage、DashboardPage、TaskListPage、LoginPage、SsoCompletePage、AppDeploymentPage、ExecutorInstallWizardPage（前 330 行 + 轮询/定时器段）、ExecutionsPage、settings/index（Token 段）、ExecutorListPage（数据/通知/列定义段）、ApplicationDetailPage（副作用/设置段）。
- **executor-desktop 全文**：`main/index.ts`、`window-manager.ts`、`updater.ts`、`token-crypto.ts`、`ipc-handlers.ts`、`executor-process.ts`、`config-store.ts`（头段）、`heartbeat.ts`、`notifier.ts`、`preload/index.ts`、`renderer/App.tsx`、`renderer/pages/StatusWindow.tsx`、`renderer/pages/Wizard.tsx`；`electron-builder.yml`、`package.json`、`scripts/`；内嵌 bundle 关键段（writeExecMeta、runTask、meta 字段）。
- **系统性 grep**：`TODO|FIXME|HACK|XXX`（admin-web/src 0 命中）、`console.*`、`as any|as never|as unknown|@ts-ignore`、`dangerouslySetInnerHTML|innerHTML`（0 命中）、`localStorage`、`setInterval|setTimeout`、`zh-CN`（24 处）、`<a onClick`（11 处）、硬编码 hex 色（pages/components/layouts 约 101 处）、`useRequest` 实际 import（3 页）、`it.skip|describe.skip|test.todo`（0 命中）。

---

## 二、发现清单

> 分级口径：P0=核心功能在目标部署形态下不可用/数据静默损失/安全红线；P1=明确可复现缺陷或高价值改进；P2=应排期修复；P3=打磨项。工作量 S≤0.5d / M≤2d / L>2d。
> 加重说明（★）见各条前缀，Top10 汇总在文末。

---

### F-01 ★【Bug/架构】Monaco 编辑器默认走公网 CDN，`monaco-editor` 依赖实为死重（P0，内网/离线部署下致命）
- 位置：`apps/admin-web/src/components/GlueEditor.tsx:14`；`apps/admin-web/vite.config.ts:30-37`
- 证据：
  ```tsx
  // GlueEditor.tsx
  import { Editor } from '@monaco-editor/react';
  ...
  <Editor height="400px" language={editorLang} value={source} ... theme="vs-dark" />
  ```
  ```ts
  // vite.config.ts —— manualChunks 声明了 monaco-editor，但全仓库没有任何 import 它的代码
  ['vendor-monaco', ['@monaco-editor/react', 'monaco-editor']],
  ```
  全仓 grep `loader.config|from 'monaco-editor'` 0 命中：`@monaco-editor/react` v4 未调用 `loader.config()` 时默认从 `https://cdn.jsdelivr.net/npm/monaco-editor@*/min/vs` 动态加载 AMD 版 monaco。
- 影响：Glue 脚本编排（TaskFormPage 分区五、TaskDetailPage Glue Tab）在本平台典型的私有化/内网部署（docker-compose、执行器走 LAN）下**编辑器永远停在 loading**，核心编排功能不可用；`monaco-editor` 依赖与 `vendor-monaco` chunk 是无效配置（实际打进去的只有 wrapper）；同时引入 CDN 供应链风险。
- 修复：`import * as monaco from 'monaco-editor'; import { loader } from '@monaco-editor/react'; loader.config({ monaco });`（配合 `vite-plugin-monaco-editor` 或手工配置 `MonacoEnvironment.getWorker`），删除无效 manualChunks 项或使其真正生效。
- 工作量：M

### F-02 ★【Bug】ParamsEditor 半受控：模板预填的 params 不显示、却会随表单提交（用户提交了看不见的参数）
- 位置：`apps/admin-web/src/components/ParamsEditor.tsx:22-30`；`apps/admin-web/src/pages/TaskFormPage.tsx:281-296`
- 证据：
  ```tsx
  // ParamsEditor —— value 只在 useState 初始化时消费一次，之后 prop 变更被忽略
  const [rows, setRows] = useState<ParamRow[]>(() => toRows(value));
  ```
  ```tsx
  // TaskFormPage 创建态模板预填：此时表单/ParamsEditor 已挂载，setFieldsValue 后
  // Form.Item 传入新 value，但 ParamsEditor 不会同步 rows
  form.setFieldsValue(templateConfigToFormValues(tpl.config));
  ```
- 影响：带 `?templateId=` 创建任务时，模板中的默认参数在编辑器里显示为空（或旧值），但 `form.getFieldsValue(true)` 仍会带出模板 params 提交——**显示与提交数据不一致**，属静默数据错误。当前唯一的"遮掩"是 TaskDetail/TaskList 的触发弹窗用了 `destroyOnHidden` 使其按挂载时序侥幸正确。
- 修复：ParamsEditor 内加 `useEffect(() => setRows(toRows(value)), [value])`（或改为全受控、内部状态上移）；补一条"模板预填后 ParamsEditor 行数一致"的回归测试。
- 工作量：S

### F-03 ★【Bug】任务克隆静默丢失 6 类配置字段
- 位置：`apps/admin-web/src/pages/TaskListPage.tsx:167-194`
- 证据：
  ```ts
  const payload: Record<string, unknown> = {
    name: cloneName, description: ..., runtime, entrypoint, requirements, triggerType,
    cronExpression, timezone, fixedRate, timeout, maxRetry, retryDelay, retryableErrors,
    priority, params, dependencies, executeMode, executorId, executorGroup, executorTags,
    gitRepo, gitBranch, gitCommit, glueSource, glueLanguage, applicationId,
  };
  ```
  对照 `api/tasks.ts:56-78` 的 `Task` 类型：`timeoutAction`、`timeoutWarnRatio`、`maintenanceWindows`、`runbook`、`executorAffinityTags`、`executorAntiAffinityTags` 均未复制。
- 影响：克隆一个配置了超时策略/维护窗口/运行手册/亲和标签的任务，副本全部退回默认值——运维语义（发布冻结窗口、kill_retry）丢失且无任何提示。
- 修复：payload 补齐上述字段（注意 `timeout: src.timeoutSeconds ?? src.timeout` 已有先例），或在 Task 类型上白名单提取（复用 `utils/task-template-extract.ts` 思路）。
- 工作量：S

### F-04 ★【Bug】AI 调度建议「应用 Cron」跳转参数无任何消费方（死功能）
- 位置：`apps/admin-web/src/pages/TaskDetailPage.tsx:613`
- 证据：
  ```tsx
  nav(`/tasks/${id}/edit?suggestCron=${encodeURIComponent(aiSuggestion.suggestedCron)}`);
  ```
  全仓 grep `suggestCron` 仅此一处；TaskFormPage 只读取 `applicationId` 与 `templateId`（TaskFormPage.tsx:134-136）。
- 影响：用户点「应用 Cron 建议」进入编辑页后什么也不会发生——AI 建议无法一键落地，属功能性死链。
- 修复：TaskFormPage 编辑态读取 `suggestCron`（`useSearchParams`），`setFieldValue('cronExpression', ...)` 并提示来源；或删除该按钮。
- 工作量：S

### F-05 ★【安全】SSE 鉴权 token 进 URL 查询串（3 处长驻连接）
- 位置：`apps/admin-web/src/pages/ExecutionDetailPage.tsx:185`；`hooks/useMetricsStream.ts:66-67`；`hooks/useExecutionsStream.ts:96-97`
- 证据：
  ```ts
  const es = new EventSource(url + (token ? `?access_token=${encodeURIComponent(token)}` : ''));
  ```
- 影响：access token 出现在 URL 中——反代/nginx access log、浏览器历史（EventSource 虽不写历史，但共享/复制链接场景存在）、Referer 外泄面。代码注释说明了 EventSource 无法带 header 的限制，属已知取舍，但未量化风险，也未考虑替代方案（一次性 ticket、短效 SSE 专用 token、`fetch`+ReadableStream 降级）。
- 修复：短期：后端为三条 `/stream` 路由签发**短效一次性 ticket**（换 token 走 query），避免长效 access token 入日志；中期：用 `fetch(stream)` 自实现 SSE 客户端（可带 Authorization header），顺势与 F-08 的三套 SSE 合并。
- 工作量：M

### F-06 ★【安全】access + refresh token 双双持久化 localStorage；与 PrivateRoute 注释矛盾
- 位置：`apps/admin-web/src/store/auth.ts:47-52`；`apps/admin-web/src/components/PrivateRoute.tsx:5-10`
- 证据：
  ```ts
  // auth.ts
  partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken, user: state.user }),
  // PrivateRoute 注释：token is not persisted (short-lived) ← 与实现矛盾
  ```
- 影响：XSS 一旦得手即可拿到长效 refresh token（无 HttpOnly/SameSite 保护）；注释与现实相反会误导后续维护者。管理台含执行器注册、共享 token 等高危面，会话凭据保护等级应更高。
- 修复：access token 保留内存（zustand 非 persist 部分），refresh token 迁移到 HttpOnly Cookie（后端配合，admin-api 侧评审衔接）；短期至少修正注释并在 README 威胁模型中写明取舍。
- 工作量：M（含后端）/ S（仅修注释）

### F-07 ★【Bug/打磨】ErrorBoundary 崩溃兜底页显示 i18n 原始 key（待复核：i18next 语义推断）
- 位置：`apps/admin-web/src/components/ErrorBoundary.tsx:61`；`apps/admin-web/src/i18n/index.ts:56-66`
- 证据：
  ```ts
  const ErrorBoundary = withTranslation('errorBoundary')(ErrorBoundaryBase);
  // t('errorBoundary.title') 在 ns='errorBoundary' 下解析
  ```
  i18n init 只注册了 `zh: { translation: zh }` 一个命名空间（`i18n/index.ts:60-62`），`fallbackNS` 未设置；key `errorBoundary.title` 存在于默认 `translation` ns（`locales/zh.ts:1977-1979`）。
- 影响：组件树崩溃时用户看到的是 "errorBoundary.title / errorBoundary.reload" 原始 key，而非"页面出现异常/刷新页面"——最需要体面的时刻最掉链子。
- 修复：改为 `withTranslation()`（默认 ns，key 已带 `errorBoundary.` 前缀），或 init 增加 `fallbackNS: 'translation'`。
- 工作量：S

### F-08 ★【架构】三套 SSE 客户端并存 + 逐字重复的退避函数；日志流未复用 hooks
- 位置：`hooks/useMetricsStream.ts:35-39`、`hooks/useExecutionsStream.ts:35-42`、`pages/ExecutionDetailPage.tsx:180-211`
- 证据：
  ```ts
  // useMetricsStream.ts 与 useExecutionsStream.ts 各自导出一份完全相同的纯函数
  export function reconnectBackoffMs(attempt, base = 3_000, cap = 30_000) { ... }
  export function executionsReconnectBackoffMs(attempt, base = 3_000, cap = 30_000) { ... }
  ```
  ExecutionDetailPage 自管 EventSource（onmessage/手动 reconnectKey），与两个 hook 的"退避重建"模式互不复用。
- 影响：token 轮换重连、退避、畸形帧忽略等行为三处各自演化；改动（如 F-05 的 ticket 方案）需要改三处；测试也三份。
- 修复：抽 `createSseClient({ path, onFrame, onStatus })` 单一实现（连接/退避/token 注入统一），三个消费方只写事件语义；`reconnectBackoffMs` 收敛一份并保留既有两份测试锚定。
- 工作量：M

### F-09 【架构】`useExecutorLive` 条件调用 hooks（4 处 eslint-disable rules-of-hooks）
- 位置：`hooks/useExecutorLive.ts:186-215`
- 证据：
  ```ts
  if (!canStream) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- 条件在组件生命周期内恒定，见上
    const overlay = useMemo(() => ({}), []);
    ...
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 同上
  const { data: statsCache } = useQuery({...});
  ```
- 影响：为绕开"测试裸渲染无 QueryClientProvider 会 throw"而违反 hooks 规则。当前前提（Provider 不会中途挂/卸）在 React 18 成立，但任何"懒挂 Provider/条件 Provider"的重构都会踩运行时炸弹；60 行解释性注释本身即是复杂度信号。
- 修复：测试统一补 QueryClientProvider wrapper（一次性改 13 例），删除 safe 分支；或把流覆盖层拆成 `<ExecutorLiveOverlay>` 子组件隔离 hooks 链。
- 工作量：M

### F-10 ★【性能】`listAllTasks` 全量分页聚合被用于"上游依赖下拉"和 DAG；详情页挂载即拉全量任务表
- 位置：`api/tasks.ts:181-300`；`api/queries.ts` `useAllTasksForDag`；`pages/TaskFormPage.tsx:196-207`
- 证据：
  ```ts
  export const TASK_LIST_PAGE_CONCURRENCY = 6;
  export const TASK_LIST_MAX_PAGES = 100_000;   // 仅防畸形 total
  // useAllTasksForDag 挂在 TaskDetailPage deps Tab（TaskDependencyGraph），进入详情页即拉
  ```
- 影响：任务数到千级时，打开任务详情/新建任务页会瞬间发起 6 并发×N 页请求（每页 100 条全字段），后端 IO 与前端内存双压；而下拉只需要 `{id,name}` 两列。虽做了严格的分页一致性校验（值得肯定），但请求放大本身是架构性的。
- 修复：后端提供 `GET /tasks/options?fields=id,name` 轻量端点（或 `?brief=1`）；DAG 沿用全量但加 `staleTime` 已有（60s）+ 改为 deps Tab 激活时 `enabled` 门控。
- 工作量：M

### F-11 ★【性能】执行日志面板无虚拟化：最多 200 页×2000 行全部进 DOM
- 位置：`pages/ExecutionDetailPage.tsx:290-305`（fetchAllLogLines）、`256-280`（logSegments 逐行切 span）、`792-815`（`<pre>` 内渲染全部分段）
- 证据：
  ```ts
  for (let page = 0; page < LOG_MAX_PAGES; page++) {   // LOG_MAX_PAGES = 200
    const resp = await tasksApi.executionLogs(..., { fromLine, limit: LOG_PAGE_LIMIT }); // 2000/页
  ```
- 影响："加载完整日志"后最多 40 万行字符串 join + 逐行 split + span 流全部渲染，`maxHeight:500` 只是视觉滚动，DOM/React 元素数量不减——大日志场景主线程卡死、内存飙升。搜索高亮路径（buildLogSearchSegments）同量级。
- 修复：接入虚拟滚动（`@tanstack/react-virtual` 的流式行表，或保留纯文本 pre + 仅窗口化分段）；`fetchAllLogLines` 上限与后端对齐成显式常量并在 UI 标注截断。
- 工作量：M-L

### F-12 ★【Bug/性能】MainLayout 每秒 setInterval 触发整壳重渲染；时钟 locale 硬编码
- 位置：`layouts/MainLayout.tsx:187-190, 322-323`
- 证据：
  ```tsx
  const timer = setInterval(() => setCurrentTime(new Date()), 1000);
  ...
  const timeStr = currentTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  ```
- 影响：clock state 在 MainLayout 根组件上，每秒重跑 `buildMenuItems(t)`、面包屑、菜单 Tooltip 包装等全部 render 逻辑（子路由因元素引用稳定而 bailout，但壳层自身每秒全量 diff）；英文界面下时钟仍显示中文格式（i18n 绕过）。
- 修复：时钟抽成 memo 化的 `<HeaderClock/>`（内部 setInterval）；locale 取 `i18n.language`；展示粒度改为分钟即可把重渲降到 1/60。
- 工作量：S

### F-13 【Bug/待复核】MainLayout profile 拉取 effect 依赖含 `user`：role 缺失时可能请求循环
- 位置：`layouts/MainLayout.tsx:177-184`
- 证据：
  ```tsx
  useEffect(() => {
    if (!user?.role) { authApi.me().then((me) => setUser(me)).catch(() => undefined); }
  }, [user?.role, setUser, user]);
  ```
- 影响：若 `/auth/profile` 返回的 user **不含 role**（旧后端/降级响应），`setUser` → `user` 引用变化 → effect 重跑 → 无限请求循环。当前后端契约返回 role 则只跑两次（mount + setUser），但这依赖后端不变。
- 修复：deps 收敛为 `[user?.role, setUser]`（移除 `user`），并用 `user?.id`/请求 in-flight ref 防重入；或改为 TanStack Query 的 `enabled: !user?.role`。
- 工作量：S

### F-14 【i18n】ConfigProvider locale 恒为 zhCN：英文界面下分页/日期/确认框仍是中文
- 位置：`theme/ThemeProviders.tsx:70-75`
- 证据：
  ```tsx
  import zhCN from 'antd/locale/zh_CN';
  <ConfigProvider locale={zhCN} theme={buildAntdTheme(resolved)}>
  ```
- 影响：UI-10 已实现中英切换，但 antd 内建文案（Pagination、Table 空态、DatePicker、Modal okText 默认值等）不跟随；执行器列表/执行列表等重表格页在英文态下中外混杂。
- 修复：`useTranslation` 读 `i18n.language` 映射 `zhCN|enUS` 传入 ConfigProvider；测试补一条语言切换后分页器文案断言。
- 工作量：S

### F-15 【性能/打磨】antd 组件暗色主题下大量硬编码亮色（约 101 处 hex），抽查 4 个代表性场景
- 位置：
  - `pages/TaskListPage.tsx:422-423` 批量操作条：`background: '#e6f4ff', border: '1px solid #91caff'`，图标 `color: '#1677ff'`（:423）
  - `pages/TaskDetailPage.tsx:369` 成功率色：`'#52c41a' : '#fa8c16' : '#ff4d4f'`；`629` 建议值 `color: '#52c41a'`
  - `pages/ExecutionDetailPage.tsx:828-829` AI 分析卡：`borderColor: '#1677ff'` + `background: 'linear-gradient(90deg, #e6f7ff, #f0f5ff)'`
  - `pages/AppDeploymentPage.tsx` ExecutorCard：`color: '#888'`、`background: '#f9fafb'`
- 影响：暗色主题（UI-02 已建成 token 体系）下这些区域出现刺眼亮块/低对比文字；同时 `#1677ff`（旧 antd 蓝）与设计强调色 `#22C55E` 并存，品牌色不一致（MainLayout.tsx:373,561 用的绿，LoginPage.tsx:82,143 用蓝紫渐变）。
- 修复：批量替换为 `theme.useToken()` 语义 token（colorSuccess/colorWarning/colorError/colorPrimaryBg 等）或 `--color-*` CSS 变量；品牌渐变收敛到 tokens.ts 单一定义。
- 工作量：M

### F-16 【架构】数据获取双栈：同页混用 TanStack Query 与 ahooks useRequest
- 位置：`pages/ExecutorDetailPage.tsx:6-7,105-156`（同一组件内 `useQueryClient` + 5 个 `useRequest` 写操作）；`pages/RegistryPage.tsx:9`、`pages/NotificationSettingsPage.tsx:4`（整页 useRequest）
- 证据：
  ```ts
  import { useRequest } from 'ahooks';
  import { useQueryClient } from '@tanstack/react-query';
  ```
- 影响：读侧已迁 Query（FEAT-17），写侧仍 useRequest：错误 toast 语义（useRequest 自带 onError vs Query 需手写）、竞态取消、缓存失效模式两套并存；新人难以判断"该用哪个"。queries.ts 头注已声明"低频页保留 useRequest"，但 ExecutorDetailPage 属高频页且同页混排。
- 修复：写操作迁 `useMutation`（onSuccess/onError 与现有 message 语义一一对应），ahooks 依赖最终可从 admin-web 移除（全仓仅 3 页 import）。
- 工作量：M

### F-17 【Bug】ExecutionDetailPage 挂载即双重请求 report 端点（useQuery + effect refetch）
- 位置：`pages/ExecutionDetailPage.tsx:168-177`
- 证据：
  ```ts
  const { data: reportPayload, ..., refetch: refreshReport } = useExecutionReport(taskId, execId);
  useEffect(() => { void refreshReport(); }, [data?.status, refreshReport]);
  ```
- 影响：`refetch()` 默认 `cancelRefetch:true`——mount 时 useQuery 的首次请求被取消重发（网络层面双发一废）；状态每变化再 refetch 属设计意图，但 mount 双发是浪费，还顺带 abort 重试语义复杂化。
- 修复：去掉该 effect 的 mount 触发（用 `data?.status` 变化判重：首值为 undefined 时跳过），或改为 `queryClient.invalidateQueries({ queryKey: queryKeys.executions.report(...) })` 语义化失效。
- 工作量：S

### F-18 【Bug/打磨】剪贴板写入无错误处理（3 处）与 1 处正确写法并存
- 位置：`pages/ExecutionDetailPage.tsx:728-729`（日志复制）、`pages/ExecutorInstallWizardPage.tsx:110-117`（安装命令复制）、`pages/settings/index.tsx` TokenSection 复制；对照正确写法 `pages/ExecutionDetailPage.tsx:580-583`（traceId 复制有 .then(success, fail)）
- 证据：
  ```ts
  navigator.clipboard.writeText(displayLogs);
  message.success(t('execDetail.log.copied'));
  ```
- 影响：非 HTTPS/iframe 权限受限场景 `writeText` reject → 未处理 rejection，且**成功提示照弹**（实际没复制）。
- 修复：统一封装 `copyText(text): Promise<boolean>`（降级 `document.execCommand('copy')`），三处收敛。
- 工作量：S

### F-19 【打磨/桌面】59k 行 / 2.1MB executor-node 内嵌 bundle 提交进 git，与 apps/executor-node 双源漂移
- 位置：`apps/executor-desktop/resources/executor-node/index.js`（59,099 行）；`apps/executor-desktop/package.json`（`build:executor: bash scripts/bundle-executor.sh`）
- 影响：bundle 是 `apps/executor-node` 的编译产物却以源码形态入库：每次 executor-node 改动需人工重打（提交 8080f3a 便是"desktop 内嵌 bundle 重打"），漏打即线上执行器行为落后于平台契约；diff 噪音巨大；两份代码在评审/审计时也容易只看其一。
- 修复：CI 构建 desktop 时执行 `build:executor`，`resources/executor-node/` 改为构建产物出库（gitignore + artifact/registry 拉取）；至少加 CI 校验"bundle 与 apps/executor-node 构建产物哈希一致"的守卫。
- 工作量：M

### F-20 【打磨/桌面】`history-store.ts` 死代码模块（无任何 importer）
- 位置：`apps/executor-desktop/src/main/history-store.ts`（99 行整模块）
- 证据：全仓 grep `history-store` 仅 `notifier.ts:109` 注释提及；实际 history IPC 在 `ipc-handlers.ts:142-172` 直接读 `workDir/meta`。
- 影响：两套"历史记录"心智（JSON store vs meta 目录）并存，误导后续开发；MAX_RECORDS=500 的声明只活在注释里。
- 修复：删除模块；若需要 500 条上限语义，把扫描上限放进 `ipc-handlers.history:get`（读 meta 目录时 slice）。
- 工作量：S

### F-21 【打磨/桌面】渲染进程 `React.lazy` 在 render 体内创建——每次 App 渲染产生新组件类型
- 位置：`apps/executor-desktop/src/renderer/App.tsx:18-22`
- 证据：
  ```tsx
  if (hash === 'wizard') {
    const Wizard = React.lazy(() => import('./pages/Wizard'));
  ```
- 影响：App 目前无 state 所以只 render 一次，但 StrictMode 双渲染下第二次 render 生成不同 lazy 类型导致 Wizard 子树重挂载；未来 App 加任何 state（如语言/窗口态）都会让 Wizard 每次重挂、输入丢失。
- 修复：`const Wizard = React.lazy(...)` 提升到模块顶层。
- 工作量：S

### F-22 【Bug/打磨/桌面】StatusWindow 启动/停止无错误兜底，IPC reject 时按钮永久 disabled
- 位置：`apps/executor-desktop/src/renderer/pages/StatusWindow.tsx:262-269`
- 证据：
  ```ts
  async function handleStart() {
    setActing(true);
    await window.electronAPI.startExecutor();   // 无 try/finally
    setActing(false);
  }
  ```
- 影响：`executor:start` handler 一旦 reject（如配置缺失抛错），`acting` 永久 true，启动/停止按钮永久禁用，只能重启应用。
- 修复：`try/finally` + 失败时在页内显示错误（桌面端无 toast 体系，可用状态条）。
- 工作量：S

### F-23 【打磨】admin-web 根 `App.tsx` 死代码
- 位置：`apps/admin-web/src/App.tsx`（渲染 null，无任何 import 方）
- 证据：`export default function App() { return null; }`，`main.tsx`/`router.tsx` 均未引用。
- 修复：删除。
- 工作量：S

### F-24 【打磨】MainLayout 通知 Badge 恒为 0 + 帮助按钮无 onClick
- 位置：`layouts/MainLayout.tsx:505-512`（帮助按钮无任何 handler）、`516-528`（`<Badge count={0} dot>`）
- 影响：帮助按钮点击无反应（纯摆设，有 aria-label 却无行为）；通知入口的 Badge 永远是空点/无点，属占位死 UI。
- 修复：帮助接文档链接（`window.open` 外链需按桌面/web 分流）或暂时移除；通知 Badge 接真实未读数或移除。
- 工作量：S

### F-25 【打磨】头部搜索按钮 tooltip 硬编码 "Ctrl K"，Mac 用户实际是 ⌘K
- 位置：`layouts/MainLayout.tsx:494`
- 证据：`<Tooltip title="Ctrl K">`（CommandPalette 支持两者，MainLayout.tsx:486 判断 `e.metaKey || e.ctrlKey`）。
- 修复：i18n key 按平台渲染 `⌘K` / `Ctrl K`。
- 工作量：S

### F-26 【打磨】24 处 `zh-CN` 硬编码 locale + 两个"相对时间"实现重复
- 位置：grep 计 24 处（ExecutionDetailPage、ExecutorDetailPage:65-66,198,220、AppDeploymentPage:deployedAt 列、utils/timeFormat.ts:34,55 等）；`pages/ExecutorDetailPage.tsx:30-39` 自写 `relativeTime()` 与 `utils/timeFormat.ts` 的 `formatRelativeTime()` 语义重复（且前者无 key 回退时输出中文硬编码）。
- 影响：语言切换不生效；同一时间字段在不同页格式/相对文案不一致（如 ExecutorDetailPage 起始时间 `toLocaleString('zh-CN')` vs TaskDetailPage `formatDateTime+formatRelativeTime` 组合）。
- 修复：全部收敛到 utils/timeFormat 并接 `t`；删除 ExecutorDetailPage 私有实现（顺带 F-16 时改）。
- 工作量：M

### F-27 【打磨】TaskDetailPage「失败次数」可显示小数
- 位置：`pages/TaskDetailPage.tsx:378`
- 证据：
  ```ts
  value={taskStats.totalRuns > 0 ? Number((taskStats.totalRuns * (1 - (taskStats.successRate ?? 0) / 100)).toFixed(1)) : 0}
  ```
- 影响：totalRuns=3、successRate=66.7% 时统计卡显示 "1.0"？实际会显示如 "1"（0.999→1）但 3×(1-66.6%)=1.002→"1"；totalRuns=7、rate=80% → "1.4 次"——次数出现小数，语义错误。
- 修复：直接 `Math.round(...)`（或由后端回传 failed 计数）。
- 工作量：S

### F-28 【打磨】TaskFormPage「保存为模板」三处坏味道：死三元、`as never` 断言、cron 单位解析脆弱
- 位置：`pages/TaskFormPage.tsx:399-403, 1121`；`pages/TaskDetailPage.tsx:648`；`pages/TaskFormPage.tsx:670-677`
- 证据：
  ```ts
  tplForm.setFieldsValue({
    name: form.getFieldValue('description') ? undefined : undefined, // 两个分支同为 undefined
  });
  okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' } as never}
  parser={v => v ? Number(v.replace(t('taskForm.field.fixedRate.minuteUnit'), '')) * 60 : 60}
  ```
- 影响：死三元直接违背代码意图（原意疑似"从 description 取默认名"）；`as never` 为塞 data-testid 绕类型（antd v6 的 Modal okButtonProps 支持 data-testid，应可通过组件 prop 类型补丁或声明合并解决）；fixedRate 解析器把用户键入的裸数字当"分钟"，且依赖翻译文本做 replace（en 单位 " min" 与 zh "分钟" 路径不同）。
- 修复：删死三元/落实默认值；data-testid 改包一层或提 antd 类型 PR；fixedRate 改纯数字 InputNumber + 后缀文案（不走 formatter/parser 往返）。
- 工作量：S-M

### F-29 【打磨/架构】api 层残留死代码：重复方法与硬编码中文 label
- 位置：`api/tasks.ts:26-31`（`TIMEOUT_ACTION_OPTIONS` label 中文硬编码，实际 UI 全部经 `TIMEOUT_ACTION_LABELS(t)` 映射，此 options 的 label 无消费）、`api/tasks.ts:371-385`（`executionsWithStatus` 与 `executions` 逐字节相同）
- 修复：删 `executionsWithStatus`（调用方 queries.ts `useExecutionRetryChain` 改 `executions`）；`TIMEOUT_ACTION_OPTIONS` 移到 pages/timeout-policy.ts 或去 label。
- 工作量：S

### F-30 【打磨】`THEME_INIT_SCRIPT` 导出与 index.html 内联脚本双事实源
- 位置：`theme/tokens.ts:107`（导出无任何消费方）；`apps/admin-web/index.html:13-24`（同一逻辑内联）
- 影响：防 FOUC 逻辑存两份，改存储键/判定规则时容易漏改一份（现靠注释约定）。
- 修复：删 tokens.ts 导出，或构建期把脚本注入 index.html（vite transformIndexHtml）。
- 工作量：S

### F-31 【打磨】vite `define` 注入 `process.env.VITE_*` 无任何消费方
- 位置：`vite.config.ts:46-49`；对照消费点全部走 `import.meta.env`（client.ts:5-6、registry.ts:33）。
- 修复：删除 define 块；`.env` 文件已能覆盖 `import.meta.env.VITE_*`。
- 工作量：S

### F-32 【架构】错误重试双层叠加：axios 拦截器 1 次 + TanStack Query 2 次
- 位置：`api/client.ts:128-135`（GET 5xx 自动重试 1 次）；`main.tsx:32-40`（`retry: 2`）
- 证据：
  ```ts
  if (isSafeMethod && originalRequest._retryCount < 1 && (!err.response || (status >= 500 && status < 600))) {
    originalRequest._retryCount++;
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    return _client(originalRequest);
  }
  ```
- 影响：一次失败的 GET（5xx）最多打 3 发请求（axios×2 × query retry 语义叠加），且 axios 层固定 1s 退避与 Query 的指数退避不协调；写操作 toast（拦截器）+ Query 错误页（StateError）可能出现"页内错误块 + toast"双报。
- 修复：重试职责归一给 Query（axios 层去掉 5xx 重试，仅保留 401 刷新与 toast 兜底），或至少把 axios 重试限制在非 Query 场景（用 config 标记）。
- 工作量：S-M

### F-33 【打磨】`<a onClick>` 无 href 链接 11 处——键盘不可达、读屏不识别
- 位置：`ExecutionDetailPage.tsx:535`、`:885`；`DashboardPage.tsx:340,368,383,409`；`TaskListPage.tsx:222`；`ExecutorDetailPage.tsx:214,231`；`ApplicationDetailPage.tsx`（tasks 表格）等
- 证据：`<a onClick={() => nav(...)}>`（无 href/role/tabIndex）
- 影响：Tab 聚焦不到、Enter 无法触发；与本项目 UI-12 已建立的高 a11y 标准（skip-link、aria 系列）不一致。
- 修复：统一改 `Link`（react-router）或 `role="link"` + `tabIndex={0}` + onKeyDown；grep 清零。
- 工作量：S

### F-34 【打磨】AppDeploymentPage 轮询未做可见性判断 + 每拍全量拉 executors
- 位置：`pages/AppDeploymentPage.tsx:124-130`（`setInterval(fetchAll, 3000)`，无 `visibilityState` 守卫）；`fetchAll` 内 `Promise.all([deploymentsApi.list, executorsApi.list()])`（:104-108）
- 影响：后台标签页仍每 3s 打两个端点（对照 ExecutionDetailPage.tsx:216-222 与 ExecutionsPage.tsx:102-107 都做了 visible 判断——本项目已有标准但此页漏掉）；执行器列表 3s 全量刷新本可由既有 `useExecutorGroups` 式 5min staleTime 承担。
- 修复：补 visible 守卫；executors 改独立低频轮询或复用 SSE 覆盖层（F-08/F-09 基建已有）。
- 工作量：S

### F-35 【打磨】时长/时间格式三套并存
- 位置：`utils/timeFormat.ts:44-52`（`formatDuration` 无小时档，2h 显示 "120分0秒"）；`pages/ExecutorDetailPage.tsx:221`（`v>=1000 ? s : ms` 独立格式）；`pages/TaskListPage.tsx:264-270`（schedule 列自行换算）
- 影响：同一"耗时"字段三处三种显示法；超过 1 小时的执行在执行详情/列表可读性差。
- 修复：formatDuration 补小时档并全站收敛（与 F-26 同批改）。
- 工作量：S

### F-36 【Bug/待复核】ExecutorDetailPage 编辑弹窗可能把整个 executor 快照随 onFinish 提交
- 位置：`pages/ExecutorDetailPage.tsx:242,480-486`
- 证据：
  ```tsx
  <Button onClick={() => { editForm.setFieldsValue(executor); setEditOpen(true); }}>
  ...
  <Form form={editForm} layout="vertical" onFinish={updateExecutor}>
  ```
- 影响：`setFieldsValue(executor)` 把 id/status/lastHeartbeat/cpuUsage 等全部写入表单 store；rc-field-form `onFinish` 返回的是整仓值（含未注册字段），请求体可能携带大量非 DTO 字段。后端若 `forbidNonWhitelisted` 会 400，若仅 whitelist 则静默剥离（现为后者，故未爆）——但对齐 F-28 的表单卫生问题。
- 修复：`setFieldsValue` 只放 4 个可编辑字段（groupName/tags/description/maxConcurrentTasks）。
- 工作量：S

### F-37 【打磨/桌面】ipc-handlers 大量函数体内 `require('fs')/require('path')`，顶部未 import
- 位置：`apps/executor-desktop/src/main/ipc-handlers.ts:145-146, 165-166, 184-185, 212-214, 258, 313, 326, 335-336, 351`
- 影响：风格噪音（文件顶部明明有 `import * as http`/`import * as path`），且 main 进程无打包懒加载收益，纯历史遗留。
- 修复：统一顶部 import。
- 工作量：S

### F-38 【测试缺口】
- 位置：`apps/admin-web/src/__tests__/`（79 文件）
- 覆盖较好：SSE 两个 hook（use-metrics-stream / use-executions-stream）、命令面板、a11y 系列（a11y-login/a11y-task-form/a11y-focus）、RBAC（requireAdmin/application-list-rbac/executor-pull-gating）、错误态系列（ui16×3 / *-error-state×4）、SSE 断流（execution-detail-sse）、分页聚合校验（tasks.api.test）。
- **缺口（核心交互无任何专项测试）**：
  1. `TaskListPage` 克隆链路（F-03 的字段丢失正是无测试暴露的）——task-list-deep.test.tsx 未覆盖 clone payload；
  2. `ParamsEditor` 受控/预填行为（F-02）；
  3. `GlueEditor`（保存/模板/语言切换，Monaco 可 mock Editor）与 `CronHelper`、`ExecutionCompare`、`TaskDependencyGraph` 组件面（仅 dag-layout 纯函数有测）；
  4. `ErrorBoundary` 崩溃渲染面（F-07 无测试兜底）；
  5. `client.ts` 的 401→refresh→重放与并发去重（client.test.ts 存在但未覆盖 refreshPromise 并发分支与 "Auth session changed" 丢弃路径——待复核，文件未逐行读）；
  6. 桌面端 renderer（仅 `test:renderer` 自跑 selftest.mjs 与 e2e smoke，无组件级测试）。
- 修复建议：把 F-02/F-03/F-04 的修复各配一条回归测试先行（都是纯交互，jsdom 可测）。
- 工作量：M

### 其他核对项（未构成发现，留档）
- `grep TODO|FIXME|HACK`：admin-web/src **0 命中**；`dangerouslySetInnerHTML` **0 命中**（日志/运行手册均为纯文本渲染，无 markdown 库，无 XSS 注入面）。
- `console.log` 残留：admin-web 业务代码 0（ErrorBoundary 的 console.error 合理）；desktop selftest 文件内的 console 属自测输出。
- `it.skip/describe.skip/test.todo`：0 命中。
- 桌面端安全基线良好：`contextIsolation: true + nodeIntegration: false`（window-manager.ts:26-33 统一 webPreferences）、renderer 拿不到 token（`getAllMasked`，ipc-handlers.ts:33-36,108-114）、`log:read/open-file` 有 executionId 白名单 + 路径域校验 + 扩展名白名单（path-domain.ts + ipc-handlers.ts:174-207,246-261）、updater 仅生产启用 + `isNewerVersion` 兜底 + autoDownload=false（updater.ts:126-182）。electron-updater 自带 latest.yml sha512 校验，签名校验依赖 provider 默认行为（Linux 未配置自定义证书，GitHub provider 校验发布资产哈希）——可接受。
- 内嵌 bundle 的 `writeExecMeta` startTime 为 unix ms 数字（bundle 行 50450-50461），`ipc-handlers.history:get` 的数值排序（ipc-handlers.ts:156）正确——曾怀疑的 ISO 字符串相减问题不成立。

---

## 三、架构升级建议专节

### R1. SSE 客户端统一 + 传输安全升级（对应 F-05/F-08/F-34）
- 收益：三处 EventSource → 一个 `sseClient`（自动退避/token 注入/状态机/测试桩）；随后可在同一层完成"query-string token → 短效 ticket/Authorization header"的升级，消除 token 入日志面；AppDeploymentPage 等后续实时需求直接复用。
- 风险：SSE 是三条核心实时链路（Dashboard/执行列表/日志流），迁移需保持既有 queryKey 写入与 invalidate 语义不变；建议按 hook 逐个灰度。
- 步骤：①抽 `createSseClient`（保留 `reconnectBackoffMs` 纯函数与两份现有测试锚定）→ ②useMetricsStream/useExecutionsStream 改薄壳 → ③ExecutionDetailPage 日志流迁移（保留 reconnectKey 语义为 `sseClient.reconnect()`）→ ④与 admin-api 约定 ticket 端点，替换 query 串鉴权。
- 工作量：M-L

### R2. 数据层收口：Query 全站化 + 重试职责归一（对应 F-16/F-32）
- 收益：消灭 useRequest/Query 双栈（3 页 + ExecutorDetailPage 写操作）；5xx 重试只在一层发生，错误呈现统一为"页内 StateError + 写操作 toast"；最终从 admin-web 移除 ahooks 依赖（减小 bundle 与心智负担）。
- 风险：低——写操作是局部改动；注意 useRequest 的 `manual` 语义对应 `useMutation`，onSuccess 里的 message/刷新逻辑逐条搬运即可。
- 步骤：①ExecutorDetailPage 5 个写操作 → useMutation → ②RegistryPage/NotificationSettingsPage 整页迁移 → ③client.ts 去掉 5xx 自动重试（保留 401 刷新），main.tsx 的 `retry` 保持 2 → ④CI 加 `grep -r "from 'ahooks'" src == 0` 守卫。
- 工作量：M

### R3. Monaco 本地化与编辑器资源治理（对应 F-01）
- 收益：Glue 编辑器在内网/离线可用；bundle 体积可控（monaco 按语言 worker 分包，随 GlueEditor 懒加载）；消除 CDN 供应链与版本漂移。
- 风险：构建配置一次性改动，需验证 3 种语言语法高亮与 worker 正常；vite 下 monaco 打包有已知坑（worker 路径），选型 `vite-plugin-monaco-editor` 成熟方案可降险。
- 步骤：①`loader.config({ monaco })` + `MonacoEnvironment.getWorker` → ②vite manualChunks 让 monaco 真正进独立 chunk（当前死配置）→ ③GlueEditor 所在页已有路由级 lazy，确认 chunk 仅在此页加载 → ④离线环境冒烟（断网跑 dev+build）。
- 工作量：M

### R4. 表单与提交载荷卫生（对应 F-02/F-03/F-28/F-36）
- 收益：消除"显示≠提交"类静默错误（模板预填、克隆丢字段、全字段快照提交）；`as never` 清零；后续新表单有可抄的正例。
- 风险：低；克隆/模板是高频运维动作，改后需补回归测试（F-38 已列为缺口）。
- 步骤：①ParamsEditor 全受控 → ②克隆 payload 白名单化（复用 task-template-extract 的提取思路 + 单测锚定字段清单）→ ③ExecutorDetailPage setFieldsValue 收窄 → ④grep `as never|as any` 清零。
- 工作量：M

### R5. 桌面端 bundle 出库与内嵌资源管道（对应 F-19/F-20）
- 收益：executor-node 与 desktop 内嵌副本不再靠人工同步；仓库瘦身 2MB×每轮重打；版本可追溯（bundle 带 git sha 注释/校验文件）。
- 风险：CI 依赖链变长（desktop 打包前置 executor-node 构建）；离线构建场景需本地 fallback。
- 步骤：①`scripts/bundle-executor.sh` 产物加 sha256 清单 → ②desktop CI job 先构建 executor-node 再打包，`resources/` gitignore → ③删除 history-store.ts 死模块 → ④release 说明标注内嵌 executor-node 版本号（读 apps/executor-node/package.json version）。
- 工作量：M

---

## 四、待复核项

| # | 事项 | 原因 |
|---|---|---|
| 1 | F-07 ErrorBoundary 显示原始 key | 基于 i18next "命名空间不存在→key 原样返回、无 fallbackNS" 的标准语义推断；未运行验证。验证法：本地渲染抛错组件看兜底文案。 |
| 2 | F-13 MainLayout profile 循环请求 | 依赖"后端 `/auth/profile` 是否恒返回 role"——admin-api 侧由另一位评审确认；前端防御性修复无论如何都建议做。 |
| 3 | F-36 编辑弹窗全字段提交 | rc-field-form onFinish 返回整仓值（含未注册字段）的行为是库的既有语义，但实际请求体需抓包确认；后端 whitelist 行为属 admin-api 评审范围。 |
| 4 | F-38 client.ts 并发 refresh 分支覆盖度 | `client.test.ts` 未逐行阅读，仅确认存在；refreshPromise 去重/"Auth session changed" 丢弃是否被测待查。 |
| 5 | F-05 SSE token 的实际日志暴露面 | 取决于生产 nginx/ingress 的 access log 策略（`$request_uri` 是否记录），需运维侧确认。 |
| 6 | F-27 失败次数小数 | 需确认后端 `/tasks/:id/stats` 是否本就返回整型 failed 字段（若有则前端纯属多余换算）。 |
| 7 | design-system/ 是否需版本对齐 | 仅确认 admin-web/桌面端以"MASTER.md 语义"方式引用（index.css、theme/tokens.ts、app.css 注释），无构建引用；令牌漂移（如 #22C55E vs #1677FF 并存，见 F-15）建议 design-system 侧一并评审。 |

---

## Top 10 加重说明（汇总）

| 排名 | 编号 | 一句话 |
|---|---|---|
| 1 | F-01 | Monaco 走公网 CDN，内网部署下 Glue 编排整体不可用，monaco 依赖是死配置 |
| 2 | F-02 | ParamsEditor 半受控：模板预填参数看不见但会被提交——显示与数据静默不一致 |
| 3 | F-03 | 任务克隆静默丢失超时策略/维护窗口/运行手册/亲和标签 6 类字段 |
| 4 | F-04 | AI 调度建议「应用」按钮是死链（suggestCron 无人消费） |
| 5 | F-06 | access+refresh token 持久化 localStorage，XSS 可窃取长效会话 |
| 6 | F-05 | 三条 SSE 长连接把 access token 放进 URL 查询串（代理日志可留存） |
| 7 | F-11 | 执行日志面板无虚拟化，"加载完整日志"最多 40 万行全量进 DOM |
| 8 | F-07 | 崩溃兜底页显示 "errorBoundary.title" 原始 key，最需要体面的时刻最掉链子 |
| 9 | F-12 | MainLayout 每秒 setInterval 重渲整个壳层，且时钟 locale 硬编码中文 |
| 10 | F-10 | listAllTasks 全量分页聚合（6 并发）被用于表单下拉/详情页 DAG，任务量增长即请求风暴 |

## 计数

- 发现总数：**38**（F-01 ~ F-38，不含"其他核对项"）
- P0：**1**（F-01）；P1：**6**（F-02、F-03、F-04、F-05、F-06、F-07）；P2：**13**（F-08~F-20）；P3：**18**（F-21~F-38）
- 类别分布：Bug 11 / 安全 3 / 性能 5 / 架构 6 / 打磨 12 / 测试 1
