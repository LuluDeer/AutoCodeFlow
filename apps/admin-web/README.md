# AutoCodeFlow Admin Web

AutoCodeFlow 管理后台前端，基于 React + Vite + Ant Design 构建。

## 快速开始

```bash
cd apps/admin-web
npm install
cp .env.example .env   # 按需修改 API 地址
npm run dev             # 启动开发服务器，默认 http://localhost:5173
```

## 技术栈

- React 18 + TypeScript
- Vite 5 (构建工具)
- Ant Design 5 (UI 组件库)
- Zustand (状态管理)
- React Router 6 (路由)
- Axios (HTTP 请求)
- Playwright (E2E 测试)

## 目录结构

```
src/
├── api/              # API 请求封装
│   ├── ai.ts              # AI 辅助接口
│   ├── applications.ts    # 应用管理接口
│   ├── auth.ts            # 认证接口
│   ├── client.ts          # Axios 实例（拦截器、Token 刷新）
│   ├── config.ts          # 系统配置接口
│   ├── executor-packages.ts # 包管理接口
│   ├── executors.ts       # 执行器管理接口
│   ├── metrics.ts         # 监控指标接口
│   ├── notifications.ts   # 通知配置接口
│   ├── registry.ts        # 私有仓库接口
│   ├── tasks.ts           # 任务管理接口
│   └── users.ts           # 用户管理接口
├── components/       # 通用组件
│   ├── AlarmConfig.tsx        # 告警配置组件
│   ├── CronHelper.tsx         # Cron 表达式辅助生成器
│   ├── ErrorBoundary.tsx      # 错误边界
│   ├── ExecutionCompare.tsx   # 执行记录对比
│   ├── GlueEditor.tsx         # Glue 脚本编辑器
│   └── ParamsEditor.tsx       # 参数编辑器
├── layouts/          # 布局组件
│   └── MainLayout.tsx         # 主布局（侧边栏 + 顶栏）
├── pages/            # 页面组件
│   ├── DashboardPage.tsx          # 仪表盘
│   ├── TaskListPage.tsx           # 任务列表
│   ├── TaskDetailPage.tsx         # 任务详情
│   ├── TaskFormPage.tsx           # 任务创建/编辑
│   ├── ApplicationListPage.tsx    # 应用列表
│   ├── ApplicationDetailPage.tsx  # 应用详情
│   ├── AppDeploymentPage.tsx      # 应用部署管理
│   ├── ExecutorListPage.tsx       # 执行器列表
│   ├── ExecutorDetailPage.tsx     # 执行器详情
│   ├── ExecutorInstallWizardPage.tsx # 执行器安装向导
│   ├── ExecutorPackagesPage.tsx   # 包管理
│   ├── ExecutionsPage.tsx         # 执行记录列表
│   ├── ExecutionDetailPage.tsx    # 执行详情（含日志）
│   ├── NotificationSettingsPage.tsx # 通知设置
│   ├── RegistryPage.tsx           # 私有仓库管理
│   ├── LoginPage.tsx              # 登录页
│   └── NotFoundPage.tsx           # 404 页面
└── App.tsx           # 根组件（路由配置）
```

## 页面路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/login` | LoginPage | 登录页 |
| `/` | DashboardPage | 仪表盘 |
| `/tasks` | TaskListPage | 任务列表 |
| `/tasks/new` | TaskFormPage | 新建任务 |
| `/tasks/:id` | TaskDetailPage | 任务详情 |
| `/tasks/:id/edit` | TaskFormPage | 编辑任务 |
| `/applications` | ApplicationListPage | 应用列表 |
| `/applications/:id` | ApplicationDetailPage | 应用详情 |
| `/applications/:id/deploy` | AppDeploymentPage | 应用部署 |
| `/executors` | ExecutorListPage | 执行器列表 |
| `/executors/:id` | ExecutorDetailPage | 执行器详情 |
| `/executors/install` | ExecutorInstallWizardPage | 安装向导 |
| `/executions` | ExecutionsPage | 执行记录 |
| `/executions/:id` | ExecutionDetailPage | 执行详情 |
| `/packages` | ExecutorPackagesPage | 包管理 |
| `/notifications` | NotificationSettingsPage | 通知设置 |
| `/registry` | RegistryPage | 私有仓库 |
| `*` | NotFoundPage | 404 |

## 构建与部署

```bash
# 生产构建
npm run build          # 产物输出到 dist/

# 预览构建产物
npm run preview
```

生产环境通过 Nginx 提供静态文件服务，配置见 `nginx.conf`。

## E2E 测试

```bash
# 安装 Playwright 浏览器
npx playwright install

# 运行 E2E 测试
npx playwright test

# 指定配置文件
npx playwright test --config=playwright.e2e.config.cjs
```

测试文件位于 `e2e/` 目录，覆盖认证、导航、页面功能等场景。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_API_BASE_URL` | Admin API 地址 | `http://localhost:3105` |