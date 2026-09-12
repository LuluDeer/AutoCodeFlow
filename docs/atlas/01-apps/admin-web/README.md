# admin-web 应用总览

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web

## 一句话定位

admin-web 是 AutoCodeFlow 的 **React 管理台前端**：任务/模板管理、执行记录与实时日志、执行器与安装包管理、应用部署、用户/审计/通知/系统设置，全部经 axios 调 admin-api（默认经 Vite 代理到 `http://localhost:3105`，全局前缀 `/api`）。

## 技术栈与版本（摘自 apps/admin-web/package.json）

| 类别 | 依赖 | 版本 |
|---|---|---|
| 框架 | react / react-dom | ^18.3.1 |
| 路由 | react-router-dom | ^7.18.2 |
| UI 库 | antd / @ant-design/icons | ^6.4.3 / ^6.2.5 |
| 服务端状态 | @tanstack/react-query | ^5.101.0 |
| 请求轮询 | ahooks | ^3.9.7 |
| 客户端状态 | zustand（persist 中间件） | ^5.0.14 |
| HTTP | axios | ^1.17.0 |
| i18n | i18next / react-i18next | ^23.16.8 / ^15.7.4 |
| 图表 / 编辑器 | recharts / monaco-editor + @monaco-editor/react | ^3.8.1 / ^0.53.0 + ^4.7.0 |
| 错误边界 | react-error-boundary | ^6.1.2 |
| 构建 | vite / typescript | ^8.2.1 / ~5.6.2 |
| 测试 | vitest + @testing-library/react、@playwright/test | ^4.1.8 / ^1.60.0 |

## 常用命令（apps/admin-web 下）

```bash
npm run dev          # Vite 开发服务器（VITE_PORT 默认 5176，/api 代理到 localhost:3105）
npm run build        # tsc -b && vite build
npm run lint         # eslint .
npm run test         # vitest run（单测在 src/__tests__/，jsdom 环境）
npm run gen:api-types  # openapi-typescript ../admin-api/openapi.json → src/types/generated/api-types.ts
```

E2E（Playwright）无独立 npm script，见 [e2e-and-conventions.md](e2e-and-conventions.md)。

## 目录结构

```
apps/admin-web/
├── src/
│   ├── main.tsx            入口：QueryClientProvider + ThemedProviders + RouterProvider + ErrorBoundary
│   ├── router.tsx          全部路由（lazy + Suspense）
│   ├── api/                axios 封装 + 18 个资源 API 模块 + queries.ts（TanStack Query 薄层）
│   ├── store/auth.ts       鉴权 zustand store（persist 到 localStorage 'autoflow-auth'）
│   ├── hooks/              SSE 流 hooks（useMetricsStream/useExecutionsStream/useExecutorLive）+ useDebounce
│   ├── layouts/MainLayout.tsx  侧边栏 + 头部 + 命令面板 + Outlet
│   ├── pages/              19 个页面（含 audit/、settings/ 子目录）+ 8 个非页面域逻辑模块
│   ├── components/         公共组件（CommandPalette/PageHeader/StateError/守卫/编辑器/DAG 图等）
│   ├── theme/              设计令牌 tokens.ts + 主题 store + ThemeProviders
│   ├── i18n/ + locales/    i18next 初始化 + zh/en 扁平 key 字典
│   ├── styles/ + index.css 全局样式与 a11y 焦点样式
│   ├── utils/              10 个纯函数工具（日志分级/时间线/触发预览/优先级等）
│   └── types/generated/    openapi-typescript 生成物（勿手改，CI 校验 drift）
├── e2e/                    Playwright 用例（auth/navigation/pages/functional 等 6 个 spec）
├── e2e-full.spec.js        全场景 E2E（601 行，独立配置 playwright.e2e.config.js）
└── vite.config.ts          端口/代理/manualChunks/vitest 配置
```

## 路由总表（核实于 src/router.tsx，全部 lazy + PageFallback Suspense）

