# 执行器与应用域页面（pages-executors）

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/pages/Executor*.tsx、AppDeploymentPage.tsx、Application*.tsx

## 职责

覆盖执行器侧全部 UI：执行器列表（实时状态）/详情/安装向导/安装包管理，以及应用（Application）分组、部署升级与 DEP-04 审批。应用域与部署 api 同文件（api/applications.ts），故两域并入本篇。

## ExecutorListPage.tsx（426 行，路由 /executors）

- 职责：执行器卡片/表格双视图（ViewToggle）、分组过滤（GroupFilterBar）、批量操作条（BatchActionBar）、实时状态覆盖
- 数据面：
  - `useExecutorsList`（30s refetchInterval）+ `useExecutorGroups`（staleTime 5min）——api/queries.ts
  - `useExecutorLive`（hooks/useExecutorLive.ts）订阅 `/metrics/stream` executors 段，同 id 字段覆盖：status / cpuUsage / memUsage / runningTaskCount / lastHeartbeat
  - `isLive=false` 时轮询兜底并提示降级（list 接口始终是状态语义的事实源，SSE 只做覆盖加速）
- 测试：executor-list-page / executor-ui07

## ExecutorDetailPage.tsx（576 行，路由 /executors/:id）

- 职责：单执行器详情与治理动作
- 操作（executorsApi，方法名已核实）：
  - `update`：编辑
  - `rotateToken`：换 token（返回新 token + expiresAt）
  - `setOffline`：下线
  - `remove(id, reason?)`：删除（ADMIN-only；reason ≤200 字随 body 发送，写审计 executor.delete）
  - `reloadConfig`：远端配置下发（maxConcurrentTasks / taskTimeoutSeconds / heartbeatIntervalSeconds / adminApiUrl*）
- 数据面：`useExecutorDetail` / `useExecutorMetrics`（30s 轮询）/ `useExecutorExecutions`（分页执行历史）
- 测试：executor-detail-highrisk（高风险操作门控）/ executor-detail-trend

## ExecutorInstallWizardPage.tsx（723 行，路由 /executors/install，RequireAdmin）

- 职责：分步安装向导——选择类型/平台 → 一键安装命令 → 关联安装包 → 引导完成注册
- 依赖 api：
  - `executorsApi.getInstallCmd`：一键安装命令（内含共享 Token，与执行器列表共用端点）
  - `executorPackagesApi.listLatest`：拉 active 包列表（按 createdAt 倒序最多 100 条），由前端按 类型+平台 匹配最新——后端 GET /executor-packages/latest 单类型单结果，无法一次取全部类型（源码注释明示此取舍）
- RBAC（R5）：install-cmd 与 executor-shared-token 接口本身 ADMIN-only，路由级 RequireAdmin

## ExecutorPackagesPage.tsx（423 行，路由 /executor-packages，RequireAdmin）

- 职责：安装包管理
- 操作（executorPackagesApi）：
  - `upload(formData)`：上传（multipart/form-data）
  - `push(id, executorIds?)`：推送到执行器（留空 = 全部在线执行器，返回 PushResult[]）
  - `download(id)`：blob + objectURL 下载（直链会 401）
  - `deprecate` / `activate`：弃用/激活
  - `remove`：删除
- 依赖：`executorPackagesApi` 全套 + `executorsApi`（推送目标执行器列表）
- 测试：executor-packages-error-state

## AppDeploymentPage.tsx（624 行，路由内跳转页，无独立顶层路由）

- 职责：应用部署工作台
- 操作（deploymentsApi）：
  - `list(applicationId?, page, pageSize, approvalStatus?)`：部署单列表
  - `deploy(appId, dto)`：发起部署；`upgrade` / `stop`：升级/停止
  - `approve / reject / cancel`：DEP-04 审批三动作（后端 @Roles(ADMIN) + 第二人规则）
- 状态映射：STATUS_CONFIG 覆盖 running / stopped / deploying / failed / pending / upgrading 六态（中文 label + antd badge）
- 权限：审批按钮按 `useAuthStore` 角色显隐
- 测试：app-deployment-approval / app-deployment-race

## ApplicationListPage.tsx（662 行，路由 /applications）

- 职责：应用 CRUD（create/update/delete）、zip 上传（upload，FormData）、webhook 注册、任务同步（syncTasks，返回 registeredCount）、一键升级（upgradeAll，返回 total/succeeded/failed）、部署入口
- 错误态：StateError 呈现（application-list-error-state 测试）；RBAC 行为有 application-list-rbac 测试

## ApplicationDetailPage.tsx（718 行，路由 /applications/:id）

- 职责：应用概览与版本治理
- 要点：
  - 版本历史 `getVersionHistory`（回滚后当前版本标记，application-versions 测试覆盖）
  - 发布追溯 Releases 表 `getReleases`：版本 × 最近一次部署（DEP-01，分页默认 50 上限 200；application-releases-tab 测试）
  - AI 应用健康分析 `aiApi.analyzeApp` → AppHealthReport
  - 回滚 `rollback(appId, targetId)`：返回 rolledBackTo / total / succeeded / failed
  - 关联任务列表（tasksApi）

## RBAC 速查（本域 ADMIN-only 面）

| 入口 | 门控 |
|---|---|
| `/executors/install` | RequireAdmin（install-cmd / shared-token 接口 ADMIN-only） |
| `/executor-packages` | RequireAdmin + 菜单键隐藏 |
| 执行器删除 `remove` | ADMIN-only 接口 + reason 写审计 |
| 部署审批 approve/reject/cancel | 后端 @Roles(ADMIN) + 第二人规则，前端按角色显隐 |

## 常见改动场景

1. 新端点 → `api/executors.ts`（或 executor-packages.ts / applications.ts）加方法；列表类加 queries.ts hook + queryKey
2. ADMIN-only 页面：路由挂 `<RequireAdmin>` + MainLayout `ADMIN_ONLY_MENU_KEYS` 加菜单键（两处必须同步，e2e-17 回归实证过）
3. 域内展示组件放 `src/components/executor/`；页面测试对 api 层整模块 vi.mock 是既有惯例
4. 部署审批相关改动需同时看 [approval-flow](../../04-flows/approval-flow.md)（第二人规则）

## 与其他文档的关系

- 依赖：[api-layer.md](api-layer.md)、[routing-and-auth.md](routing-and-auth.md)（RequireAdmin）、[store-and-hooks.md](store-and-hooks.md)（useExecutorLive/useMetricsStream）
- 流程参照：[执行器注册](../../04-flows/executor-registration.md)（安装命令/共享 Token/心跳）

## 相关文档

[README](README.md) · [pages-tasks.md](pages-tasks.md) · [pages-system.md](pages-system.md)（settings 内共享 Token Tab）
