# AutoCodeFlow Admin Web

> **受众**：改管理后台前端的开发者 · **状态**：稳定 · **最后核对**：2026-11-22

AutoCodeFlow 管理后台前端 SPA，基于 React 19 + Vite 8 + Ant Design 6 + React Router 7 构建。

## 快速开始

```bash
cd apps/admin-web
npm install
cp .env.example .env    # 模板内 VITE_API_URL_INTERNAL=/api（同源反代），不要改成裸 URL
npm run dev             # 启动开发服务器，默认 http://localhost:5176
```

## 技术栈

- **React 19** + **TypeScript 5.9**
- **Vite 8**（构建与开发服务器）
- **Ant Design 6**（`antd` + `@ant-design/icons`）
- **React Router 7**（`createBrowserRouter` 数据路由 + 路由级错误边界）
- **TanStack React Query 5**（服务端状态缓存）+ **Zustand 5**（客户端状态）
- **Recharts 3**（趋势与指标图表）+ **Monaco Editor**（在线 Glue 脚本编辑）
- **i18next / react-i18next**（中英文双语，配 CI 漏译与硬编码扫描守卫）
- **Axios**（HTTP 客户端，含 Token 刷新拦截器）
- **Vitest 5**（单元测试）+ **Playwright**（E2E 测试）

## 目录结构

```text
src/
├── api/                     # API 请求与 React Query 封装
│   ├── agent.ts             # Agent 会话与审批接口
│   ├── ai.ts                # AI 诊断与辅助接口
│   ├── api-keys.ts          # 作用域 API Key 管理
│   ├── applications.ts      # 应用、版本、互斥组与部署接口
│   ├── artifacts.ts         # 产物库接口
│   ├── audit.ts             # 审计日志接口
│   ├── auth.ts / logout.ts  # 认证、TOTP 与 SSO 登出
│   ├── client.ts            # Axios 实例（拦截器、Token 刷新）
│   ├── config.ts            # 系统配置接口
│   ├── event-subscriptions.ts # 出站事件订阅接口
│   ├── execution-reports.ts # 执行报表接口
│   ├── executor-packages.ts # 执行器升级包管理接口
│   ├── executors.ts         # 执行器管理、安装向导与指标接口
│   ├── inbox.ts             # 管理员待办收件箱接口
│   ├── metrics.ts           # 监控与北极星看板指标接口
│   ├── notifications.ts     # 通知渠道与静默规则接口
│   ├── projects.ts          # 项目与成员角色接口
│   ├── queries.ts / queryClient.ts # React Query keys 与客户端配置
│   ├── registry.ts          # 私有 npm/PyPI 仓库代理接口
│   ├── sops.ts              # SOP 起草、发布、版本与指派接口
│   ├── sse.ts / sse-client.ts # 实时日志与状态 SSE 流
│   ├── task-templates.ts    # 任务模板接口
│   ├── tasks.ts             # 任务与执行记录接口
│   └── users.ts             # 用户管理接口
├── components/              # 通用组件（RequireAdmin、PrivateRoute、BrandFox、CronHelper、GlueEditor 等）
├── constants/               # 常量与枚举映射
├── hooks/                   # 自定义 React Hooks
├── i18n/ & locales/         # 中英文文案与国际化初始化
├── layouts/
│   └── MainLayout.tsx       # 主布局（侧边栏、顶栏、导航菜单）
├── pages/                   # 页面组件与子模块目录
├── store/                   # Zustand 全局状态
├── styles/ & theme/         # 主题令牌与全局样式
├── types/                   # 类型定义（含 openapi-typescript 生成产物）
├── utils/                   # 工具函数
├── router.tsx               # 路由配置与权限门控（唯一路由真值源）
├── router-pages.tsx         # 页面懒加载入口（保住 HMR 边界）
└── main.tsx                 # 应用入口
```

## 页面路由

对照 `src/router.tsx` 完整路由表：

