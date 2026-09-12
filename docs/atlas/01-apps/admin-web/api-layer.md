# api/ 请求层拆解

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/api

## 职责

src/api/ 是前端唯一出网点：

- `client.ts` 提供 axios 实例：鉴权注入、信封剥壳、401 刷新、安全方法重试、错误 toast
- 其余 18 个文件按资源拆分 API 模块（方法名即后端 REST 面的镜像）
- `queries.ts` 提供 TanStack Query 薄层 hooks 与 queryKey 工厂（详见 [store-and-hooks.md](store-and-hooks.md)）

全部 20 个文件共约 2138 行。

## 关键文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `client.ts` | 155 | axios 实例 + 拦截器 + token 刷新 + API 环境切换 |
| `queries.ts` | 380 | queryKey 工厂 + useQuery hooks + invalidate 辅助 |
| `tasks.ts` | 428 | 任务/执行/日志/版本/批量/调度器统计（含分页聚合 listAllTasks） |
| `applications.ts` | 175 | 应用 CRUD + 版本历史 + releases + deploymentsApi（DEP-04 审批） |
| `executors.ts` | 145 | 执行器列表/详情/指标/分组/标签/换 token/删/reload-config/安装命令 |
| `metrics.ts` | 102 | Dashboard 汇总：summary/trend/executors/failures/scheduler |
| `executor-packages.ts` | 116 | 安装包 list/upload/push/download/deprecate/activate |
| `event-subscriptions.ts` | 98 | 事件订阅 CRUD + 死信分页/重放 |
| `config.ts` | 70 | 系统配置 CRUD + 历史/回滚 + 执行器共享 Token |
| `registry.ts` | 63 | PyPI/npm 双私服浏览 |
| 其余 | — | users(40)/notifications(64)/ai(55)/api-keys(32)/artifacts(62)/execution-reports(54)/task-templates(33)/auth(47)/logout(19) |

## 机制（client.ts，逐条核实）

### baseURL 双环境

```ts
const API_URL_INTERNAL = import.meta.env.VITE_API_URL_INTERNAL || '/api';
const API_URL_EXTERNAL = import.meta.env.VITE_API_URL_EXTERNAL || '';
// localStorage 'autoflow_use_external_api' === 'true' 且配置了 EXTERNAL 时走外网
```

- `setApiEnvironment/getApiEnvironment/getAvailableEnvironments` 负责切换与读取；timeout 30000
- vite.config.ts 另用 `define` 注入 `process.env.VITE_API_URL_*`（缺省 `http://localhost:3105`）
- 开发期 `/api` 由 Vite proxy 转发到 `http://localhost:3105`（vite.config.ts server.proxy）

### 请求/响应拦截器

```ts
// 请求：token 唯一来源是 zustand store（Q-02）
client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
// 响应（成功）：剥两层——axios res.data 与 API 信封 { code, data, message }
// client 被重定型为 get<T>(): Promise<T>，页面直接拿业务数据
```

### 401 刷新（单飞）

- 模块级 `refreshPromise: Promise<string> | null` 防并发刷新风暴
- `tryRefreshToken()` 用**裸 axios**（绕过自身响应拦截器，防无限循环）POST `${base}/auth/refresh`
- 校验会话未被登出/切换（比对 refreshToken）→ `setToken/setRefreshToken` → 重放原请求（`originalRequest._retried` 防二跳）
- 刷新失败 → `logout()` + 跳 `/login?redirect=<当前路径+query>`（LoginPage 读该参数回跳，仅接受站内路径防开放重定向）
- 401 且 URL 含 `/auth/refresh` 的请求不进刷新流程（直接登出）

### 重试与错误提示

- 安全方法（get/head/options）且 5xx 或无响应：等 1s 重试一次（`_retryCount` 上限 1）——非安全方法不自动重试（失败响应可能已产生副作用）
- 非 401 的 HTTP 错误按状态映射中文文案（403 没有操作权限 / 404 / 409 / 429 / 500 / 503 / 其余 `请求失败（status）`）→ `antMessage.error(msg, 4)`
- 无响应 → 「网络连接失败…」；最后 `Promise.reject(err.response?.data || err)`，页面用 `utils/error.ts` 的 `getErrMsg` / `isFormValidationError` 二次处理

### 登出（logout.ts）

`logoutRemote()`：裸 axios POST `/auth/logout`（4s 超时，best-effort，失败不阻断）→ 无论成败 `useAuthStore.getState().logout()`（本地登出必须完成）。

