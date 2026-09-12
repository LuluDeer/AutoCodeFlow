# 状态管理（store/）与自定义 hooks

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/store/auth.ts、src/hooks/、src/theme/store.ts、src/api/queries.ts、src/main.tsx

## 状态管理方案（以代码为准）

三层分工，无 Redux/MobX：

1. **zustand**（^5.0.14，仅两处）：`store/auth.ts`（鉴权，persist 到 localStorage `autoflow-auth`）与 `theme/store.ts`（主题，persist 到 `autoflow-theme`）。小而持久化的全局态用 zustand。
2. **@tanstack/react-query**（^5.101.0）：服务端状态唯一层。全局默认在 `main.tsx` 的 QueryClient（ARCH-26，注释明示理由）：`staleTime: 30_000`（对齐原 Dashboard 30s 轮询节奏）、`retry: 2`、`refetchOnWindowFocus: false`（多 Tab 并开防请求风暴）、refetchOnReconnect 默认 true。
3. **ahooks useRequest**：存量页面的请求/轮询层，与 React Query 共存（渐进迁移路线，源码注释即路线图）。

## store/auth.ts（55 行）

- 形状：`token` / `refreshToken` / `user`（AuthUser: id/username/email?/role?）+ `_hasHydrated`；actions：setToken / setRefreshToken / setAuth / setUser / logout / setHasHydrated。
- persist（zustand/middleware）：storage 为 localStorage，key `autoflow-auth`；`partialize` 持久化 token/refreshToken/user（刷新后首个请求即带有效 Authorization，过期由 401→refresh 路径兜底）；`onRehydrateStorage` 置 `_hasHydrated`。
- `isAdminUser(user)`：`user?.role === 'admin'`——R5 RBAC 的唯一判断函数；role 缺失（旧 localStorage、profile 未拉取）按非 ADMIN 处理。
- 消费方：client.ts 拦截器、PrivateRoute、RequireAdmin、MainLayout（profile 补齐 role）、三个 SSE hooks（token）、AppDeploymentPage（审批按钮显隐）。

## theme/store.ts（101 行）

- `mode: 'light' | 'dark' | 'system'` 三态 + `resolvedMode` 推导值（main.tsx algorithm 选择与 index.css data-theme 同步唯一应依赖的值）；`cycleMode()` 循环切换（MainLayout 头部按钮）。
- system 态 `matchMedia('(prefers-color-scheme: dark)')` 订阅，`_subscribed` 做订阅去重；`applyThemeAttribute` / `subscribeSystemTheme` / `selectResolvedTheme` 导出；`wireThemeSync()` 在 main.tsx 模块加载期接线一次（配合 index.html 头部 THEME_INIT_SCRIPT 同键名，防首帧闪白）。

## src/api/queries.ts（380 行）：React Query 薄层

queryKey 工厂（层级常量前缀，防 invalidate 前后缀对不上）：`queryKeys.metrics / executions / scheduler / tasks / executors / taskTemplates`，如 `executions.detail(taskId, execId)`、`tasks.allForDag`。

hooks 清单（端点已核实）：

| Hook | 端点 | 备注 |
|---|---|---|
| useMetricsSummary | GET /metrics/summary | KPI 四卡 |
| useMetricsTrend(days) | GET /metrics/trend | gcTime 60s |
| useExecutorStats | GET /metrics/executors | 热力条；SSE 会 setQueryData 同 key |
| useRecentFailures | GET /metrics/failures | 失败 Top + 最近失败共用 |
| useSchedulerMetrics | GET /metrics/scheduler | 调度延迟卡 |
| useSchedulerStats | GET /tasks/scheduler/stats | refetchInterval 30s |
| useExecutionsList(params) | GET /tasks/executions/all | 筛选参数进 queryKey |
| useTasksList(params) | GET /tasks | signal 透传 |
| useTaskDetail(id) | GET /tasks/:id | enabled: !!id |
| useTaskStats(id) | GET /tasks/:id/stats | refetchInterval 60s |
| useTaskExecutions(taskId, params) | GET /tasks/:id/executions | 分页进 queryKey |
| useAllTasksForDag | GET /tasks（聚合） | staleTime 60s，与 tasks.list 共前缀 |
| useExecutorsList | GET /executors | refetchInterval 30s |
| useExecutorGroups | GET /executors/groups | staleTime 5min |
| useExecutorDetail / useExecutorMetrics | GET /executors/:id、/metrics | metrics 30s 轮询 |
| useExecutorExecutions | GET /executors/:id/executions | 分页 |
| useExecutionDetail | GET /tasks/:taskId/executions/:execId | SSE 断流兜底经 refetch |
| useExecutionArtifacts(execId, enabled) | GET /tasks/executions/:execId/artifacts | enabled 门控在调用侧 |
| useExecutionRetryChain(taskId) | GET /tasks/:id/executions（带 status） | 重试链兄弟行 |
| useExecutionReport | GET .../report | 一次性 report |
| useTaskTemplates | GET /task-templates | 模板列表 |

