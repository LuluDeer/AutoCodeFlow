# 系统域页面（pages-system）

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/pages/DashboardPage.tsx、LoginPage.tsx、NotFoundPage.tsx、UserManagementPage.tsx、RegistryPage.tsx、NotificationSettingsPage.tsx、settings/、audit/

## DashboardPage.tsx（455 行，路由 /dashboard）

- 职责：运维总览
- 卡片（components/dashboard/ 五件）：
  - KPI 四卡 → `KpiSparkline`（+ buildSparklineData）
  - 失败 Top 榜 + 最近失败 → `FailureTopList`
  - 执行器资源热力条 → `ExecutorHeatBars`
  - 调度延迟卡 → `SchedulerLatencyCard`
  - 空态引导 → `DashboardEmptyGuide`
- 数据面：
  - `useMetricsSummary` / `useMetricsTrend` / `useExecutorStats` / `useRecentFailures` / `useSchedulerMetrics`（api/queries.ts）
  - `useMetricsStream`（SSE 快照 setQueryData 进同一批 queryKey；SSE live 时轮询空转——staleTime 内去重；断线退化为各自请求节奏）
- 图表：recharts，配色 theme/tokens.ts 的 CHART_COLORS，暗色面适配 selectResolvedTheme
- 测试：dashboard-ui04

## LoginPage.tsx（244 行，路由 /login，公开）

- 职责：登录 + SEC-03 TOTP 二段登录
- 流程：
  1. `authApi.login({username, password})`
  2. 返回 `totpRequired: true`（SEC-03 契约：200 正常响应，非错误）→ 进动态码输入态
  3. `authApi.verifyLogin({username, password, code})`（POST /auth/totp/verify）→ 双 token
- 成功后：读 `?redirect=`（client.ts 401 跳转带来的站内路径；拒绝 `//` 开头防开放重定向）回跳，否则 `/dashboard`；`setAuth` 写 store
- 测试：login-totp / logout / a11y-login-page

## NotFoundPage.tsx（23 行，通配路由 `*`）

- 轻量 404 页，挂在 MainLayout 下（PrivateRoute 内）——未登录访问任意未知路径先落登录页
- pages.spec 有「非存在路由不崩溃」冒烟

## UserManagementPage.tsx（490 行，路由 /users，RequireAdmin）

- 职责：用户 CRUD 与角色分配（role: admin | user）
- api：`usersApi.list(page, pageSize)`（返回 {list,total,page,pageSize}）/ create / update / remove
- 测试：user-management-page

## RegistryPage.tsx（252 行，路由 /registry）

- 职责：双私服浏览
- 数据路径：
  - PyPI 包列表：`registryApi.listPypiPackages`（GET /registry/pypi/packages，经 admin-api 代理防 CORS/凭据问题）
  - 包内文件：`getPypiPackage(name)`——前端 fetch 私服 `/simple/<name>/`（VITE_PYPI_URL 兜底 http://localhost:8003），DOMParser 解析 `<a>` 的 href 与 `#sha256=` 片段
  - npm 侧同理（NpmPackage/PypiFile 类型）
- 错误语义：UI-16 起不吞错返回 []——失败与空态分离，错误交 StateError；npm 直链同源（生产 nginx 后）
- 测试：registry-page；参照 [registry-npm](../registry-npm.md) / [registry-pypi](../registry-pypi/README.md)

## NotificationSettingsPage.tsx（664 行，路由 /notifications，RequireAdmin）

- 职责：通知渠道配置 + 静默规则
- 渠道（notificationsApi）：getChannels / updateChannel / testChannel（渠道测试）/ send（指定 channels 发测试消息）；覆盖企微 / 钉钉 / Slack Webhook / SMTP 邮件
- 静默规则（FEAT-01，silencesApi）：GET/POST/DELETE /notification/silences；scope = global | task | application；durationMinutes>0 时后端折算 endTime；后端每分钟清扫过期行
- RBAC：R6 起渠道 GET/PATCH 后端收紧 ADMIN，页面整体路由级门控（同 /audit 模式）
- 测试：notification-settings / notification-settings-page / notification-silences

## settings/（路由 /settings，PrivateRoute，无 RequireAdmin）

`settings/index.tsx`（698 行）antd Tabs 装配 6 个 Tab（Tab key 与组件已核实）：

| Tab key | 组件 | 内容 |
|---|---|---|
| token | 内联 TokenSection | 执行器共享 Token：configApi.getExecutorToken（返回 hasToken）/ generateExecutorToken |
| ai | 内联 AI 设置 | aiApi.getConfig / saveConfig / testConfig；provider disabled / openai / ollama |
| config | 内联系统配置 | configApi CRUD + batchUpsert；键类型 string/number/boolean/json；历史 getHistory / 回滚 rollback（删除类回滚返回 {deleted:true}） |
| security | SecuritySettings.tsx（343 行） | 会话管理：listSessions / revokeSession / revokeOtherSessions（DR-04 撤销语义）+ TOTP 启停（totpSetup/totpEnable/totpDisable） |
| apikeys | ApiKeysSettings.tsx（277 行） | apiKeysApi list / create / revoke；scope readonly\|trigger\|manage；创建一次性返回明文 Key（ApiKeyCreateResult） |
| events | EventSubscriptionsSettings.tsx（534 行） | eventSubscriptionsApi CRUD（EVENT_TYPE_OPTIONS 事件类型）+ 创建结果一次性展示 secret + 死信 listDeadLetters / replayDeadLetter（成功删死信、失败保留并返回 error） |

- 测试：settings.ai / settings.history-rollback / security-settings / api-keys-settings / api-keys-deep / event-subscriptions-settings

## audit/index.tsx（233 行，路由 /audit，RequireAdmin）

- 职责：审计日志查询（分页/筛选）
- 实现：直接 `client.get('/audit?...')` 组 query string，返回 {data,total}——不走资源模块封装（该域唯一特例）
- 测试：audit-page

## 常见改动场景

- 加设置项 → 并入 settings/ 对应 Tab；新 Tab 在 index.tsx 的 tabs 数组追加（icon + i18n label）
- ADMIN-only 系统页 → 路由包 `<RequireAdmin>` + 菜单键进 `ADMIN_ONLY_MENU_KEYS`（见 [routing-and-auth.md](routing-and-auth.md)）
- 通知渠道改动 → 前后端同步看 [notification-flow](../../04-flows/notification-flow.md)

## 与其他文档的关系

- 依赖：[api-layer.md](api-layer.md)、[components-and-layout.md](components-and-layout.md)（StateError/PageHeader/PageSkeleton）
- 审计与信任链：[security-model](../../04-flows/security-model.md)

## 相关文档

[README](README.md) · [store-and-hooks.md](store-and-hooks.md) · [e2e-and-conventions.md](e2e-and-conventions.md)
