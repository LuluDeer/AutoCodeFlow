# 公共组件、布局、主题与 i18n

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/components/、src/layouts/、src/theme/、src/i18n/、src/locales/、src/styles/、src/index.css

## layouts/MainLayout.tsx（604 行）

- 结构：antd Layout
  - Sider：220px、可折叠；折叠态持久化 localStorage `autoflow-sider-collapsed`（读取用导出的 `readCollapsedPreference`）
  - Header：56px sticky——移动端汉堡、面包屑、实时时钟、主题三态按钮、⌘K 搜索、帮助、ADMIN-only 通知铃铛、用户下拉
  - Content：`id="main-content"` + Outlet
- 菜单：`buildMenuItems(t)` 构造 6 组 12 项（overview / tasks / executions / executors / applications / system）
  - 分组用 antd submenu 形态（可折叠/展开并持久化 `autoflow-menu-open-keys`；默认展开任务/执行两组）
  - `readMenuOpenKeys(validKeys)` 过滤 IA 调整后的残留脏键
- 角色过滤：`ADMIN_ONLY_MENU_KEYS = /executor-packages、/audit、/users、/notifications` 对非 admin 隐藏
  - R6 回归守卫：isAdmin 放行条件必须在分组化后保留——无条件过滤会把管理员菜单一并藏掉（e2e-17 实证）
- role 补齐：登录响应只含 token，`user?.role` 缺失时 effect 调 `authApi.me()` 回填 store（覆盖刚登录 + 旧 localStorage 会话两场景）
- 全局命令面板：`<CommandPalette open onOpenChange>`（FEAT-09）
- 移动端（UI-09）：≤768px 侧边栏抽屉化（纯 CSS 媒体查询 + `mobile-sider-open` 类挂根 Layout）；路由变化自动收起；Esc 收起并把焦点归还汉堡按钮
- 可访问性（UI-12）：skip-link「跳到主要内容」、nav/main landmark、图标按钮补 aria-label、受控 Dropdown 播报 aria-expanded

## src/components/ 清单

| 组件 | 行数 | 职责 |
|---|---|---|
| `CommandPalette.tsx` | 805 | FEAT-09 全局搜索（详见下） |
| `PrivateRoute.tsx` / `RequireAdmin.tsx` | 14/47 | 路由守卫（详见 [routing-and-auth.md](routing-and-auth.md)） |
| `GlueEditor.tsx` | 157 | Monaco 封装（@monaco-editor/react）；LANGUAGE_MAP：python→python、javascript/node→javascript；加载 glue 源码并保存（tasksApi.updateGlue） |
| `TaskDependencyGraph.tsx` | 258 | FEAT-02 任务依赖 DAG 可视化（详见下） |
| `dag-layout.ts` | 137 | DAG 布局纯函数（单测 dag-layout.test.ts） |
| `StateError.tsx` | 90 | 统一错误态：error 字段直接透传（useRequest/React Query）+ 复制错误（copyErrorText）/重试按钮，适配暗色 token |
| `PageHeader.tsx` | 75 | 页头：Title + Text + 面包屑（Crumb{title,to?}）+ extra |
| `PageSkeleton.tsx` / `PageFallback.tsx` | 41/13 | 页面骨架 / 路由 lazy Suspense 兜底（router.tsx withSuspense） |
| `ErrorBoundary.tsx` / `ErrorFallback.tsx` | 64/91 | react-error-boundary 根级边界（main.tsx）与降级 UI |
| `ExecutionReportPanel.tsx` / `ExecutionCompare.tsx` | 183/183 | 执行报告面板 / 两次执行（或版本 compareVersions）对比 |
| `ArtifactsList.tsx` | 109 | 产物清单（props 或自取数双分支）+ blob 下载 |
| `ParamsEditor.tsx` / `CronHelper.tsx` / `AlarmConfig.tsx` | 100/102/59 | 任务表单配件：params 键值编辑 / cron 编写辅助 / 告警配置 |
| `components/dashboard/`（5 件） | 69–148 | KpiSparkline、FailureTopList、ExecutorHeatBars、SchedulerLatencyCard、DashboardEmptyGuide |
| `components/executor/`（4 件） | 56–239 | BatchActionBar、ExecutorCardGrid、GroupFilterBar、ViewToggle |
| `components/task-form/TriggerPreview.tsx` | 144 | 未来 5 次触发预览展示（计算在 utils/trigger-preview.ts） |

### CommandPalette 数据契约（文件头注释明示）

