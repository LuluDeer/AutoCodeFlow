# AutoCodeFlow 全面审计报告

## 执行摘要

**审计时间**: 2026-10-17  
**审计范围**: AutoCodeFlow monorepo 全栈（admin-api, admin-web, executor-node, executor-python, executor-desktop, CLI, MCP, SDK, scripts）  
**方法**: CodeGraph 代码探查 + 6 路并行深度审计子代理 + 基线测试验证

## 已完成修复（已提交 commit 19aa9fb4）

### 1. 测试隔离缺陷（高置信度）
- **文件**: apps/executor-node/src/python-venv.spec.ts
- **根因**: poolDeps 桩未注入 interpreterSnapshot/ensureVersion，测试读取真实文件系统
- **后果**: 4 个"必须失败"用例在本机有池时返回真实路径而非预期错误
- **修复**: 补全三个桩函数，使测试完全密闭
- **验证**: 修复前 4 失败/187s，修复后 35/35 通过/20s

### 2. Jest 配置非法键
- **文件**: apps/admin-api/package.json
- **后果**: 每次运行打印两遍 "Unknown option '_comment-forceExit'" 警告
- **修复**: 移到顶层 //jest-forceExit（npm 允许任意顶层键）

### 3. 三个自检脚本腐烂（CI 门禁缺口）
- **文件**: scripts/qwen-runtime-check.mjs, ai-qwen-structural-check.mjs
- **根因**: 断言写死了会变化的实现细节（中文文案/字面量/精确语法），随 F-6/WIKI-OPT-3/error catalog 演进集体失效
- **后果**: test:qwen 失败但不在 CI 里，长期腐烂无人发现
- **修复**: 改为断言稳定契约（errorCode/变量/canonical） + **纳入 CI selftests job**

---

## 待修复缺陷（子代理审计发现）

### P1-高严重度（2 个）

#### 【P1】pull 模式 maxConcurrentTasks=1 永久饥饿
- **文件**: apps/executor-node/src/pull.ts:292, apps/executor-python/scheduler.py:616
- **触发**: MAX_CONCURRENT_TASKS=1（配置允许 ≥1，desktop 默认 pull 模式）
- **后果**:
  1. pull 循环预留槽位后 runningCount 变 1
  2. 计算 freeSlots = max(0, 1-1) = 0
  3. admin 端判定 wantTask=false，不出队任务
  4. 执行器永久无法获取任务
- **证据**:
  - pull.ts:289-291 注释假设"max-1 ≥ 1"仅在 max ≥ 2 成立
  - pull.spec.ts 用 maxConcurrentTasks:2，未覆盖边界值 1
  - executor.controller.ts:522 要求 freeSlots > 0 才派发
  - Node 与 Python 两侧对称失效
- **修复**:
```typescript
// pull.ts:292
freeSlots: Math.max(0, config.maxConcurrentTasks - getRunningCount() + 1),
```

### P1-高严重度（1 个）

#### 【P1】CLI/MCP refresh token 404 清空有效凭据
- **文件**: packages/acf-cli/src/client.ts:89, packages/mcp-server/src/api.ts:58
- **触发**: access token（15 分钟 TTL）过期，执行任意需鉴权命令
- **后果**: 
  1. 自动刷新 POST `http://localhost:3105/auth/refresh`（缺 /api 前缀）→ 404
  2. `clearAuth()` 清空全部已存凭据（access + refresh token）
  3. 用户被迫重新 `acf login`
- **证据**: 
  - client.ts:89 用裸 `baseUrl()`，绕过 normalizeApiBase
  - 测试 client.test.ts:310 固定了错误 URL
- **修复**:
```typescript
// acf-cli/src/client.ts:89
- const r = await axios.post(`${baseUrl()}/auth/refresh`, ...);
+ const r = await axios.post(`${normalizeApiBase(getApiUrl())}/auth/refresh`, ...);
```

### P2-中严重度（7 个）

#### 【P2】acf task batch --json 部分失败退出码 0
- **文件**: packages/acf-cli/src/commands/tasks.ts:801
- **后果**: CI 脚本把部分失败当成功，执行不该跑的下游步骤
- **修复**: 检查 results 中的 error 字段，设置 process.exitCode = 1

