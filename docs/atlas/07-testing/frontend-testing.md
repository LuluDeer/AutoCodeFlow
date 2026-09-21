# admin-web 前端测试（vitest）
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/vite.config.ts（test 块）、apps/admin-web/src/__tests__/

## 怎么跑

```bash
cd apps/admin-web
npm test              # vitest run（一次性）
npm run test:watch    # vitest watch
npm run typecheck     # tsc -b（CI 会跑）
npm run build         # tsc -b && vite build（CI admin-web-build job = lint + build）
```

根目录快捷方式：`npm run test:web`。**CI 只跑 lint + build，vitest 不在 ci.yml 的 admin-web job 里**——但它在根 `test:unit` 链中，本地改动后应手动跑。

## vitest 配置（vite.config.ts 的 `test` 块，无独立 vitest.config）

| 配置项 | 值 | 含义 |
|---|---|---|
| `environment` | `jsdom` | 组件可挂载渲染 |
| `globals` | `true` | describe/it/expect 无需 import |
| `setupFiles` | `[]` | 无全局 setup |
| `include` | `src/**/*.{test,spec}.{ts,tsx}` | 只收 src 下 |
| `exclude` | `e2e/**`、`**/e2e/**`、`**/*.e2e.{ts,tsx,js,cjs}` | Playwright 目录明确排除在 vitest 外 |
| coverage 门槛 | 无 | 截至 2026-09-13 未配置 coverageThreshold（如实缺省） |

同目录另有三份 Playwright 配置，职责勿混：`playwright.config.ts`（testDir `./e2e`，页面走查用）、`playwright.e2e.config.cjs` 与 `playwright.e2e.config.js`（根 e2e 配置在 apps 下的旧副本，被根配置 `testIgnore: '**/apps/**'` 排除），详见 [e2e-testing.md](e2e-testing.md)。

## 测试文件分布（2026-09-13 find/ls 核实）

共 **74 个测试文件，全部集中在 `src/__tests__/`**：64 个 `*.test.tsx` + 10 个 `*.test.ts`，另有 fixture `ThemeToggleFixture.tsx`。源码目录内不散放测试（与 admin-api 的"就近 `__tests__`"约定不同）。

`*.test.ts`（纯逻辑/单层，10 个，全列）：

- `auth.store.test.ts` — 认证 store（token 持有/刷新态）
- `client.test.ts` — API client 信封拆包
- `tasks.api.test.ts` — 任务 API 层
- `dag-layout.test.ts` — DAG 布局算法
- `execution-timeline.test.ts` — 执行时间线计算
- `priority.test.ts` — 优先级换算
- `retry-policy.test.ts` — 重试策略
- `task-dependencies.test.ts` — 任务依赖图
- `task-template-affinity-roundtrip.test.ts` — 模板亲和往返
- `trigger-preview.test.ts` — 触发预览

`*.test.tsx`（组件/页面，64 个）按域分组（括号内为代表性真实文件名）：

- a11y 无障碍（`a11y-focus` / `a11y-login-page` / `a11y-task-form`）
- 登录与会话（`login-totp` / `logout` / `requireAdmin` / `theme.store`）
- 任务域（`task-form-page` / `task-form-affinity` / `task-form-save-as-template` / `task-list-deep` / `task-dag-chain-trigger` / `task-detail-maintenance` / `task-template-prefill` / `task-templates-page` 等）
- 执行域（`executions-page` / `execution-detail-sse` / `execution-detail-log-level` / `execution-detail-trace` / `execution-detail-truncated-logs` / `execution-report-panel` / `use-executions-stream` / `use-metrics-stream`）
- 执行器域（`executor-list-page` / `executor-detail-highrisk` / `executor-detail-trend` / `executor-packages-error-state`）
- 应用与部署（`application-detail` / `application-list-error-state` / `application-list-rbac` / `application-releases-tab` / `app-deployment-approval` / `app-deployment-race` / `artifacts-list` / `registry-page`）
- 通知与系统（`notification-settings-page` / `notification-settings` / `notification-silences` / `security-settings` / `settings.ai` / `settings.history-rollback` / `user-management-page` / `audit-page` / `event-subscriptions-settings`）
- UI 专项（`dashboard-ui04` / `executor-ui07` / `task-form-ui06` / `state-feedback-ui08` / `mobile-ui09` / `ui09-pageheader-overflow` / `ui09-mobile-pages` / `ui16-state-error` / `ui16-batch4-error-state` / `ui16-batch5-error-state` / `command-palette` / `main-layout-sider` / `page-header` / `i18n-infra`）

## 能测什么 / 不能测什么

**能测**：

- 纯函数与工具（DAG 布局、重试策略、优先级换算、触发预览、依赖图）——最稳的一层，改动算法必跑对应 test.ts。
- store 与 API 层（axios mock 后的信封拆包、错误分类、token 注入）。
- 组件渲染行为：jsdom 下挂载页面，断言表单校验、角色降级 UI、错误态、焦点管理（a11y）、审批竞态提示。
- SSE/流式 hook 的**逻辑层**（`use-executions-stream` / `use-metrics-stream` / `execution-detail-sse` 是 mock 流的 vitest 用例）——但真实代理层 SSE 语义仍由 `npm run test:nginx-sse` 真机门禁兜底。

**不能测（由别层兜底）**：

- 与真实后端的交互（vitest 里 axios 全 mock）——由根级全链 e2e 兜底（[e2e-testing.md](e2e-testing.md)）。
- 真实浏览器布局/溢出/移动端视口——`e2e-ui09-mobile.spec.js`（375×812 走查）兜底；vitest 侧 `mobile-ui09` / `ui09-*` 只能测到 jsdom 级别。
- 轮询节流、真实时序行为——根 e2e 用例 5、9 兜底。
- 构建产物正确性（chunk 拆分、懒加载共享）——`npm run build`（manualChunks 配置在 vite.config.ts）兜底。

## 失败时先看什么

1. jsdom 渲染红先分清是**组件回归**还是**测试环境差异**（缺 `matchMedia`/`ResizeObserver` 等 polyfill）。
2. `client.test.ts` / `tasks.api.test.ts` 红往往意味着后端信封契约变了——去对照 [contract-fixtures](../02-packages/contract-fixtures.md) 与 `src/types/generated/api-types.ts` 是否重新生成（CI `api-types-drift` 会拦漂移）。
3. `app-deployment-approval` / `app-deployment-race` 红多半与 DEP-04 审批语义联动，对照 [approval-flow](../04-flows/approval-flow.md) 与 admin-api 侧 `app-deployment.approval.spec.ts` 的同期改动。
4. 类型错误走 `npm run typecheck`（tsc -b）单看，别在 vitest 里猜。
5. 只想快跑单个文件：`cd apps/admin-web && npx vitest run src/__tests__/<file>.test.tsx`（路径受 include `src/**` 约束，必须在 apps/admin-web 下执行）。
6. 前端结构背景见 [admin-web README](../01-apps/admin-web/README.md)、[store-and-hooks](../01-apps/admin-web/store-and-hooks.md)、[api-layer](../01-apps/admin-web/api-layer.md)。