- 任务：GET /tasks?page=1&pageSize=50&name=<kw>——name 为后端 ILIKE 模糊参数（唯一带服务端过滤的分组），前端再做客户端兜底包含匹配
- 执行器：GET /executors（全量数组）；应用：GET /applications（全量数组）
- 执行记录：GET /tasks/executions/all?page=1&pageSize=5（后端固定 createdAt DESC = 最近 5 条），按 taskName 包含匹配后直达 /tasks/:taskId/executions/:execId
- 取舍：四路并行 + 防抖 300ms + 序号守卫（防乱序覆盖）；「客户端包含匹配已返回页数据」，非后端全文检索

### TaskDependencyGraph

- 零新依赖：纯 CSS 定位 + SVG 连线；布局逻辑全部在 dag-layout.ts（纯函数、单测覆盖），组件只负责取数与绘制
- NF-02 编排动作区：「从根触发整条链」（批量触发本任务 + 全部下游，复用 POST /tasks/batch/trigger；后端逐个 trigger，部分失败不影响其他）
- 真实下游触发顺序由依赖扇出语义（上游全部 SUCCESS）兜底，无需前端排序保证

## 主题（src/theme/）

- `tokens.ts`（107 行）：UI-01 设计令牌单一常量源（design-system/autocodeflow/MASTER.md 的程序化镜像）
  - `DESIGN_TOKENS`：accent #22C55E（antd colorPrimary/colorLink/colorInfo/colorSuccess 与强调色共源）、destructive #EF4444、primaryDark #0F172A、muted #1A1E2F 等
  - `DARK_TOKENS / LIGHT_TOKENS` 两面：仅背景/前景/边框切换，对比度 ≥4.5:1
  - `FONT_STACKS`（Fira Sans/Fira Code，@fontsource 引入）、`CHART_COLORS`（recharts）
  - antd ConfigProvider token 与 index.css 的 CSS 变量都从本文件消费，防两处手写漂移
- `ThemeProviders.tsx`（86 行）：`buildAntdTheme(resolved)`（darkAlgorithm/defaultAlgorithm + token 映射，borderRadius 8）与 `ThemedProviders`（ConfigProvider + antd App + zh_CN locale）；`wireThemeSync()` 在 main.tsx 模块加载期接线一次
- 样式组织：
  - 全局 `src/index.css`：CSS 变量、--shadow-sm、移动端媒体查询
  - `src/styles/a11y-focus.css`：UI-12 焦点环与 skip-link（独立文件，避免与 index.css 在途改动冲突）
  - 构建：vite.config.ts manualChunks 拆 vendor-react / vendor-charts / vendor-monaco / vendor-query / vendor-utils，lazy 页面只共享实际用到的库片段

## i18n（src/i18n/index.ts + src/locales/）

- 单一 i18next 实例 + react-i18next
  - 语言优先级：localStorage `autoflow-lang` > 默认 `zh`（默认中文是产品基线——未迁移页全硬编码中文）
  - 不引 browser-languagedetector（零新增依赖，行为可测——测试环境 navigator 为 en-US 时仍保持 zh）
  - fallbackLng `zh`（清净回退，避免「英文环境看到 key 名」）；`useSuspense: false`
- `locales/zh.ts`（2089 行）与 `locales/en.ts`（2079 行）扁平 key；`setLanguage(lng)` 切换并持久化；`availableLanguages` 供切换器
- 组件内 `import '../i18n'`（模块副作用初始化）+ `useTranslation()` 读 key；key 按页面前缀分组（taskList.* / sysSettings.* / appDeploy.* / eventSub.* / nav.* 等）
- 渐进迁移：未迁移页仍硬编码中文，逐页把文案搬进 locales 并对齐测试（UI-10）

## 常见改动场景（接入公共设施）

- 新页面：`PageHeader`（面包屑 + extra）+ `PageSkeleton`（loading）+ `StateError`（错误）；lazy 路由自动获得 PageFallback
- 新全局入口：挂 MainLayout 头部，或 CommandPalette 的导航/搜索项（注意其数据契约是四路并行匹配）
- 加文案：中文先入 locales/zh.ts，对齐 en.ts，key 用页面前缀

## 与其他文档的关系

- 被依赖：所有页面（见 [pages-*.md](README.md)）；MainLayout 依赖 [store-and-hooks.md](store-and-hooks.md)（auth/theme store）
- dag-layout / trigger-preview 纯函数单测在 `src/__tests__/`（见 [e2e-and-conventions.md](e2e-and-conventions.md)）

## 相关文档

[README](README.md) · [routing-and-auth.md](routing-and-auth.md) · [新增前端页面流程](../../08-workflows/add-new-web-page.md)