#### 【P2】autoflow-sdk AsyncHttpClient 连接池泄漏
- **文件**: packages/autoflow-sdk/autoflow_sdk/http.py:95
- **后果**: 任务进程累积数十个 CLOSE_WAIT socket
- **修复**: 懒初始化 + 每次请求 with 自动释放（对齐同步 HttpClient）

#### 【P2】ApplicationDetailPage 分页竞态
- **文件**: apps/admin-web/src/pages/ApplicationDetailPage.tsx:669-682
- **后果**: 快速翻页时旧响应覆盖新数据，需再次点击纠正
- **原因**: fetchReleases 缺序列号守卫

#### 【P2】AgentSessionsPage 轮询与筛选竞态
- **文件**: apps/admin-web/src/pages/AgentSessionsPage.tsx:107-122
- **后果**: 筛选后看到旧数据，需等 15 秒或手动刷新
- **原因**: 15 秒轮询与筛选变化无序列号守卫

#### 【P2】autoflow-sdk callback 重试丢连接池
- **文件**: packages/autoflow-sdk/autoflow_sdk/callback.py:236
- **后果**: 每次重试新建 httpx.Client，浪费 TLS 握手耗时
- **修复**: 实例级 _get_client 单例（对齐 autocodeflow-notify）

#### 【P2】ExecutionsPage/TaskListPage/UserManagementPage URL 深链接失效
- **文件**: apps/admin-web ExecutionsPage.tsx:134-184 等
- **触发**: 组件已挂载，导航到 `/executions?status=failed`
- **后果**: 通知铃铛"查看失败"链接无效，列表显示错误数据，无法分享筛选链接
- **原因**: URL 写回 effect 覆盖 query params，未监听 location.search

#### 【P2】audit/index.tsx 筛选按钮与实际查询不一致
- **文件**: apps/admin-web/src/pages/audit/index.tsx:172
- **后果**: "重置"按钮出现但列表未筛选，CSV 导出数据错误
- **原因**: hasFilters 读 pending state，查询用 filters state

#### 【P2】ApplicationDetailPage 分页竞态
- **文件**: apps/admin-web/src/pages/ApplicationDetailPage.tsx:669-682
- **后果**: 快速翻页时旧响应覆盖新数据，需再次点击纠正
- **原因**: fetchReleases 缺序列号守卫

#### 【P2】AgentSessionsPage 轮询与筛选竞态
- **文件**: apps/admin-web/src/pages/AgentSessionsPage.tsx:107-122
- **后果**: 筛选后看到旧数据，需等 15 秒或手动刷新
- **原因**: 15 秒轮询与筛选变化无序列号守卫

### P3-低严重度（1 个）

#### 【P3】autocodeflow-node-sdk 熔断器探测错误掩盖
- **文件**: packages/autocodeflow-node-sdk/src/http-client.ts:579
- **后果**: half-open 探测失败抛 CircuitBreakerOpenError，真实 503/超时被掩盖
- **修复**: 探测失败耗尽重试时直接 throw error，不 continue

---

## 基线测试状态

| 组件 | 状态 | 说明 |
|---|---|---|
| typecheck:all | ✅ 全绿 | 全部 TS 项目 0 错 |
| lint 门禁 | ✅ 全绿 | no-hoisting + lint-gates |
| executor-node | ✅ 修复后全绿 | 35/35（修复前 4 失败） |
| executor-python | ⏳ 运行中 | |
| admin-web | ⏳ 运行中 | vitest 资源竞争 |
| admin-api | ⚠️ 环境超时 | 单独跑全绿，并发跑超时（非产品缺陷） |
| python packages | ✅ 全绿 | pypi 126 / sdk 144 / libs 137 |
| 自检脚本 | ✅ 修复后全绿 | test:qwen 纳入 CI |

---

## 统计

| 严重度 | 数量 | 已修复 | 待修复 |
|--------|------|--------|--------|
| P1-高  | 2    | 0      | 2      ||------|--------|--------|
| P1-高  | 1    | 0      | 1      |
| P2-中  | 8    | 0      | 7      |
| P3-低  | 1    | 0      | 1      |
| 测试/门禁 | 3 | 3      | 0      |
| **总计** | **13** | **3** | **9** |

---

## 进行中

- 4 个子代理仍在审计：admin-api 核心、admin-api 安全、执行器、构建脚本
- executor-python / admin-web 基线测试运行中