| 路由 | 页面组件 | 权限 | 说明 |
|------|----------|------|------|
| `/login` | `LoginPage` | 公开 | 登录页（含 TOTP 与 OIDC SSO 入口） |
| `/auth/sso/complete` | `SsoCompletePage` | 公开 | OIDC SSO 回调落地页 |
| `/` | 重定向 → `/dashboard` | 登录 | 根路径自动跳转控制台 |
| `/dashboard` | `DashboardPage` | 登录 | 控制台（北极星 KPI、执行趋势、调度延迟、执行器资源） |
| `/tasks` | `TaskListPage` | 登录 | 任务列表与筛选 |
| `/task-templates` | `TaskTemplatesPage` | 登录 | 任务模板库（一键实例化任务） |
| `/tasks/new` | `TaskFormPage` | 登录 | 新建任务 |
| `/tasks/:id` | `TaskDetailPage` | 登录 | 任务详情（脚本、DAG、版本历史、只读 Agent 诊断） |
| `/tasks/:id/edit` | `TaskFormPage` | 登录 | 编辑任务 |
| `/tasks/:taskId/executions/:execId` | `ExecutionDetailPage` | 登录 | 执行详情（实时日志、时间线、重试链、产物） |
| `/executions` | `ExecutionsPage` | 登录 | 全量执行记录列表 |
| `/artifacts` | `ArtifactsPage` | ADMIN | 执行产物库 |
| `/executors` | `ExecutorListPage` | 登录 | 执行器列表与状态 |
| `/executors/install` | `ExecutorInstallWizardPage` | ADMIN | 执行器一键安装向导 |
| `/executors/:id` | `ExecutorDetailPage` | 登录 | 执行器详情（资源趋势、令牌轮换） |
| `/executor-packages` | `ExecutorPackagesPage` | ADMIN | 执行器升级包管理 |
| `/applications` | `ApplicationListPage` | 登录 | 应用列表与互斥组管理 |
| `/applications/:id` | `ApplicationDetailPage` | 登录 | 应用详情、版本历史、发布与部署记录 |
| `/projects` | `ProjectsPage` | 登录 | 项目列表 |
| `/projects/:id` | `ProjectDetailPage` | 登录 | 项目详情与成员统计 |
| `/sops` | `SopsPage` | ADMIN | SOP 管理（起草、发布、版本与指派） |
| `/sops/from-video` | `SopFromVideoPage` | ADMIN | 视频转 SOP 工作流 |
| `/agent-sessions` | `AgentSessionsPage` | ADMIN | Agent 会话与审批跟踪（`session` 定位会话，`tab=approvals&approvalKey=…` 定位审批单） |
| `/inbox` | `InboxPage` | ADMIN | 管理员待办收件箱（直达审批与异常会话） |
| `/registry` | `RegistryPage` | 登录 | 私有 npm / PyPI 仓库管理 |
| `/notifications` | `NotificationSettingsPage` | ADMIN | 通知渠道与静默规则配置 |
| `/audit` | `AuditLogPage` | ADMIN | 系统审计日志 |
| `/users` | `UserManagementPage` | ADMIN | 用户与角色管理 |
| `/settings` | `SettingsPage` | 登录 | 系统设置与作用域 API Keys |
| `*` | `NotFoundPage` | 登录 | 404 页面 |

## 构建、校验与类型生成

```bash
npm run build           # tsc -b && vite build（产物输出到 dist/）
npm run preview         # 预览生产构建产物
npm run lint            # ESLint 检查
npm run lint:i18n       # i18n 硬编码与键完整度守卫
npm test                # Vitest 单元测试
npm run gen:api-types   # 从 ../admin-api/openapi.json 重新生成 API 类型
```

生产环境通过 Nginx 提供静态文件服务，配置见 `nginx.conf`。

## E2E 测试

```bash
# 安装 Playwright 浏览器
npx playwright install

# 运行 E2E 测试
npx playwright test
```

只验收中台 Agent 用户路径时，从本应用目录运行 `npm run test:e2e:agent`。它构建管理台、在 `127.0.0.1:4176` 临时预览，覆盖桌面提问、窄屏审批、卡住会话和普通用户权限。API 响应由浏览器测试提供，无需启动后端或配置模型。已安装系统 Chrome 而非 Playwright Chromium 时，可设置 `PLAYWRIGHT_CHROMIUM_CHANNEL=chrome`。实际运行和审批的数据库／队列验证在 `apps/admin-api` 的 `test:e2e` 套件中。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_URL_INTERNAL` | Admin API 同源入口（dev 经 Vite proxy、部署经 nginx 反代到后端；后端全局 `/api` 前缀不可省，裸 URL 会让登录 404） | `/api`（留空同效） |