| 路径 | 页面组件 | 守卫 |
|---|---|---|
| `/login` | LoginPage | 无（公开） |
| `/` (index) | 重定向 → `/dashboard` | PrivateRoute |
| `*` | NotFoundPage | PrivateRoute（挂 MainLayout 下） |
| `/dashboard` | DashboardPage | PrivateRoute |
| `/tasks` | TaskListPage | PrivateRoute |
| `/task-templates` | TaskTemplatesPage | PrivateRoute |
| `/tasks/new` | TaskFormPage | PrivateRoute |
| `/tasks/:id` | TaskDetailPage | PrivateRoute |
| `/tasks/:id/edit` | TaskFormPage | PrivateRoute |
| `/tasks/:taskId/executions/:execId` | ExecutionDetailPage | PrivateRoute |
| `/executions` | ExecutionsPage | PrivateRoute |
| `/executors` | ExecutorListPage | PrivateRoute |
| `/executors/install` | ExecutorInstallWizardPage | PrivateRoute + **RequireAdmin** |
| `/executors/:id` | ExecutorDetailPage | PrivateRoute |
| `/users` | UserManagementPage | PrivateRoute + **RequireAdmin** |
| `/registry` | RegistryPage | PrivateRoute |
| `/settings` | settings/index（6 个 Tab） | PrivateRoute |
| `/notifications` | NotificationSettingsPage | PrivateRoute + **RequireAdmin** |
| `/audit` | audit/index | PrivateRoute + **RequireAdmin** |
| `/applications` | ApplicationListPage | PrivateRoute |
| `/applications/:id` | ApplicationDetailPage | PrivateRoute |
| `/executor-packages` | ExecutorPackagesPage | PrivateRoute + **RequireAdmin** |

菜单侧边栏（MainLayout，6 组 12 项）对普通用户隐藏 ADMIN-only 四项：`/executor-packages`、`/audit`、`/users`、`/notifications`。详见 [routing-and-auth.md](routing-and-auth.md)。

## 与 admin-api 的对接方式

- **统一客户端**：`src/api/client.ts` 导出 axios 实例 `client`，baseURL 取 `import.meta.env.VITE_API_URL_INTERNAL || '/api'`；可用 localStorage `autoflow_use_external_api` 切换到 `VITE_API_URL_EXTERNAL`。开发期 `/api` 由 Vite 代理转发到 `http://localhost:3105`。
- **鉴权 token 存取**：zustand `useAuthStore`（persist 到 localStorage `autoflow-auth`）保存 `token`/`refreshToken`/`user`；请求拦截器注入 `Authorization: Bearer <token>`；401 时单飞刷新（POST `/auth/refresh`）后重放原请求，失败则登出并跳 `/login?redirect=<原路径>`。
- **响应信封**：响应拦截器把 `{ code, data, message }` 信封剥为 `data`，页面拿到的即业务数据。
- **类型同步**：`npm run gen:api-types` 从 admin-api 导出的 `openapi.json` 生成 `src/types/generated/api-types.ts`（CI `api-types-drift` 校验）。

详见 [api-layer.md](api-layer.md)、[REST 接口地图](../../05-interfaces/rest-api.md)、[security-model](../../04-flows/security-model.md)。

## 相关文档

- 页面拆解：[pages-tasks.md](pages-tasks.md) / [pages-executors.md](pages-executors.md) / [pages-executions.md](pages-executions.md) / [pages-system.md](pages-system.md)
- 基础设施：[api-layer.md](api-layer.md) / [store-and-hooks.md](store-and-hooks.md) / [components-and-layout.md](components-and-layout.md) / [routing-and-auth.md](routing-and-auth.md)
- 流程参照：[任务生命周期](../../04-flows/task-lifecycle.md)、[执行回调](../../04-flows/execution-callback.md)、[新增前端页面流程](../../08-workflows/add-new-web-page.md)