写操作失效辅助：`invalidateExecutionData`（executions.all + metrics.all）、`invalidateTaskData`（tasks.all + executions.all，trigger 产生新执行故连带）、`invalidateExecutorData`（executors.all + tasks.all，pinning 影响派发）。

## src/hooks/ 清单（4 个）

| Hook | 用途 | 关键实现 |
|---|---|---|
| `useMetricsStream.ts`（119 行） | UI-14：连 GET `/metrics/stream`，把 summary/executors/scheduler 快照 `setQueryData` 写进 queryKeys.metrics.* 缓存，返回 connecting/live/reconnecting | EventSource + `?access_token=` 查询串（jwt.strategy 白名单）；断线 3s×2^n 封顶 30s 手动重建（`reconnectBackoffMs` 纯函数导出可测）；畸形帧忽略 |
| `useExecutionsStream.ts`（134 行） | FEAT-16：连 GET `/executions/stream`，消费具名事件 `execution.completed/failed/killed` → `invalidateExecutionData`（分页筛选行集无法 setQueryData 精准改写，invalidate 是正确粒度；终态刷新 <3s 验收） | `EXECUTION_TERMINAL_EVENTS` 与 admin-api DOMAIN_EVENTS 对齐；`executionsReconnectBackoffMs` 同款退避 |
| `useExecutorLive.ts`（168 行） | UI-07：执行器列表实时覆盖——useQuery(enabled:false) 观察者订阅 useMetricsStream 写入的 executorStats 缓存；`executorStatsToMap`/`mergeStreamOverlay` 纯函数按同 id 字段类型守卫覆盖轮询值；流断线轮询兜底 | **Providerless 安全**：`useContext(QueryClientContext)` 探测，无 Provider（测试裸渲染）不触碰 React Query hook，透传轮询数据；文件头长注释详述 hooks 顺序合规取舍 |
| `useDebounce.ts`（13 行） | 输入防抖：返回延迟同步值；列表查询放 refreshDeps，输入框绑原始值 | setTimeout/useEffect |

SSE 公共模式（三个流 + ExecutionDetailPage 日志流一致）：EventSource 无法带请求头 → 后端对流路由支持 `?access_token=` 查询参数鉴权；token 来自 useAuthStore；退避纯函数导出便于单测；状态外露供页面状态点。

## 常见改动场景

- 新增服务端数据消费：api 层加方法 → queries.ts 加 queryKey 条目 + `useXxx`（参数进 queryKey、AbortSignal 透传）；写后失效用现成三个 invalidate 辅助或仿写。
- 新增全局 UI 偏好：仿 theme/store.ts（zustand + persist + `autoflow-*` 键命名惯例）。
- 新增 SSE 流：仿 useMetricsStream（backoff 纯函数 + 状态外露 + 缓存写入或 invalidate）。

## 与其他文档的关系

- 依赖：[api-layer.md](api-layer.md)（client/资源模块）。
- 被依赖：MainLayout、全部高频页面（见 [pages-*.md](README.md)）、PrivateRoute/RequireAdmin（auth store）。

## 相关文档

[README](README.md) · [components-and-layout.md](components-and-layout.md) · [routing-and-auth.md](routing-and-auth.md)