## 各资源 API 模块清单（方法名已核实）

- `authApi`：login / refresh / me（GET /auth/profile）/ verifyLogin（POST /auth/totp/verify）/ totpSetup / totpEnable / totpDisable / listSessions / revokeSession / revokeOtherSessions
- `tasksApi`：list / listAll / get / create / update / delete / trigger / executions / executionsWithStatus / execution / executionLogs / versions / compareVersions / rollback / rollbackToVersion / pause / resume / batchTrigger / batchPause / batchResume / batchDelete / stats / updateGlue / allExecutions（GET /tasks/executions/all）/ killExecution / analyzeExecution / schedulerStats（GET /tasks/scheduler/stats）
- `executorsApi`：list / get / update / getGroups / getTags / rotateToken / remove / reloadConfig / setOffline / getExecutions / getMetrics / getSharedToken / generateSharedToken / getInstallCmd
- `applicationsApi`：list / get / create / update / delete / upload（FormData）/ webhook / syncTasks / upgradeAll / getVersionHistory / getReleases（默认 50 上限 200）/ rollback
- `deploymentsApi`：list / get / deploy / upgrade / stop / approve / reject / cancel（审批三动作后端 @Roles(ADMIN) + 第二人规则）
- `metricsApi`：getSummary / getDailyTrend(days=7) / getExecutorStats / getRecentFailures / getSchedulerMetrics
- `executorPackagesApi`：list / listLatest / get / push（executorIds 留空推全部在线）/ upload（multipart）/ download / remove / deprecate / activate
- `taskTemplatesApi`：list / get / create / remove / instantiate（POST /task-templates/:id/instantiate，body 字段覆盖模板 config，至少需 name）
- `registryApi`：listPypiPackages（经 admin-api 代理防 CORS）/ getPypiPackage（fetch 私服 `/simple/<name>/` + DOMParser 解析 `#sha256=`）；npm 侧同理
- `notificationsApi` + `silencesApi`：getChannels / updateChannel / testChannel / send；静默规则 GET/POST/DELETE /notification/silences
- `configApi`：findAll / findOne / upsert / batchUpsert / remove / getHistory / rollback / generateExecutorToken / getExecutorToken
- `usersApi`（list/create/update/remove）/ `apiKeysApi`（list/create/revoke，scope readonly|trigger|manage）/ `aiApi`（getConfig/saveConfig/testConfig/analyzeApp/suggestSchedule）/ `artifactsApi` / `executionReportsApi.report` / `eventSubscriptionsApi`（list/create/update/remove/listDeadLetters/replayDeadLetter）

## 三个特殊机制

1. **listAllTasks 分页聚合**（tasks.ts）：pageSize 固定 100（后端 PaginationDto 上限）、并发 6、安全上限 100,000 页；每页响应逐项校验（page/pageSize/total/totalPages/条数/重复 id/缺页），任何不一致整体抛错、拒绝返回部分结果——DAG 布局消费的"全量任务表"不允许静默残缺。
2. **blob 下载**：产物与安装包的下载端点在 JwtAuthGuard 之后且 JWT 只认 Authorization 头，`<a href>` 直链会 401 → 统一 `client.get<Blob>(..., { responseType: 'blob' })` + objectURL 触发保存（artifacts.ts 与 executor-packages.ts 同款写法）。
3. **SSE 鉴权**：EventSource 无法带请求头，后端对 `/metrics/stream`、`/executions/stream`、日志流路由支持 `?access_token=` 查询参数鉴权（hooks 层消费，见 [store-and-hooks.md](store-and-hooks.md)）。

## 与其他文档的关系

- 依赖：[store/auth](store-and-hooks.md)（token 来源）、admin-api 的 [REST 接口地图](../../05-interfaces/rest-api.md)
- 被依赖：全部页面（[pages-tasks](pages-tasks.md) 等）、queries.ts hooks、CommandPalette（直接调 tasksApi / executorsApi / applicationsApi / tasksApi.allExecutions）
- 常见改动场景：
  - 后端加接口 → 对应资源文件加方法（沿用 `client.get<T>()` 形态，AbortSignal 可选透传）
  - 需要缓存的 → 进 queries.ts 加 hook + queryKey 工厂条目
  - 改 DTO → 跑 `npm run gen:api-types`（CI api-types-drift 校验逐字节一致）

## 相关文档

[README](README.md) · [新增后端模块流程](../../08-workflows/add-new-api-module.md) · [任务生命周期](../../04-flows/task-lifecycle.md)
