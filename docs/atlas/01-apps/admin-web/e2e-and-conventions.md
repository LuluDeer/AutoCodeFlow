# E2E 测试与前端开发约定

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/e2e/、e2e-full.spec.js、playwright*.config.*、package.json、vite.config.ts、.env.example

## E2E（Playwright）

### e2e/ 目录（testDir: './e2e'，配置 playwright.config.ts）

| Spec | 内容 |
|---|---|
| `auth.spec.ts` | 登录页渲染、错误凭据停留登录页、有效凭据跳转（容忍 API 不在线） |
| `navigation.spec.ts` | 未登录根路径跳 login、登录页表单元素、登录页无 JS 报错 |
| `pages.spec.ts` | 页面渲染冒烟：login / dashboard / tasks / executors 可加载、非存在路由不崩溃 |
| `functional.spec.ts` | 8 例功能链路：未登录跳转、注入 token 跳过登录、Dashboard/任务/执行记录加载、创建按钮存在、登出、API 健康检查（request fixture 直打 3105） |
| `login_real.spec.ts` | 真实登录流程（不注入 token） |
| `application-versions.spec.ts` | 版本历史：当前版本标记 + 回滚后刷新 |

### e2e-full.spec.js（601 行，位于 apps/admin-web/ 根）

- 全场景 E2E（CommonJS `require('@playwright/test')`）
- 覆盖：登录、应用管理、任务调度、执行日志、运行机管理、并发状态、中断任务、仓库、通知、审计
- 独立配置 `playwright.e2e.config.js`：testMatch `**/e2e-full.spec.js`、timeout 60s、actionTimeout 15s、baseURL `http://localhost:5176`
- 脚本内硬编码 API `http://localhost:3105` 与默认账号 admin/admin123，自带 login() 辅助

### 运行方式

package.json **无 e2e script**（已核实：scripts 仅 dev / build / lint / preview / test / test:watch / gen:api-types）：

```bash
npx playwright test                                 # e2e/ 目录（playwright.config.ts）
npx playwright test -c playwright.e2e.config.js     # e2e-full.spec.js 全场景
```

- playwright.config.ts：chromium、baseURL `PLAYWRIGHT_BASE_URL ?? http://localhost:5176`、retries 0、失败截图、`--no-sandbox`
- 前置：`npm run dev`（5176）+ admin-api（3105）；e2e/ 多数用例容忍后端不在线（断言宽松）

## 单元/组件测试（vitest）

- 配置在 vite.config.ts 的 `test` 段：environment `jsdom`、globals true、include `src/**/*.{test,spec}.{ts,tsx}`、exclude `e2e/**`（两套测试互不干扰）
- 位置：`src/__tests__/`，约 80 个文件；命令：`npm run test`（vitest run）/ `npm run test:watch`；`@vitest/ui` 在 devDependencies
- 惯例（源码注释可证）：
  - 组件级测试对 api 层整模块 `vi.mock`——所以 TIMEOUT_ACTION_OPTIONS 等常量放 pages/*.ts 纯逻辑文件（不随 mock 丢失）
  - 部分历史测试裸渲染页面、无 QueryClientProvider——hooks 侧以 Providerless 探测兼容（useExecutorLive 文件头长注释详述）
  - 纯函数单独导出直测：reconnectBackoffMs / executionsReconnectBackoffMs / executorStatsToMap / mergeStreamOverlay / retryGapMs / buildRetryChain / dag-layout / trigger-preview / logLevel / priority
- 命名：`<feature>.test.ts(x)`；另有一批带交付编号的专项（dashboard-ui04 / task-form-ui06 / executor-ui07 / execution-detail-ui05 / mobile-ui09 / state-feedback-ui08 / ui16-*-error-state）
- a11y 专项：a11y-focus / a11y-login-page / a11y-task-form；移动端：mobile-ui09 / ui09-mobile-pages / ui09-pageheader-overflow
- 主题可测性：theme/tokens.ts 与 ThemeProviders 独立于 main.tsx 导出（便于测试直接消费）；`__tests__/ThemeToggleFixture.tsx` 是共享夹具

## 前端开发约定

### 目录

- 页面：`pages/XxxPage.tsx`（组件文件只导出组件——react-refresh 限制）
- 表单/映射纯逻辑：`pages/<kebab-case>.ts`
- 可复用组件：`components/`（域内组件进 dashboard/、executor/、task-form/ 子目录）
- 请求：`api/<资源>.ts`；缓存 hooks 只进 `api/queries.ts`

### 命名

- 页面 PascalCase + Page 后缀
- 持久化键统一 `autoflow-*`：autoflow-auth / autoflow-theme / autoflow-lang / autoflow-sider-collapsed / autoflow-menu-open-keys / autoflow_use_external_api

### 类型生成

- `src/types/generated/api-types.ts` 由 openapi-typescript 从 `apps/admin-api/openapi.json` 生成，**勿手改**
- 改后端契约：admin-api `npm run openapi:export` → 本包 `npm run gen:api-types`
- CI `api-types-drift` job 校验逐字节一致
- 消费形态：`import type { components } from '@/types/generated/api-types'` → `components['schemas']['TaskDto']`

### 渐进迁移路线（源码注释即路线图）

- 请求层新代码走 TanStack Query（queries.ts 薄层），存量 ahooks useRequest 保留
- 文案逐页迁 i18n locales（默认 zh 基线）
- PATCH 清空字段必须显式 null（N28）

### 测试与文档同步

- 改页面/组件同步补 `src/__tests__` 对应文件；交付编号专项（UI-xx / FEAT-xx / CORE-xx）沿用既有命名
- 改某模块后更新 docs/atlas 对应文档「最后核对」日期（[../../README.md](../../README.md) 维护规则）

## 环境变量（Vite 只暴露 VITE_ 前缀；.env.example 已核实）

| 变量 | 说明 |
|---|---|
| `VITE_API_URL` | （.env.example 基础项）API 地址，开发环境默认代理到 localhost:3105 |
| `VITE_API_URL_INTERNAL` | 内部 API 地址；vite.config.ts define 缺省注入 http://localhost:3105，client.ts 代码兜底 '/api'（开发期 /api 走 Vite proxy → 3105） |
| `VITE_API_URL_EXTERNAL` | 公网地址（可空）；localStorage `autoflow_use_external_api` 切换 |
| `VITE_PORT` | 开发服务器端口，默认 5176 |
| `VITE_APP_TITLE` | 应用标题 |
| `VITE_PYPI_URL` | registry 页直连 PyPI 私服（registryApi 兜底 http://localhost:8003）——消费于 src/api/registry.ts |

## 与其他文档的关系

- 依赖：全部 [pages-*.md](README.md)（测试对象）、[api-layer.md](api-layer.md)（mock 对象）、[components-and-layout.md](components-and-layout.md)（主题可测性）
- 被依赖：[07-testing](../../07-testing/README.md)（测试策略汇总处）、CI（api-types-drift）
- 流程参照：[新增前端页面流程](../../08-workflows/add-new-web-page.md)（含「补测试」步骤）、[发布流程](../../08-workflows/release-process.md)

## 相关文档

[README](README.md) · [routing-and-auth.md](routing-and-auth.md) · [api-layer.md](api-layer.md)
