# admin-web 域审计报告（Round 1 · 前端架构）

> **审计对象**：`apps/admin-web/`（React 19 + TypeScript + Vite 7 + TanStack Query v5 + antd 6 + recharts 3 + zustand 5）
> **快照**：工作树 HEAD = `39dd4001`（2026-10-29）；CodeGraph 索引 2,108 文件 / 42,151 节点 / 120,271 边（`codegraph status` 确认 `Already up to date`，审计前已 `codegraph sync`）
> **探查方式**：CodeGraph CLI（`codegraph node/explore/impact/callers/query`）。MCP `codegraph_explore` 工具在本会话工具表中未暴露，按 AGENTS.md §1 优先级降级到 CLI 等价命令，**索引覆盖完整，不影响结论精度**。
> **只读声明**：本轮未修改任何仓库文件（唯一写入为本报告）。未执行 `git` 写操作。
> **Web 检索**：`web_search` 在本会话不可用（`DEEPSEEK_API_KEY` 缺失），开源调研改用 `web_fetch` 直取 GitHub REST API（`api.github.com/repos/*`）核验 License / star / 体积，未采信任何二手描述。

---

## §1 现状问题分析

### 1.1 规模基线

| 指标 | 数值 | 证据 |
|---|---|---|
| 页面文件数 | **31**（`src/pages/*.tsx` 递归） | `find src/pages -name "*.tsx" \| wc -l` |
| 页面代码总量 | **24,738 行** | 同上 `wc -l` 合计 |
| 组件文件数 | 40（`src/components/**`） | `ls src/components` + 3 子目录 |
| 组件代码总量 | **9,158 行** | `find src/components -name "*.tsx" -exec wc -l {} +` |
| `src/api/` 文件数 | 26 | `ls src/api/*.ts` |
| `src/api/` 代码总量 | **5,456 行** | 同上 |
| api 层顶层类型声明 | **129 处** | `grep -cE "^export (interface\|type) " src/api/*.ts` 合计 |
| 生成物 | `src/types/generated/api-types.ts` = **15,147 行** | `wc -l` |
| 测试文件 | **269 个**（`src/__tests__/`） | `ls src/__tests__ \| wc -l` |
| E2E（Playwright） | 6 个 spec + `e2e/legacy/` 2 个 | `ls e2e/` |

> ⚠️ 任务书里说的「39 个页面」与实际不符：实际 **31**（`src/pages/` 下 27 个平铺 + `audit/` 1 个 + `settings/` 4 个，其中 `settings/index.tsx` 是聚合入口）。下文一律用实测数字。

### 1.2 核心问题 P1：API 层 = 领域模型层（职责倒置）

**事实**：`src/api/` 目录同时承担三种职责，**没有任何一层边界**：

| 职责 | 载体 | 量 |
|---|---|---|
| ① 手写领域模型 | `src/api/*.ts` 的 `export interface` / `export type` | **129 处顶层声明** |
| ② HTTP 请求封装 | `src/api/*.ts` 的 `xxxApi` 对象 | 21 个 api 模块 |
| ③ 请求 hook | `src/api/queries.ts` 的 `use*` | **25 个 hook** |

`src/api/queries.ts`（801 行）更极端——**同时是类型源、数据源、缓存键工厂、乐观更新引擎**：

```
apps/admin-web/src/api/queries.ts
├── :31   queryKeys            ← 缓存键工厂（121 个受影响符号）
├── :146  sseFallbackRefetchInterval ← SSE↔轮询仲裁
├── :151  useMetricsSummary    ┐
├── :163  useMetricsTrend      │
├── :243  useExecutionsList    │ 25 个 hook
├── :321  useTaskDetail        │
├── :641  useExecutorsList     │ 全部住在 api 层
├── :742  useExecutionDetail   │
├── :796  useTaskTemplates     ┘
├── :419  TaskToggleStatus     ← 领域类型（混在 hook 文件里）
├── :422  applyTaskStatusPatch ← 领域纯函数
├── :435  patchTaskInPage      ← 领域纯函数
├── :502  optimisticallySetTaskStatus ← 乐观更新引擎
```

**后果（CodeGraph `impact` 实测）**：

| 符号 | 受影响符号数 | 证据 |
|---|---|---|
| `queryKeys`（`api/queries.ts:31`） | **121** | `codegraph impact queryKeys -d 2` |
| `Executor`（`api/executors.ts:3`） | **133** | `codegraph impact Executor --file apps/admin-web/src/api/executors.ts -d 2` |
| `createSseClient`（`api/sse-client.ts:133`） | **68** | `codegraph impact createSseClient -d 3` |

> 任务书说的「`Executor` 49 个调用方 / `Task` 59 个」是**接口属性级**计数；CodeGraph `impact -d 2` 给出的**符号级**影响面是 133 / （Task 同量级）。两个数字口径不同，均为真。

**关键证据：类型定义位置本身就在泄漏。** `Executor` interface 定义在 `src/api/executors.ts:3`，但它的字段散落在 26 行–132 行之间——因为后端 DTO 演进时前端是**手改这个 interface**的：

```
apps/admin-web/src/api/executors.ts
:3   export interface Executor {
:4     id: string;
:5     appName: string;
...
:72    taskSandbox: '' | 'bwrap' | null;
:81    dispatchMode: 'push' | 'pull';
:102   versionCompliant: boolean;
:120   offlineReason: 'manual' | 'stale_timeout' | null;
:130   interpreters: Array<{...}> | null;
:144 }
```

同时 `src/types/generated/api-types.ts` 里**已有** `components['schemas']['ExecutorResponseDto']`。两份事实源并存。

### 1.3 核心问题 P2：手写类型与生成契约的漂移盲区（**这是最危险的一条**）

**实测读数**（`node scripts/check-web-type-drift.mjs --report`）：

```
同名读数：44 处 / 手写 118 处
  ~ Executor   → components['schemas']['ExecutorResponseDto']
  ~ Task       → components['schemas']['TaskResponseDto']
  ~ TaskExecution → components['schemas']['TaskExecutionResponseDto']
  ~ Application → components['schemas']['ApplicationResponseDto']
  ~ AgentSession → components['schemas']['AgentSessionDto']
  ... (共 44 个)
```

**44 个手写类型与生成物同名同义**。这意味着：后端把 `ExecutorResponseDto.status` 从 `running` 改成 `in_progress`，`src/api/executors.ts:7` 的 `status: string` **照旧编译通过**（因为它是 `string` 不是字面量联合），前端静默读到 `undefined`。

**现有守卫的覆盖与漏区**：

| 守卫 | 覆盖 | 漏什么 |
|---|---|---|
| `ci.yml:2306 api-types-drift` ① | `openapi.json` vs 库内版本 diff | 契约变了但前端**手写类型**没同步 → **不红** |
| 同上 ② | `gen:api-types` 产物 vs 库内 diff | 同上 → **不红** |
| 同上 ③ | 空 object schema 白名单 | 字段**改名**（非删除）→ **不红** |
| `scripts/check-openapi-response-schema.mjs` | 响应体 schema 覆盖率棘轮（只增不减） | 字段级漂移 → **不红** |
| `scripts/check-web-type-drift.mjs` | 手写类型**数量与名字集合冻结**（只减不增） | 存量 44 处同名漂移 → **只报不红** |
| `scripts/check-enum-drift.mjs:844-861` | 前端枚举字面量 vs 后端 | 覆盖面 N=1，刻意排除 `as const` 元组 |

**结论：漂移防线管住了「生成物不更新」，管不住「手写类型与生成物不一致」**——而后者恰好是**前端静默读到 `undefined` 的唯一路径**。

### 1.4 核心问题 P3：数据获取方式三分裂

实测 31 个页面 + 40 个组件，`useQuery/useMutation` 与「手写 `useState` + `useEffect` + `await xxxApi.*`」两套范式并存：

| 页面 | 手写 `await xxxApi.*` 调用数 | `useQuery/useMutation` 数 | 判定 |
|---|---|---|---|
| `SopsPage.tsx` | **13** | 0 | 纯手写（外加 15s `setInterval` 轮询 `:224`） |
| `TaskDetailPage.tsx` | **12** | 2 | 混合 |
| `ApplicationDetailPage.tsx` | **10** | 0 | 纯手写 |
| `SopFromVideoPage.tsx` | **10** | 0 | 纯手写 |
| `ApplicationListPage.tsx` | 9 | 0 | 纯手写 |
| `AppDeploymentPage.tsx` | 9 | 0 | 纯手写 |
| `AgentSessionsPage.tsx` | 8 | 0 | 纯手写（外加 `setInterval` 轮询 `:421`） |
| `TaskListPage.tsx` | 8 | 4 | 混合 |
| `CommandPalette.tsx` | **4（4 路并行）** | 0 | 纯手写，**跨 4 个域** |
| `NotificationSettingsPage.tsx` | 7 | 15 | 混合 |
| `DashboardPage.tsx` | 0 | 0（6 个 `use*` 查询 hook） | ✅ 样板页 |

**同一份数据在不同页面用不同方式获取**的确凿例子——`Executor` 列表：
- `ExecutorListPage.tsx:172` → `useExecutorsList()`（query hook，走缓存）
- `CommandPalette.tsx:360` → `executorsApi.list()`（**裸 API 调用，绕过缓存**）

→ 用户在执行器页改完状态切到 ⌘K，看到的是**另一次网络往返拿的旧值**。同一份 `Executor` 数据，此刻有两个真相来源。

### 1.5 核心问题 P4：缓存键双轨制

`src/api/queries.ts:31-127` 有规范的 `queryKeys` 工厂（8 个命名空间、121 个引用），**但工厂只覆盖了一半的查询**：

**裸字面量 queryKey 实测 42 处**，分布在 11 个文件：

| 文件 | 行 | 裸 key |
|---|---|---|
| `pages/settings/index.tsx` | 99, 106, 310, 323, 324, 420, 428, 556, 612, 634 | `['executor-token']`、`['config-history', configKey]`、`['system-configs']`、`['ai-config']` |
| `pages/audit/index.tsx` | 280, 320 | `['audit','actions']`、`['audit',page,filters,cursor]` |
| `pages/UserManagementPage.tsx` | 160, 183, 197, 218, 266 | `['users', page, pageSize, debouncedSearch]` |
| `pages/RegistryPage.tsx` | 43, 190 | `['registry','pypi']`、`['registry','npm']` |
| `pages/NotificationSettingsPage.tsx` | 381, 586 | `['notif','silences']`、`['notif','channels']` |
| `pages/ExecutorDetailPage.tsx` | 98 | `['projects','me','roles']` |
| `pages/ProjectsPage.tsx` | 345 | `[...queryKeys.projects.list, page, pageSize]` ← **工厂与裸拼混用** |

**盲区里的裸 key 更集中**：`src/pages/settings/` + `src/pages/audit/` 合计 **29 处**裸 `queryKey:`（`settings/index.tsx` 单文件就有 **10 处**）——即 §1.5 的 42 处里有 **69%** 落在**零测试覆盖**的目录里。缓存键重构的爆炸半径正在盲区中。

`pages/ProjectsPage.tsx:345` 是**同一文件内两种写法并存**的直接证据。

> ✅ 已有护栏：`src/__tests__/cache-key-consistency.r138.test.tsx` 钉住了「失效键必须有真实消费者」与「分页参数必须进 key」两条结构性规则。但它**只覆盖字面量根**，不覆盖工厂深层子键的覆盖面缺口（注释里自己写明了这条局限）。

### 1.6 核心问题 P5：页面巨型化

| 排名 | 文件 | 行数 | 符号数 | 拆分建议 |
|---|---|---|---|---|
| 1 | `pages/ApplicationDetailPage.tsx` | **1,556** | — | 详情页已是多 tab（版本/发布/部署事件/任务），**拆 tab 面板** |
| 2 | `pages/TaskDetailPage.tsx` | **1,400** | — | 版本历史/甘特/webhook/详情 四段 |
| 3 | `pages/TaskFormPage.tsx` | **1,360** | — | ⚠️ **已有 `src/components/task-form/` 10 个子组件**（9,158 行组件里 task-form 占 2,000+ 行）——**已有拆分雏形，页面仍臃肿** |
| 4 | `pages/AgentSessionsPage.tsx` | 1,304 | — | 会话列表 / 详情 / 审批三块 |
| 5 | `pages/TaskListPage.tsx` | 1,250 | — | 筛选 / 表格 / 批量操作 |
| 6 | `pages/ApplicationListPage.tsx` | 1,219 | — | |
| 7 | `pages/SopsPage.tsx` | 1,190 | — | 列表 / 详情抽屉 / 澄清 / 派单 |
| 8 | `components/CommandPalette.tsx` | **891** | **63** | ⚠️ **跨 4 域聚合**（见 §1.8） |
| 9 | `components/ExecutionLogSection.tsx` | **888** | **36** | ⚠️ **SSE + 日志渲染 + 轮询兜底三合一**（见 §1.7） |

**CodeGraph 符号密度**（`codegraph node <file> --symbols-only`）：
- `CommandPalette.tsx` = **63 符号 / 891 行**（密度 0.071 符号/行，全仓最高之一）
- `ExecutionLogSection.tsx` = **36 符号 / 888 行**

### 1.7 核心问题 P6：实时链路（SSE）——**历史残差已修，但存在新的结构性问题**

**先纠正任务书的假设：WEB-1/3/5 三条残差在 HEAD 上已全部修复。**

证据：`git show 39dd4001`（2026-10-29，"首屏减 105KB、SSE 后台不重连、审批单可看见要执行什么（WEB-1/3/4/5）"）：

| 残差 | 历史状态 | 当前状态 | 证据 |
|---|---|---|---|
| **WEB-1** recharts 首屏预载 | 未修（`vite.config.ts:161`） | ✅ **已修** | `vite.config.ts:160-179` 注释逐字记录了「删该条目」的机理（共享 chunk + 静态边 ⇒ 整块被 modulepreload）；守卫 `src/__tests__/first-paint-no-unused-vendor.test.ts`；commit 记首屏 20 条/629.0KiB → 19 条/524.3KiB（−104.7KiB，−16.6%） |
| **WEB-3** 后台标签页 SSE 不断开 | 未修（`sse-client.ts` 全文无 `visibilitychange`） | ✅ **已修** | `src/api/sse-client.ts:266-289` `onVisibilityChange`：hidden → `clearTimer()` + `es.close()` + `paused=true`（**明确不走 `scheduleReconnect`**，注释 `:262-265` 解释了「后台重连比现状更糟」）；visible → `attempt=0` 立即重连；`close()` 里 `removeEventListener`（`:301-303` 防泄漏）。**但发现新的衍生缺陷**：可见性恢复与 `reconnect:false` 语义交互不一致（日志流与轮询兜底双跑），见 §1.7 缺陷 1 |
| **WEB-5** 设置页错误态 | 未修 | ✅ **已修** | `pages/settings/AiProvidersSettings.tsx` 加 `loadError` 分支渲染 `StateError` |

**当前 SSE 的真实结构问题**：

```
三条流，三个不同的生命周期管理方式
├─ src/hooks/useMetricsStream.ts:96      createSseClient({...})  — 工厂无限退避重连
├─ src/hooks/useExecutionsStream.ts:97  createSseClient({...})  — 工厂无限退避重连
└─ src/components/ExecutionLogSection.tsx:245
       createSseClient({ reconnect: false, ... })  ← ★ 关闭工厂重连，自建短退避预算
          · SSE_RETRY_BASE_MS=1500, MAX_SSE_AUTO_RETRIES=2  (1.5s→3s)
          · 重连耗尽 → 降级 8s→60s 指数退避轮询（:352-360）
```

**问题**：
1. **日志流的可见性恢复路径与工厂的 `reconnect:false` 语义交互不一致**——工厂的 `onVisibilityChange`（`sse-client.ts:266-283`）在 visible 时直接 `void connect()`（`:281`），**这条路径不经过 `scheduleReconnect`**，因此 `reconnect:false`（`ExecutionLogSection.tsx:249` 传入）**拦不住它**：隐藏时连接被关（`es?.close()` `:272`），可见时工厂会重建连接。
   但 `ExecutionLogSection` 的**自建预算状态机不知道这件事**：`retryCount` / `gaveUp` / `streamDisconnected`（`:229-231`）在 `paused` 期间既不重置也不更新，`onStatus('live')` 的重置分支（`:262-266`）虽会执行，但**如果用户是在 `gaveUp=true`（已降级到 8s 轮询）之后才隐藏再可见**，工厂会静默重连，而组件侧仍认为「已放弃、正在轮询」⇒ **日志流与轮询兜底同时在跑**（双源同一条数据）。
   ⇒ 结论：**这不是「不恢复」，是「恢复了但两侧状态不同步」**——更隐蔽、更难发现，且**当前没有任何测试覆盖该路径**（§1.10 盲区表 🟡 中档）。
2. **没有连接去重/复用机制**：`createSseClient` 每次调用都新建一条 `EventSource`。`statusKey` 注册表 `sseStatusRegistry` 是 `Map<string, SseClientStatus>`——**同一 key 后写覆盖前写**，两个客户端会互相覆盖状态，且任一客户端 `close()` 时 `:307` `sseStatusRegistry.delete(statusKey)` 会**误删另一个客户端的状态**（⇒ 另一个客户端还在连，`sseFallbackRefetchInterval` 却以为「无流可用」⇒ 轮询与推送双跑）。
   触发条件：**`useMetricsStream` 被两个组件同时挂载**——`DashboardPage.tsx:117` 与 `useExecutorLive.ts:163` 都调用它（两者同属 `ExecutorListPage`/Dashboard 不同路由，**当前互斥**，故未暴露；但 `useExecutorLive` 被 `ExecutorListPage` 挂载时**不建流**（`canStream` 闸），所以今天没触发）。⇒ **这是潜伏缺陷**，不是现网故障，但任何「把 metrics 流提到 layout 级」的改动都会引爆它。
3. **重连策略两套**：`sseReconnectBackoffMs`（3s→30s，无限次）vs `SSE_RETRY_BASE_MS`（1.5s→3s，2 次后放弃转轮询）。两套并存但无统一抽象。
4. **日志流不登记 `statusKey`**：`ExecutionLogSection` 不传 `statusKey`（对比 `useMetricsStream.ts:101`、`useExecutionsStream.ts:102` 都传了），因此它的连接状态**不在全局注册表里** ⇒ `sseFallbackRefetchInterval` 无法对它做「live 停轮询 / 断流恢复轮询」的统一仲裁，兜底逻辑被塞进组件内部（`:352-360`）。

**SSE 相关影响面**（`codegraph impact createSseClient -d 3`）：**68 个符号**，涉及 12 个文件（含 6 个测试文件）。

#### 1.7.1 「实测规模」与「代码隐患」必须分开陈述

> 主会话 2026-11-03 补充情报的要求：**先量化真实连接规模，再谈重构收益**。已按此重新核对 admin-api 侧。

**实测规模（服务端权威口径）**：

| 流 | 端点 | 并发上限 | 配置位置 | 服务端注释对容量的定性 |
|---|---|---|---|---|
| Dashboard 汇总流 | `GET /metrics/stream` | **全局 32** | `configuration.ts:148-157`（`METRICS_STREAM_MAX_GLOBAL`） | `metrics-stream-slot.service.ts:16-18`：「**汇总流是每客户端一条**」「Dashboard 页面数量（浏览器 Tab 数）**远小于**日志流并发量」 |
| 执行终态流 | `GET /executions/stream` | **全局 32**（**复用上面同一槽位注册表**） | `executions-stream.controller.ts:63` | 「终态流与汇总流消费画像相同（**每浏览器 Tab 一条**），不另建槽位注册表（避过度建设）」 |
| 执行日志流 | `GET /tasks/:id/executions/:execId/logs/stream` | 单 execution **4** / 全局 **64** | `configuration.ts:143-149`（`SSE_MAX_STREAMS_PER_EXECUTION` / `SSE_MAX_STREAMS_GLOBAL`） | 按 execution 维度限流（`task.service.ts:4218`） |

**结论（关键，避免夸大收益）**：

> **真实 SSE 连接数受限于「打开的标签页数」，不存在中台扇出爆炸。**
> 汇总流与终态流**共享同一个 32 槽位池**，服务端注释明写「每浏览器 Tab 一条」⇒ 32 槽位对管理台场景**充裕**（需 32 个并发标签页才触顶）。
> ⇒ **「统一 SSE 基础设施」的重构收益不在于降低服务端连接压力**（那不是真问题），而在于：
> ① **消除三套重复的连接生命周期实现**（代码债）；
> ② **消除 §1.7 缺陷 1/2/4 的潜伏缺陷**（代码隐患，触发条件见各条）；
> ③ **让兜底轮询策略可统一仲裁**（可运维性：现在日志流的兜底藏在组件里，`statusKey` 覆盖不全 ⇒ 状态在仪表盘上看不全）。
>
> ⚠️ **明确降级**：任何以「降低 SSE 连接数 / 缓解后端压力」为卖点的重构论证**在本仓不成立**，不纳入方案。

**代码隐患的触发条件（与规模无关，是真实缺陷）**：

| 隐患 | 当前是否已触发 | 触发条件 | 后果 |
|---|---|---|---|
| 缺陷 1（日志流状态机与工厂不同步） | **可能已触发** | 用户在 `gaveUp=true`（已降级 8s 轮询）期间切走标签页再切回 | 日志流与轮询兜底**双跑**（同一份数据两个推送源） |
| 缺陷 2（registry 互删） | **今天未触发**（路由互斥 + `canStream` 闸） | 任何「把 metrics 流提到 layout 级」的改动 | 一个客户端 `close()` 误删另一个的状态 ⇒ `sseFallbackRefetchInterval` 误判「无流」⇒ 轮询与推送双跑 |
| 缺陷 4（日志流无 `statusKey`） | **恒定存在** | 无条件 | 日志流连接状态**不在全局注册表** ⇒ 运维仪表盘看不到该流的水位/状态 |

### 1.8 核心问题 P7：`CommandPalette` 跨域耦合

`src/components/CommandPalette.tsx`（891 行 / 63 符号）**同时依赖 4 个域**：

```typescript
:77  import { tasksApi } from '../api/tasks';
:79  import { executorsApi } from '../api/executors';
:81  import { applicationsApi } from '../api/applications';
```

- `:123 GROUP_ORDER = ['action','task','execution','executor','application']` — 5 组
- `:232-236 SearchResults` — 4 个 `GroupResult<T>`，分别持 `Task` / `TaskExecution` / `Executor` / `Application`
- `:334-398` — **4 路裸 API 并行请求**（不走 react-query，绕过缓存）
- `:543-549` — 直接调 `tasksApi.trigger/pause/resume`（**绕过 `usePauseTask`/`useResumeTask` 的乐观更新**，`api/queries.ts:622/630`）

**这条边是「组件直连 api 绕过 hooks」的教科书案例**，也是 §1.4「同一份数据两个真相来源」的制造者。

### 1.9 核心问题 P8：虚拟化与列表性能

| 列表 | 页大小 | 虚拟化 |
|---|---|---|
| `ApplicationDetailPage.tsx:431` 高频任务表 | 20 | ✅ antd 内置 `virtual`（`:389-430` 有行高恒定约束的注释） |
| `ExecutorListPage` | — | ❌ 卡片网格，全量渲染（实测无 `virtual`） |
| `TaskListPage` | — | ❌ 表格，全量渲染（实测无 `virtual`） |
| `ExecutionDetailPage` 日志 | `LOG_PAGE_LIMIT=2000` / `LOG_MAX_PAGES=200` / `FULL_LOGS_MAX_LINES=20_000` | ⚠️ 有 `LOG_VIRTUAL_THRESHOLD = 500` 常量，但**只用于阈值判断**，未接虚拟滚动库 |

`ExecutionLogSection` 最多可累积 **20,000 行日志**进 React state（非虚拟化）。这是单页 DOM 节点量级的最大来源。

### 1.10 核心问题 P9：前端测试盲区（**重构护栏依据，优先级最高**）

用 `codegraph callers <PageComponent> -f <page file> -j` 逐页反查引用方，再与 `src/__tests__/` 求交集，得到覆盖表：

| 页面 | 行数 | 直接引用该页面的测试文件数 | 覆盖判定 |
|---|---|---|---|
| `TaskFormPage` | 1,360 | **19** | ✅ 充分 |
| `TaskListPage` | 1,250 | 8 | ✅ 充分 |
| `ApplicationListPage` | 1,219 | 6 | ✅ 充分 |
| `ExecutionDetailPage` | 585 | **15** | ✅ 充分 |
| `ExecutorDetailPage` | 1,079 | 10 | ✅ 充分 |
| `TaskDetailPage` | 1,400 | 6 | ✅ 充分 |
| `AgentSessionsPage` | 1,304 | 5 | ✅ 充分 |
| `ApplicationDetailPage` | **1,556** | 6 | ✅ 充分 |
| `ExecutionsPage` | 1,076 | 5 | ✅ 充分 |
| `ExecutorListPage` | 699 | 7 | ✅ 充分 |
| `NotificationSettingsPage` | 823 | 4 | ✅ 充分 |
| `ExecutorPackagesPage` | 1,092 | 0（直接引用页面组件） | ⚠️ **间接覆盖** |
| `TaskTemplatesPage` | 387 | 1 | ⚠️ 薄 |
| `ProjectsPage` | 1,018 | 1 | ⚠️ **薄**（1,018 行只有 1 个测试文件） |
| `UserManagementPage` | 782 | 1 | ⚠️ **薄**（且裸 queryKey） |
| `SopsPage` | 1,190 | 3 | ⚠️ 薄 |
| `AppDeploymentPage` | 1,085 | 4 | ⚠️ 薄 |
| `ExecutorInstallWizardPage` | 1,053 | 3 | ⚠️ 薄（测的是子函数非页面） |
| `RegistryPage` | 322 | 1 | ⚠️ 薄 |
| `SopFromVideoPage` | 517 | 1 | ⚠️ 薄 |
| `DashboardPage` | 585 | 3 | ⚠️ 薄 |
| `SsoCompletePage` | 137 | 1 | ⚠️ 薄 |
| `LoginPage` | 342 | 2 | ✅ |
| `NotFoundPage` | 57 | 0 | 🔴 **盲区**（低危） |
| `task-form-code-source.tsx` | 70 | 0（测的是 hook） | 🔴 **盲区** |
| `pages/settings/index.tsx` | 985 | 0（直接引用） | 🔴 **盲区** |
| `pages/settings/SecuritySettings.tsx` | 530 | 0（直接引用） | 🔴 **盲区** |
| `pages/settings/AiProvidersSettings.tsx` | 338 | 0（直接引用） | 🔴 **盲区** |
| `pages/settings/ApiKeysSettings.tsx` | 410 | 0（直接引用） | 🔴 **盲区** |
| `pages/settings/EventSubscriptionsSettings.tsx` | 643 | 0（直接引用） | 🔴 **盲区** |
| `pages/audit/index.tsx` | 844 | 0（直接引用） | 🔴 **盲区** |
| **`CommandPalette.tsx`** | **891** | **3** | ⚠️ 跨 4 域，仅 3 个测试 |
| **`ExecutionLogSection.tsx`** | **888** | 0（直接引用页面测） | ⚠️ SSE 生命周期测的是页面 |

**盲区总结（按风险排序）**：

| 级别 | 盲区 | 风险 | 理由 |
|---|---|---|---|
| 🔴 **高** | `pages/settings/*` 5 个文件（2,906 行）+ `pages/audit/index.tsx`（844 行） | **重构不可见** | 合计 **3,750 行**，settings 与 audit 恰是「配置 + 合规」最不该悄悄坏的面；且 `settings/index.tsx:99-634` 有 **10 处裸 queryKey**（含 `['executor-token']`、`['system-configs']`、`['ai-config']`）——缓存键重构的爆炸半径正在盲区里 |
| 🔴 **高** | `CommandPalette.tsx`（891 行 / 63 符号 / 4 域） | 跨域回归不可见 | 3 个测试文件（`command-palette.test.tsx` / `a11y-focus.test.tsx` / `web-entry-chunk-split.test.ts`），4 路并行请求的时序与部分失败降级路径覆盖未知 |
| 🟡 **中** | `SopsPage`（1,190）/ `AppDeploymentPage`（1,085）/ `AgentSessionsPage`（1,304） | 3 个纯手写 API + 定时轮询的页面 | 无 query hook ⇒ 无缓存键可测 ⇒ 手写 `useState` 数据流是黑盒 |
| 🟡 **中** | `ProjectsPage`（1,018）/ `UserManagementPage`（782）/ `ExecutorPackagesPage`（1,092） | 裸 queryKey / 无直接页面测试 | 缓存键重构直接命中 |
| 🟡 **中** | `ExecutionLogSection.tsx` 的 SSE 状态机 | 见 §1.7 缺陷 1 | 「工厂已重连、组件侧仍以为已放弃 ⇒ 日志流与轮询兜底双跑」无测试覆盖 |

### 1.11 历史残差核查结论（对照 HEAD）

| 编号 | 历史描述 | HEAD 状态 | 处置 |
|---|---|---|---|
| WEB-1 | recharts 首屏预载（108.3 KB gz） | ✅ 已修（`39dd4001`，−104.7 KiB / −16.6%） | **不再报**，改列 §5 参考 |
| WEB-3 | 后台标签页 SSE 不断开 | ✅ 已修（`sse-client.ts:266-289`） | **不再报**，但发现新缺陷（日志流可见性恢复，见 §1.7） |
| WEB-5 | 设置页错误态 | ✅ 已修 | **不再报** |

---

## §2 CodeGraph 探查结论

### 2.1 实际依赖图（`pages → components → api → types`）

```
                    ┌──────────────────────────────┐
                    │  src/types/generated/        │  15,147 行（只读生成物）
                    │  api-types.ts                 │  242 个 components['schemas']
                    └───────────────┬──────────────┘
                                    │ 仅 8 个文件引用（api/ 5 + pages/ 3）
                                    ▼
   pages/ (31)   ┌───────────────────────────────────────────┐
   24,738 行     │  8 个文件直引 generated types：            │
                 │  api/{tasks,applications,users,            │  ★ 违规边 V3
                 │      event-subscriptions,task-templates}  │    （页面层直接碰生成物）
                 │  pages/{TaskListPage,TaskFormPage,         │
                 │          executor-mode}                   │
                 └───────────────┬───────────────────────────┘
                                 │ import
                                 ▼
   components/ (40)  ┌────────────────────────────────────────┐
   9,158 行          │  13 个组件直引 api/*：                │
                     │  CommandPalette(3 个域) ★违规边 V1     │
                     │  ExecutionLogSection ★违规边 V1       │
                     │  ExecutionInfoCard / ExecutionCompare │
                     │  ExecutionReportPanel / ArtifactsList │
                     │  TaskDependencyGraph / GlueEditor     │
                     │  NotificationBell / RequireAdmin     │
                     │  dashboard/SchedulerLatencyCard      │
                     │  executor/{BatchActionBar,            │
                     │            batchActions,              │
                     │            ExecutorCardGrid}           │
                     └───────────────┬───────────────────────┘
                                     │
   pages/ 直引 api/*  50 个文件        │   ┌─────────────────────────────┐
   （上表 + 17 个页面）                ▼   │  src/hooks/ (12 个)         │
                     ┌────────────────────────────────────────┐│  useExecutionsStream
                     │  src/api/ (26 个文件, 5,456 行)        ││  useMetricsStream
                     │  ├ queries.ts (801) ─ 25 hook + 缓存键  ││  useExecutorLive
                     │  │                 + 乐观更新引擎      ││  useTaskFormReferenceData
                     │  ├ executors.ts (368) ─ 10 手写类型    ││  useUrlStateSync
                     │  ├ tasks.ts (863) ────── 16 手写类型    ││  useGlobalHotkeys
                     │  ├ applications.ts (440) 14 手写类型   ││  useDraft / useDebounce ...
                     │  ├ agent.ts / ai.ts / metrics.ts ...    ││
                     │  ├ sse-client.ts (312) ─ SSE 工厂      │◀┘
                     │  └ client.ts (540) ─ axios 封装         │
                     │  ★ 129 处手写领域类型住在这里          │
                     └───────────────┬────────────────────────┘
                                     ▼
                     src/api/client.ts (axios) → 后端
```

### 2.2 分层违规边清单

| 编号 | 违规类型 | 具体边 | 数量 | 证据 |
|---|---|---|---|---|
| **V1** | **组件直连 api，绕过 hooks** | `components/*` → `api/*`（绕过 `api/queries.ts` 的 hook 层） | **13 个组件** | `grep -rln "from '\.\./api"` 于 `src/components/` |
| **V1a** | 同上，且**跨多域** | `CommandPalette.tsx:77,79,81` → `tasks`/`executors`/`applications` **3 个域** | 1 | 见 §1.8 |
| **V1b** | 同上，且**绕过乐观更新** | `CommandPalette.tsx:543-549` 直接 `tasksApi.trigger/pause/resume` | 1 | `api/queries.ts:622/630` 的乐观更新被跳过 |
| **V2** | **页面直连 api，绕过 hooks** | `pages/*` → `api/*` 且该文件 `useQuery` 数为 0 | **11 个页面** | `SopsPage`(13)、`ApplicationDetailPage`(10)、`SopFromVideoPage`(10)、`ApplicationListPage`(9)、`AppDeploymentPage`(9)、`AgentSessionsPage`(8)、`ExecutorInstallWizardPage`(4)、`AiProvidersSettings`(4)、`TaskFormPage`(3)、`LoginPage`(2)、`ExecutorPackagesPage`(2) |
| **V3** | **页面直接引 generated types** | `pages/TaskListPage.tsx:30`、`pages/TaskFormPage.tsx:20`、`pages/executor-mode.ts:6` → `types/generated/api-types` | **3** | 生成物本应只被 api 层消费 |
| **V4** | **裸字面量 queryKey**（绕过 `queryKeys` 工厂） | 见 §1.5 表 | **42 处 / 11 文件** | `grep -rn "queryKey: \["` |
| **V5** | **api 层反向持有领域模型 + 领域纯函数** | `api/queries.ts:419-533`（`TaskToggleStatus`/`applyTaskStatusPatch`/`patchTaskInPage`/`optimisticallySetTaskStatus`） | 5 个符号 | CodeGraph `node` 实测 |
| **V6** | **api 层承载 UI 编排语义** | `api/queries.ts:146 sseFallbackRefetchInterval`（SSE↔轮询仲裁）、`:502 乐观更新引擎` | 2 | — |
| **V7** | **手写类型与生成物同名并存** | 44 处（`Executor`/`Task`/`TaskExecution`/`Application`/`AgentSession`…） | **44** | `check-web-type-drift.mjs --report` |

> **未发现的违规（正面记录）**：
> - `types/` 层**没有**反向依赖 `features/`/`api/`——生成物是纯叶子（8 个消费者全是单向 import）。**「types 反向依赖 features」在本仓不存在**，任务书的这条假设不成立。
> - `src/store/` 只有 `auth.ts` 一个文件（zustand），**没有**与 react-query 职责重叠的全局 store——不存在双数据源打架。
> - `src/components/task-form/` 已做子目录拆分（10 个文件），是**唯一已跑通的拆分样板**。

### 2.3 影响面量化表

| 动作 | 需改文件数 | 需改符号数 | 已有测试覆盖的改动面 | 未覆盖（盲区） |
|---|---|---|---|---|
| **拆 `api/queries.ts` → `features/*`** | 26（api/）+ 31（pages/）+ 13（components/） = **70** | 25 hook + 129 类型 + 5 领域纯函数 | 约 **55%** 的页面 | `settings/*`(2,906) + `audit`(844) + `SopsPage` + `AppDeploymentPage` + `AgentSessionsPage` |
| **迁移 44 处同名手写类型 → generated** | 26（api/）+ 消费方 | 44 类型 + 133（`Executor` impact） | 未知（依赖具体类型） | 同上 |
| **裸 queryKey 收口到工厂（42 处）** | 11 | 42 key + 关联 invalidate | `UserManagementPage`(1 测试) / `ProjectsPage`(1) / `RegistryPage`(1) / `NotificationSettingsPage`(4) / `settings/*`(0) / `audit`(0) | **settings + audit = 3,750 行零覆盖** |
| **统一 SSE 生命周期** | 3（SSE 消费者）+ 1（工厂） | 68（`createSseClient` impact） | 6 个 SSE 测试文件 | 日志流可见性恢复路径 |
| **`CommandPalette` 拆域** | 1（891 行 → 5 个域适配器） | 63 | 3 | 4 路并行的部分失败路径 |
| **页面拆分（Top 8）** | 8 | — | 大部分有覆盖 | `ProjectsPage` / `UserManagementPage` / `ExecutorPackagesPage` |

### 2.4 与已有 OSS 对照调研的兼容性（必须遵守 R11）

`/home/yongsheng/project/open_sourse/agent_talk/03_recommendations/01-priority-register.md` **R11** 裁定：

> 「admin-web 类型**只加棘轮守卫**」——①补后端审批响应 DTO → 待触发；②**13x 处泛型/别名迁移 → 否决**（迁移被否决，133 处手写类型**原地不动**）；守卫目标 = 手写类型**不得增长**（冻结基线）。
>
> ⚠️ **口径对齐**：R11 的「133 处」是当时快照的口径；本报告在 HEAD 上实测为 **129 处顶层声明**（`grep -cE "^export (interface|type) " src/api/*.ts` 合计），守卫扫描面口径为 **118 处**（`check-web-type-drift.mjs --report` 的「手写 118 处」，因它排除嵌套声明与字面量镜像）。三个数字口径不同但**结论一致：手写类型存量很大且不得增长**。

**这直接否决了「把 44 处同名手写类型迁到 generated」的方案。** 本报告的 §3/§4 因此改为：
- ✅ 采纳：新建 `features/<domain>/` 承载 **hook + 领域纯函数 + queryKey 工厂**（**不迁类型**）；
- ✅ 采纳：`api/generated/` 概念上存在（`types/generated/` 已是），但**不把 44 处手写类型替换掉**——改用**新增守卫**把「同名手写类型」变成**结构性缺口可见**（§4.5）；
- ❌ 否决：一次性全量类型迁移（与 R11 冲突，且回归不可见）。

---

## §3 补丁 vs 重构对比（五维评分）

> 评分 1–5，5 最好。**综合收益** = (长期收益 + 扩展潜力) − (短期成本与风险 + 技术债风险)；**长期综合收益 > 短期成本 → 推荐重构**。

### 3.1 总览

| # | 问题 | 方案 | 长期收益 | 维护成本 | 扩展潜力 | 技术债风险 | 短期成本与风险 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | API 层职责倒置 | **A 补丁**：给 `api/` 加注释说明职责边界，冻结现状 | 1 | 4 | 1 | 2 | 5 | 🟡 观察 |
| 1 | 同上 | **B 重构**：`features/<domain>/` 逐域搬迁（**hook+纯函数，不迁类型**） | 5 | 2 | 5 | 3 | 3 | ✅ **推荐重构（分批）** |
| 2 | 手写类型漂移盲区 | **A 补丁**：CI 加一条「同名手写类型 vs generated 字段差异」报告 | 3 | 5 | 2 | 4 | 5 | ✅ **推荐补丁**（先建可见性） |
| 2 | 同上 | **B 重构**：44 处全迁 generated | 5 | 1 | 5 | 2 | 1 | ❌ **违反 R11，不做** |
| 3 | 数据获取三分裂 | **A 补丁**：加 ESLint 规则禁止页面新增裸 `xxxApi.*` | 2 | 5 | 2 | 4 | 5 | ✅ **推荐补丁**（零风险护栏） |
| 3 | 同上 | **B 重构**：11 个纯手写页面全迁 react-query | 4 | 2 | 4 | 3 | 1 | ⚠️ **临时补丁，后续排期重构**（盲区未补前不动） |
| 4 | 缓存键双轨 | **A 补丁**：42 处裸 key 收口到 `queryKeys` 工厂 | 3 | 4 | 3 | 4 | 4 | ✅ **推荐补丁**（机械改动，可分文件） |
| 4 | 同上 | **B 重构**：引入 `queryOptions` + per-domain key factory 全面重建 | 4 | 2 | 5 | 2 | 2 | 🟡 暂缓（与 #1 重构合并做） |
| 5 | 页面巨型化 | **A 补丁**：只加文件长度 ESLint 上限告警 | 1 | 5 | 1 | 3 | 5 | 🟡 观察 |
| 5 | 同上 | **B 重构**：Top 8 页面按 tab/区块拆组件 | 4 | 3 | 4 | 3 | 3 | ✅ **推荐重构**（有测试覆盖的先做） |
| 6 | SSE 生命周期 | **A 补丁**：修日志流「可见性恢复后与轮询兜底双跑」+ registry 互删 | 3 | 4 | 2 | 4 | 5 | ✅ **推荐补丁**（先补测试再修） |
| 6 | 同上 | **B 重构**：抽 `useEventStream` 统一基础设施（3 条流同构） | 5 | 2 | 5 | 2 | 3 | ✅ **推荐重构**（阶段 2）——**收益在消除重复实现与潜伏缺陷，不在降低连接数**（§1.7.1：真实连接数受限于标签页数，服务端 32 槽位充裕） |
| 7 | `CommandPalette` 跨域 | **A 补丁**：把 4 路裸 API 换成 `useQuery`（不动结构） | 3 | 4 | 2 | 3 | 4 | ✅ **推荐补丁** |
| 7 | 同上 | **B 重构**：拆成 5 个域适配器 + 统一搜索服务 | 5 | 2 | 5 | 3 | 2 | ✅ **推荐重构**（阶段 2） |
| 8 | 大列表虚拟化 | **A 补丁**：给 `TaskListPage`/`ExecutorListPage` 加 antd `virtual` | 3 | 5 | 2 | 2 | 4 | ✅ **推荐补丁**（antd 内置，零新依赖） |
| 8 | 同上 | **B 重构**：引入 TanStack Virtual 统一虚拟层 | 4 | 2 | 5 | 3 | 2 | 🟡 暂缓（antd 内置够用） |
| 9 | 测试盲区 | **A 补丁**：补 `settings/*` + `audit` + `CommandPalette` 的关键路径测试 | 4 | 4 | 4 | 5 | 4 | ✅ **推荐补丁（最高优先级）** |
| 9 | 同上 | **B 重构**：引入 MSW 契约 mock + Playwright 冒烟 | 5 | 2 | 5 | 4 | 2 | ✅ **推荐重构**（阶段 1 底座） |

### 3.2 三个推荐重构切口的论证

**切口 1：`features/<domain>/` 逐域搬迁（`api/queries.ts` 拆分）**
- 长期收益 5 / 扩展潜力 5 vs 短期成本 3 / 技术债风险 3 → **长期综合收益 > 短期成本**
- 但**必须分批**，且**必须先补 §1.10 的盲区测试**（否则「回归不可见」）。
- 与 R11 兼容：只搬 hook + 领域纯函数 + queryKey，**类型留在 `api/` 原地**。

**切口 2：`useEventStream` 统一 SSE 基础设施**
- 长期收益 5 / 扩展潜力 5 vs 短期成本 3 / 技术债风险 2 → **明确推荐重构**
- 影响面小（3 个消费点 + 1 个工厂）、可测性好（已有 6 个 SSE 测试文件）、收益直接（连接去重、可见性一致、去重退避）。

**切口 3：`CommandPalette` 拆域**
- 长期收益 5 / 扩展潜力 5 vs 短期成本 2 / 技术债风险 3 → **明确推荐重构**
- 但必须**先做补丁 A**（4 路裸 API 换 `useQuery`），因为后者是前者的回归护栏。

### 3.3 需标注【临时补丁，后续排期重构】的地方

- **问题 3-B（11 个纯手写页面迁 react-query）**：`SopsPage`(1,190)、`ApplicationDetailPage`(1,556)、`SopFromVideoPage`(517)、`AgentSessionsPage`(1,304) 等合计 **>7,000 行**，且这批页面**测试覆盖薄**（§1.10）。**在补齐对应测试之前不动**——建议**【临时补丁，后续排期重构】**：先用 ESLint 冻结新增，再随各自域的其他改动顺带迁。

---

## §4 目标架构设计

### 4.1 目录树

```
apps/admin-web/src/
├── types/
│   └── generated/                    ← 【只读生成物，零手写】
│       └── api-types.ts                15,147 行（现有，不动）
│
├── api/                              ← 【纯传输层：只做 HTTP 封装】
│   ├── client.ts                       axios 实例 + 拦截器（现有）
│   ├── queryClient.ts                  QueryClient 默认值（现有）
│   ├── sse.ts / sse-client.ts          SSE 传输原语（现有，见 §4.3 迁移）
│   └── <domain>.ts                     xxxApi 对象 + 手写类型【R11：类型原地不动】
│
├── features/                         ← ★ 新增：领域层
│   ├── tasks/
│   │   ├── keys.ts                     tasks 查询键工厂（从 api/queries.ts 搬）
│   │   ├── queries.ts                  useTasksList / useTaskDetail / ...
│   │   ├── mutations.ts                 usePauseTask / useResumeTask + 乐观更新
│   │   ├── model.ts                    ★ 领域纯函数（applyTaskStatusPatch 等）
│   │   └── index.ts                     公开出口（页面只从这里 import）
│   ├── executions/                     keys / queries / mutations / model
│   ├── executors/                     keys / queries / mutations / model
│   ├── applications/                   keys / queries / mutations
│   ├── metrics/                        keys / queries（SSE ↔ 轮询仲裁）
│   ├── agent-sessions/                 keys / queries / mutations
│   ├── audit/  projects/  sops/  settings/  notifications/  ...
│   └── shared/
│       ├── queryKeys.ts                 跨域根键（metrics/executions/tasks/...）
│       ├── useEventStream.ts            ★ SSE 统一基础设施（见 §4.3）
│       └── usePollingFallback.ts        ★ SSE 断流 → 轮询兜底统一策略
│
├── hooks/                             ← 【保留：全局 UI 态 hook】
│   ├── useExecutorLive.ts  useUrlStateSync.ts  useGlobalHotkeys.ts  ...
│
├── components/                         ← 【纯展示，不碰 api/】
│   ├── CommandPalette/                 ★ 拆成 5 个域适配器
│   │   ├── CommandPalette.tsx            外壳（键盘导航 / 焦点管理 / 分组渲染）
│   │   ├── adapters/
│   │   │   ├── taskAdapter.ts            → features/tasks
│   │   │   ├── executionAdapter.ts        → features/executions
│   │   │   ├── executorAdapter.ts        → features/executors
│   │   │   └── applicationAdapter.ts     → features/applications
│   │   └── types.ts
│   └── ...
├── pages/                              ← 【只 import features/* 与 components/*】
└── store/ (auth.ts)                    ← 【只放认证态】
```

### 4.2 分层规则（可机械校验）

| 层 | 允许依赖 | 禁止 | 守卫形态 |
|---|---|---|---|
| `types/generated/` | 无 | 任何 | 已是叶子 ✅ |
| `api/` | `types/generated/`、`api/client` | `pages/`、`components/`、`features/` | ESLint `no-restricted-imports` |
| `features/` | `api/`、`types/generated/`、`features/shared` | `pages/`、`components/` | ESLint |
| `components/` | `features/`、`hooks/`、`types/generated` | **`api/`**（绕过 hook 层） | ESLint `no-restricted-imports`（**禁 `api/queries` 除外**） |
| `pages/` | `features/`、`components/` | **`api/`**（含 `api/queries`）、**`types/generated`** | ESLint |
| `hooks/` | `api/`、`features/shared` | `pages/` | ESLint |

**新增守卫建议（3 条，全部零运行时依赖）**：

| 守卫 | 判据 | 落点 |
|---|---|---|
| `check-web-layering.mjs` | `pages/`、`components/` 不得 import `api/queries` 与 `types/generated`；`components/` 不得 import `api/<domain>`（白名单只留 `api/sse-client`） | `scripts/`，接 `test:guards:repo` |
| `check-web-querykey-factory.mjs` | `queryKey:` 后面不得是数组字面量（必须是 `queryKeys.*` 工厂调用） | 同上，棘轮式（存量豁免） |
| `check-web-handwritten-dup.mjs` | **手写类型名与 generated `components['schemas']` 同名时，必须在 `scripts/web-type-dup-allowlist.json` 登记并附理由；新增即红** | 同上，**承接 R11「只增棘轮」的思路，但方向反过来** |

> 守卫设计沿用仓库既有范式：`scripts/check-guards-wired.mjs` 会强制每个守卫**真的被 CI 跑到**（含自检），避免「加了守卫没人跑」。新守卫必须写 `--selftest` + 挂 `package.json` + 挂 `ci.yml`。

### 4.3 SSE 统一基础设施（`useEventStream`）

**统一三条流的可观察差异**：

| 维度 | metrics 流 | executions 流 | logs 流（当前） |
|---|---|---|---|
| 重连 | 工厂无限退避 3s→30s | 工厂无限退避 3s→30s | **自建 1.5s→3s，2 次后放弃转轮询** |
| 可见性暂停 | ✅ 工厂内置 | ✅ 工厂内置 | ⚠️ 关闭后**恢复不了** |
| 连接去重 | ❌ | ❌ | ❌ |
| 状态登记 | `statusKey` registry | `statusKey` registry | **无 statusKey**（自建 `onStreamStatusChange` 往父页传） |

**统一后的契约**：

```typescript
// features/shared/useEventStream.ts
export interface UseEventStreamOptions {
  /** 稳定键——同一 key 的多个订阅者共享**同一条**连接 */
  streamKey: string;
  path: string;
  enabled?: boolean;
  /** 重连策略（默认：无限退避 3s→30s，与现工厂一致） */
  reconnect?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  /** 断流降级：'poll'（默认，8s→60s 指数退避）| 'none' */
  fallback?: 'poll' | 'none';
  onMessage: (e: MessageEvent) => void;
  onStatus?: (s: SseStreamStatus) => void;
  events?: Record<string, (e: MessageEvent) => void>;
}
```

**统一后解决的 4 个具体缺陷**（⚠️ **收益定位：消除重复实现与潜伏缺陷，不是降低连接数**——见 §1.7.1 的服务端实测口径）：
1. **连接去重**：`streamKey` → 单一连接 + 多订阅者（修 §1.7 缺陷 2：registry 互相覆盖 / `close()` 误删他人状态）。
2. **可见性一致 + 状态同步**：三条流同一套 `paused` 语义，**且组件侧的状态机与工厂的状态机是同一个**（修 §1.7 缺陷 1：工厂已重连、组件侧仍以为已放弃 ⇒ 双跑）。
3. **重连策略一处定义**：消除 `sseReconnectBackoffMs` 与 `SSE_RETRY_BASE_MS` 两套。
4. **`statusKey` 覆盖完整**：日志流也进 registry，`sseFallbackRefetchInterval` 可以统一驱动（修 §1.7 缺陷 4）——**附带收益：日志流连接水位进入全局可观测面**（`autoflow_metrics_streams_active/limit`）。

**影响面**：`createSseClient` impact = **68 符号 / 12 文件**；`ExecutionLogSection.tsx` 888 行可从中减 ~150 行（SSE 生命周期代码下沉到 hook）。

### 4.4 迁移路线（**分批，可逐批回滚**）

> **原则**：一个批次 = 一个可独立验证、可独立回滚的 PR。**不提供一次性全量重写方案**。

| 批次 | 内容 | 为何这个顺序 |
|---|---|---|
| **B0** | **补盲区测试**（`settings/*` 3,750 行 + `audit` + `CommandPalette` 4 路并行） | **必须最先**。没有它，后面所有重构都是「回归不可见」 |
| **B1** | **护栏先行**：3 条 ESLint/守卫（§4.2），存量豁免 | 冻结增量，防边继续烂 |
| **B2** | **`features/shared/useEventStream`** + 3 条流迁移 | 影响面最小（3 消费点）、可测性最好（6 个已有测试） |
| **B3** | **`features/tasks/`**（首个域试点） | **为什么是 tasks**：① 已有 `task-form/` 拆分样板可循；② 页面覆盖最充分（`TaskFormPage` 19 测试 + `TaskListPage` 8 + `TaskDetailPage` 6 = 33 个测试）；③ `usePauseTask/useResumeTask` 的乐观更新已有 `task-toggle-optimistic.test.tsx` / `task-toggle-concurrency.r138.test.tsx` / `task-list-optimistic.test.tsx` 三层护栏；④ `queries.ts` 的 tasks 段（`:281-417`）自包含度高，跨域依赖少 |
| **B4** | **`features/executions/`**（含 `ExecutionDetailPage` + `ExecutionLogSection`） | 有 `execution-detail-*` 15 个测试；`CommandPalette` 依赖它，需先就位 |
| **B5** | **`features/executors/`** + `features/applications/`** | `ExecutorListPage` 7 测试 + `ApplicationListPage` 6 测试 |
| **B6** | **`features/metrics/` + `features/agent-sessions/` + `features/sops/` + `features/settings/` + `features/audit/`** | 最后做：settings/audit 是盲区，B0 补测试后才动 |
| **B7** | **`CommandPalette` 拆域** | 依赖 B4/B5 就位 |
| **B8** | **页面拆分**（Top 8：ApplicationDetail / TaskDetail / TaskForm / AgentSessions / TaskList / ApplicationList / Sops / AppDeployment） | 依赖 B3–B6 的 features 层就位 |

> **B3（tasks）作为首个试点域的四条理由**是本报告最重要的排期结论。

### 4.5 generated types 漂移防线增强

**现状**：44 处手写类型与 generated 同名（§1.3）。

**R11 约束下**的可行做法（三层，全部兼容现有守卫）：

| 层 | 做法 | 判据 | 与现有守卫关系 |
|---|---|---|---|
| **L1 可见性** | `check-web-type-drift.mjs --report` 的「同名读数 44 处」**升级为 CI 必现的可见读数**（不判红） | 44 这个数字被打印且**可被 diff 追踪** | 复用现有脚本，只加 `--report` 到 CI |
| **L2 棘轮** | 新增 `scripts/web-type-dup-baseline.json`：登记 44 处同名手写类型；**同名且字段集与 generated 不同 ⇒ 判红** | 字段级差异检测（解析 `components['schemas']['XDto']` 的 properties vs 手写 interface 字段） | **新增守卫**，需 `--selftest` + 接 CI |
| **L3 增长闸** | 新增手写类型**同名登记**必须带理由；登记项消失 ⇒ 红（与现有 `check-web-type-drift` 的「基线陈旧」判据同构） | 与 R11「只减不增」完全一致 | 复用 `check-web-type-drift.mjs` 的 `allowlist` 机制 |

> ⚠️ **L2 是有风险的**：44 处里有相当数量字段集**本就不完全一致**（如 `Executor` 手写版有 `interpreters` 嵌套字面量，generated 版是引用）。上线前必须先跑一次**全量基线生成**（把当前 44 处全部登记为基线），再逐条收紧。**首版只做 L1 + L3，L2 在 B1 批次作为「报告模式」先跑一个迭代。**

---

## §5 开源参考清单

> License / star / 体积均为 **2026-11-03 通过 `api.github.com` 实测**，非二手描述。本项目 **AGPL-3.0-only**；以下均为 MIT / Apache-2.0，**可采纳为依赖**（AGPL-3.0-only 与 MIT/Apache 组合无冲突，义务仍是本项目自身的 AGPL）。

| 项目 | 仓库 | License | 体积/热度 | 核心亮点 | 可复用点 | 缺陷 | 适配成本 |
|---|---|---|---|---|---|---|---|
| **TanStack Query** | [TanStack/query](https://github.com/TanStack/query) | **MIT** | 50.5k★ / 144 MB | v5 `queryOptions` 工厂；`queryKeyFactory`；全局错误出口 | **已在用**（`@tanstack/react-query ^5.105.0`）。可直接借鉴 `queryOptions` 把「key + queryFn + 类型」打包成 feature 层一个导出 | 纯库无框架约束，**分层仍要自己定**；`queryKeyFactory` 需配合 `createQueryKey` 才有类型级安全 | **低**（已在依赖里，零新增） |
| **shadcn/ui** | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | **MIT** | 127k★ / 75 MB | 组合式组件；源码入仓而非 npm 依赖 | 表单/表格模式值得抄；但**本项目用 antd 6**，直接换 UI 库=全量重写 | 与 antd 体系完全冲突；Tailwind 依赖 | **高**（不建议引入，只借模式） |
| **refine** | [refinedev/refine](https://github.com/refinedev/refine) | **MIT** | 36.0k★ / **8.3 GB** | `dataProvider` 抽象 + resource 领域隔离 + access/plugin 模型 | **「resource = 领域」的分层思路最贴近本项目 §4.1**：`features/<domain>/` ↔ refine 的 resource | 8.3 GB 仓库体积巨大，框架层过重；**它要接管路由与数据层**，与本项目已有 39 页路由冲突；本项目已有 TanStack Query + antd | **高**（框架级侵入）——**建议只借 resource 概念，不引入** |
| **Ant Design Pro** | [ant-design/ant-design-pro](https://github.com/ant-design/ant-design-pro) | **MIT** | 38.9k★ / 42 MB | 约定式目录结构 + access/plugin | **目录约定值得抄**（`features/<domain>/` + `access.ts`） | 是 ProTable 等「重组件」全家桶，本项目已有 antd 6 + 自研页面，套用=双轨 | **中**（只借目录约定） |
| **TanStack Table** | [TanStack/table](https://github.com/TanStack/table) | **MIT** | 28.5k★ / 56 MB | headless 表格/数据网格 | `TaskListPage`/`ExecutorListPage` 若要换表格引擎 | **antd 6 的 `Table` 已自带虚拟与列配置**，换 headless = 重写 8 个列表页；本项目已有 antd 内置 `virtual`（`ApplicationDetailPage.tsx:431`） | **高**（不换） |
| **TanStack Virtual** | [TanStack/virtual](https://github.com/TanStack/virtual) | **MIT** | 7.2k★ / 10 MB | headless 虚拟滚动 | `ExecutionLogSection` 的 20,000 行日志、`TaskListPage` 全量表格 | 需要定高/测量，与 antd Table 集成要额外适配层 | **中**（日志行流式追加场景可能需要） |
| **MSW** | [mswjs/msw](https://github.com/mswjs/msw) | **MIT** | 18.3k★ / 14 MB | 契约 mock 事实标准；Service Worker 拦截 | ★ **对「回归不可见」最对症**：用 `openapi.json` 生成 handler，让 44 处手写类型与 generated 的差异在**测试期**暴露为运行时错误 | 只 mock，不校验 schema（需配 `openapi-msw` 或自写校验）；Service Worker 在 vitest/jsdom 里要额外 setup | **中**（接入成本集中在 B0） |
| **Playwright** | [microsoft/playwright](https://github.com/microsoft/playwright) | **Apache-2.0** | 99.1k★ / 247 MB | 端到端/组件测试 | ★ **已在 devDependencies**（`@playwright/test ^1.64.1`），已有 `e2e/` 6 个 spec | 已有 e2e 但**未覆盖 `settings/*` 与 `audit`**；CI 需真浏览器 | **低**（已在依赖里） |
| **SWR** | [vercel/swr](https://github.com/vercel/swr) | **MIT** | 32.5k★ / 8 MB | 轻量数据获取 | — | **本项目已用 TanStack Query**，功能是超集；并存=双数据源 | **不引入** |
| **Zustand** | [pmndrs/zustand](https://github.com/pmndrs/zustand) | **MIT** | 58.9k★ / 8 MB | 客户端状态 | **已在用**（`zustand ^5.0.16`，`src/store/auth.ts` + `src/theme/store.ts`） | 无 | **零成本**（已用） |
| **eventsource-parser** | [rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser) | **MIT** | 516★ / 2 MB | source-agnostic SSE 解析 | 若走 `fetch` + ReadableStream 路线可替代 `EventSource`（换票 + 头可控） | `EventSource` 无法自定义 header（本项目靠 ticket query param 绕过）；引入后需自管重连/解析 | **中**——**本项目已用 ticket query param 方案，可不换** |

### 5.1 建议新增依赖清单

| 包 | 版本 | License | 预估体积 | AGPL-3.0-only 影响 | 建议 |
|---|---|---|---|---|---|
| `msw` | ^2.x | MIT | dev-only，**不进生产 bundle** | 无冲突（MIT 可与 AGPL 组合） | ✅ **推荐（B0 批次，devDependency）** |
| `@tanstack/react-query` | ^5.105.0 | MIT | **已在依赖** | — | ✅ 复用 |
| `@tanstack/react-virtual` | ^3.x | MIT | ~10 KB gz | 无冲突 | 🟡 暂缓（antd 内置够用） |
| `zustand` | ^5.0.16 | MIT | **已在依赖** | — | ✅ 复用 |
| `@playwright/test` | ^1.64.1 | Apache-2.0 | **已在 devDependencies** | — | ✅ 复用 |

**结论：本轮建议新增的唯一生产代码依赖 = 0；唯一新增 devDependency = `msw`（不进 bundle，0 运行时体积代价）。**

### 5.2 TanStack Query `queryOptions` 分层模式（可直接借鉴）

```typescript
// features/tasks/queries.ts
import { queryOptions, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tasksApi, type Task } from '../../api/tasks';
import { taskKeys } from './keys';

// ① key + queryFn + 选中数据打包成一个「可组合单元」
export const taskListOptions = (params: TaskListParams) =>
  queryOptions({
    queryKey: taskKeys.list(params),
    queryFn: ({ signal }) => tasksApi.list(params, signal),
    staleTime: 30_000,
  });

export const useTaskList = (params: TaskListParams) =>
  useQuery(taskListOptions(params));

export const useTaskDetail = (id: string | undefined) =>
  useQuery({
    queryKey: taskKeys.detail(id!),
    queryFn: ({ signal }) => tasksApi.get(id!, signal),
    enabled: !!id,
  });

// ② 乐观更新留在 feature 层（不再住 api/）
export const usePauseTask = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tasksApi.pause(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: taskKeys.detail(id) });
      const prev = qc.getQueryData<Task>(taskKeys.detail(id));
      qc.setQueryData(taskKeys.detail(id), (t: Task) => ({ ...t!, status: 'paused' }));
      return { prev };
    },
    onError: (_e, id, ctx) => ctx?.prev && qc.setQueryData(taskKeys.detail(id), ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: taskKeys.all }),
  });
};
```

**为什么这个模式契合本项目**：
- `queryOptions` 让「key / queryFn / 类型」**共处一个文件**，从而**不需要**独立的 `types/` 层——**正好绕开 R11「不迁类型」的约束**（类型仍从 `api/tasks` 来，但不再由 `api/queries.ts` 当类型源）；
- `queryKey` 由 `taskKeys` 工厂产出 ⇒ 天然消灭裸字面量 key（§1.5 的 42 处）；
- `signal` 透传 ⇒ 组件卸载自动取消在途请求（当前 `CommandPalette` 用序号守卫自研，`ExecutionDetailPage` 也有专用的 `executor-request-dedup` 测试）。

---

## §6 分阶段路线图

### 阶段 1：护栏与可见性（**先做，不改行为**）

| 文件 | 动作 |
|---|---|
| `scripts/web-type-dup-baseline.json` | 新建：登记 44 处同名手写类型 + 字段差异基线 |
| `scripts/check-web-handwritten-dup.mjs` | 新建守卫（**首版仅报告模式**，不判红） |
| `scripts/check-web-layering.mjs` | 新建守卫：`pages/`/`components/` 不得 import `api/queries` 与 `types/generated`（存量豁免清单） |
| `scripts/check-web-querykey-factory.mjs` | 新建守卫：`queryKey:` 不得为数组字面量（存量豁免） |
| `scripts/lib/guard-selftest.mjs` | 复用既有自检 harness（新守卫必须写 `--selftest`） |
| `package.json` | 挂 `check:web-layering` / `check:web-querykey-factory` / `check:web-handwritten-dup` |
| `.github/workflows/ci.yml` | 挂三条新守卫（**单写者串行，由主会话改**） |
| `src/__tests__/settings-*.test.tsx`（新 5 个） | 补 `settings/*` 关键路径测试 |
| `src/__tests__/audit-page.test.tsx` | 补 `audit/index.tsx` 测试 |
| `src/__tests__/command-palette-parallel.test.tsx` | 补 `CommandPalette` 4 路并行 + 部分失败降级 |

**验收判据**：
1. `npm run check:guards-wired` 绿（证明三条新守卫**真的被 CI 跑到**，含自检）。
2. 三条新守卫在**存量豁免清单**下绿；**故意新增一处违规**（如在 `pages/` 里 import `api/queries`）⇒ 必红。
3. `settings/*` + `audit` + `CommandPalette` 的新增测试**在 HEAD 上全绿**（证明是护栏不是修复）。
4. `check-web-handwritten-dup --report` 输出 44 处基线读数并被 CI 日志留痕。

### 阶段 2：基础设施（`features/shared` + SSE）

| 文件 | 动作 |
|---|---|
| `src/features/shared/useEventStream.ts` | 新建：统一 SSE（连接去重 + 可见性一致 + 退避一处定义 + statusKey 全覆盖） |
| `src/features/shared/usePollingFallback.ts` | 新建：统一「断流 → 指数退避轮询」 |
| `src/features/shared/queryKeys.ts` | 新建：跨域根键 |
| `src/hooks/useMetricsStream.ts` | 改为 `useEventStream` 薄封装 |
| `src/hooks/useExecutionsStream.ts` | 改为 `useEventStream` 薄封装 |
| `src/components/ExecutionLogSection.tsx` | 改为 `useEventStream`；**删自建退避**（`SSE_RETRY_BASE_MS`/`MAX_SSE_AUTO_RETRIES`）→ 减 ~150 行 |
| `src/api/sse-client.ts` | 降为传输原语（保留 `createSseClient`，`features/shared` 包一层） |
| `src/__tests__/use-event-stream.test.tsx` | 新建：连接去重 / 可见性恢复 / 重连退避 / 多订阅者 |

**验收判据**：
1. 现有 6 个 SSE 测试文件（`sse-client-registry` / `sse-client-ticket` / `sse-client-visibility` / `sse-ticket-toast-once` / `use-executions-stream` / `use-metrics-stream`）**全绿不改断言**（除刻意修的可见性恢复）。
2. **新用例红**：同一 `streamKey` 两个订阅者 ⇒ **只有 1 条 EventSource**（当前实现会开 2 条 ⇒ 必红）。
3. **新用例红**：日志流 hidden→visible ⇒ **自动恢复连接**（当前实现不会 ⇒ 必红）。
4. `ExecutionLogSection.tsx` 行数 ≤ 750（从 888）。
5. `npm run lint` + `tsc -b` 0 错。

### 阶段 3：领域分层（**逐域，tasks 起步**）

| 批次 | 新增文件 | 迁移文件 | 回归验证方式 |
|---|---|---|---|
| B3 tasks | `features/tasks/{keys,queries,mutations,model,index}.ts` | `api/queries.ts` 的 tasks 段（`:281-417`）+ 乐观更新（`:419-620`） | `task-toggle-optimistic` / `task-toggle-concurrency.r138` / `task-list-optimistic` / `cache-key-consistency.r138` **4 个测试 + 33 个任务域页面测试**全绿；`task-list-columns` / `task-list-keyset-paging` 断言**queryKey 形状不变** |
| B4 executions | `features/executions/*` | `api/queries.ts` executions 段 | `execution-detail-*` **15 个测试** + `executions-keyset-paging` + `executions-deeplink` + `execution-detail-fulllogs-race` 全绿 |
| B5 executors+applications | `features/executors/*`、`features/applications/*` | — | `executor-*` 10 个 + `application-*` 6 个测试全绿 |
| B6 其余域 | `features/{metrics,agent-sessions,sops,settings,audit,projects,...}/*` | — | 每个域**先补测试再迁**（B0 的测试是前提）；`settings`/`audit` 用 B0 补的测试 |
| B7 CommandPalette | `components/CommandPalette/adapters/*` | `components/CommandPalette.tsx` | `command-palette.test.tsx` + `a11y-focus.test.tsx` + 新增的并行/降级测试 |
| B8 页面拆分 | `components/<page>-parts/*` | Top 8 页面 | **逐页单独 PR**，每页一个 PR，靠该页现有测试 + E2E 兜底 |

**每批次统一验收判据**：
1. `tsc -b` 0 错；`npm run lint` 0 错（**含新增的 `check-web-layering` 绿**——迁完后豁免清单能**收紧**）。
2. 该域**所有现有测试文件**全绿且**断言未被削弱**（diff 审查：只允许新增不许删除断言）。
3. `check-web-handwritten-dup` 基线读数**未增加**（R11 棘轮：手写类型不得增长）。
4. `npm run build` 成功，**首屏体积不回归**（`first-paint-no-unused-vendor.test.ts` 的 1.8 MB 上界绿）。

---

## §7 风险 + 回滚方案

### 7.1 风险登记

| 编号 | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| **RK1** | **回归不可见**——重构改了 UI 但没有测试覆盖，静默劣化 | **高** | **高** | **B0 必须最先**：3,750 行盲区（settings/audit）+ CommandPalette 补测试；每批次要求「断言不减少」的 diff 审查 |
| **RK2** | 缓存键变更导致**静默读到错页数据**（React Query 前缀匹配，失效键错配不报错） | 中 | **高** | `cache-key-consistency.r138.test.tsx` 已有两条结构性钉子；批次 3 起把裸 key 全部收口工厂；**禁止改动 key 形状**（改了就要同步改断言并说明） |
| **RK3** | SSE 重构引入**连接泄漏**或**重复连接**（当前 3 条流 + registry 互删） | 中 | 中 | 阶段 2 的新用例（1 个 `streamKey` 只允许 1 条 EventSource）；`close()` 幂等；`visibilitychange` 监听器摘除。**注**：服务端 32/64 槽位对「每标签页一条」的形态充裕（§1.7.1），风险在**客户端重复连接**而非服务端容量 |
| **RK4** | 与 R11 冲突——误把手写类型迁移当成重构目标 | 中 | 中 | 报告与守卫都写明「类型原地不动」；`check-web-type-drift.mjs` 的棘轮继续红 |
| **RK5** | **CI 守卫接线冲突**——`package.json:87` 与 `ci.yml` 是**单写者串行**资产（R14） | **高** | 低 | 阶段 1 的 `package.json` / `ci.yml` 改动**交由主会话统一落**，本报告只给清单 |
| **RK6** | MSW 接入成本超预期（jsdom + Service Worker 兼容） | 中 | 低 | **首版只做 `check-web-handwritten-dup` 报告模式**；MSW 降级为 B0 的可选增强，不阻塞 |
| **RK7** | 页面拆分（尤其 `TaskFormPage` 1360 行）触发 antd Form 实例丢失 | 中 | 中 | **B8 排在最后**；`task-form-*.test.tsx` 已有 **19 个**测试（含 `task-form-unsaved-guard` / `task-form-draft` / `task-form-code-source-switch`），是全仓护栏最强的地方 |
| **RK8** | 首屏体积回归（新增 features 层导致打包边界变化） | 低 | 中 | `first-paint-no-unused-vendor.test.ts` 的 1.8 MB 上界 + `web-entry-chunk-split.test.ts` 已有；每批次跑 `npm run build` 对比 |

### 7.2 回滚方案

| 机制 | 适用 | 实现 |
|---|---|---|
| **逐批回滚（主）** | 所有批次 | **一个批次 = 一个独立 PR = 一个可 revert 的提交**。批次间**无强制顺序耦合**（B4 依赖 B3 的是「域间 import」，用 re-export 兼容层解耦）→ 任一批可单独 revert |
| **双栈共存** | B3–B6 迁移期 | `api/queries.ts` 的旧 hook **保留为 re-export**：`export const useTasksList = features.tasks.useTasksList`（一行转发，零行为变化）→ 迁移完成后删除旧定义。**页面可以逐个切换**，回滚只需把页面的 import 改回去 |
| **feature flag** | B7 `CommandPalette`、B8 页面拆分 | `VITE_FEATURE_*` 环境变量控制新旧路径；拆分出的组件默认**关**，逐页开启。⚠️ 本项目是**自托管控制台**，flag 需在构建期注入（`apps/admin-web/.env*`） |
| **类型兼容层** | 全程 | `features/<domain>/model.ts` 里的领域纯函数（`applyTaskStatusPatch` 等）**从 `api/queries.ts` 原样搬出**，函数体逐字不变 → 行为等价可证 |
| **数据库/后端** | — | **本方案零后端改动** ⇒ 无数据迁移、无回滚风险 |

### 7.3 双栈共存的过渡形态（示例）

```typescript
// apps/admin-web/src/api/queries.ts（阶段 3 期间）
// ⚠️ 兼容层：旧路径转发到新 feature 层。迁移完成后整段删除。
export { useTasksList, useTaskDetail, useTaskStats, useTaskExecutions,
         useAllTasksForDag, invalidateTaskData } from '../features/tasks';
export { usePauseTask, useResumeTask } from '../features/tasks';
```

**这让「迁移」变成纯机械操作**：页面 import 路径不变 → 行为不变 → 逐页切换为直接 `from '../features/tasks'` → 确认无残留后删兼容层。

---

## §8 测试计划

### 8.1 现有覆盖盘点（§1.10 汇总）

- **测试文件总数**：269（`src/__tests__/`）
- **有直接页面级覆盖**：22 / 31 页面
- **盲区**：
  - 🔴 `src/pages/settings/` **5 个文件 / 2,906 行**（`index.tsx` 985、`SecuritySettings.tsx` 530、`EventSubscriptionsSettings.tsx` 643、`ApiKeysSettings.tsx` 410、`AiProvidersSettings.tsx` 338）
  - 🔴 `src/pages/audit/index.tsx` **844 行**
  - 🔴 `src/pages/NotFoundPage.tsx` 57 行（低危）
  - 🔴 `src/pages/task-form-code-source.tsx` 70 行（测的是 hook，组件本体未测）
  - 🟡 `CommandPalette.tsx` 891 行 / 4 域，仅 3 测试
  - 🟡 `ProjectsPage` 1,018 行 / 1 测试；`UserManagementPage` 782 行 / 1 测试；`ExecutorPackagesPage` 1,092 行 / 0 直接测试
  - 🟡 `SopsPage` 1,190 行 / 3 测试；`AppDeploymentPage` 1,085 行 / 4 测试；`AgentSessionsPage` 1,304 行 / 5 测试
- **E2E（Playwright，已装）**：`e2e/` 6 spec —— `auth` / `functional` / `pages` / `navigation` / `application-versions` / `login_real` + `e2e/legacy/` 2 个。**未覆盖 `settings/*` 与 `audit`**。

### 8.2 正面回应「回归不可见」的三道护栏

| 护栏 | 机制 | 成本 | 拦住什么 |
|---|---|---|---|
| **G1 结构性扫描守卫** | `check-web-layering` / `check-web-querykey-factory` / `check-web-handwritten-dup` | 低（一次性 + CI 秒级） | 拦住「新增违规边」「新增裸 key」「新增同名手写类型」——**增量方向的回归** |
| **G2 域级测试基线** | 每批次要求「该域全部现有测试全绿 + 断言不减少」（diff 审查） | 中（人工 review） | 拦住「迁移时的行为漂移」 |
| **G3 契约 mock（MSW）** | 用 `openapi.json` 生成 handler；44 处手写类型与 generated 的字段差异在**测试期**变成运行时错误 | 中高 | 拦住「手写类型与后端契约漂移」——**这是当前所有守卫都漏的那一类** |

### 8.3 新增用例清单（按批次）

**阶段 1（B0）— 补盲区**

| # | 文件 | 覆盖目标 | 关键断言 |
|---|---|---|---|
| T1 | `src/__tests__/settings-system-configs.test.tsx`（新） | `settings/index.tsx:420` `['system-configs']` | 改配置后列表刷新；`invalidateQueries({queryKey:['system-configs']})` **真的**有消费者 |
| T2 | `src/__tests__/settings-ai-config.test.tsx`（新） | `settings/index.tsx:612` `['ai-config']` | AI provider 保存后 `['ai-config']` 失效并重取；**加载失败渲染 `StateError`（WEB-5 防回归）** |
| T3 | `src/__tests__/settings-security-totp.test.tsx`（新） | `SecuritySettings.tsx:85` 注释里的「`['auth-profile']` 全仓无消费者」 | TOTP 开关切换后**服务端状态真的更新**（不只 UI 变） |
| T4 | `src/__tests__/settings-event-subscriptions.test.tsx`（新） | `EventSubscriptionsSettings.tsx` 643 行 | 订阅增删改 + 死信列表 |
| T5 | `src/__tests__/settings-api-keys.test.tsx`（新） | `ApiKeysSettings.tsx` 410 行 | key 作用域切换 |
| T6 | `src/__tests__/audit-page.test.tsx`（新） | `audit/index.tsx:280/320` `['audit', page, filters, activeCursor]` | keyset 游标进 key；翻页不串页；筛选变更换 key |
| T7 | `src/__tests__/command-palette-parallel.test.tsx`（新） | `CommandPalette.tsx:334-398` | 4 路并行**部分失败**时其余组仍显示；`seqRef` 序号守卫丢弃过期响应；`executorsApi.list()` 走缓存不重复打网络 |

**阶段 2 — SSE**

| # | 文件 | 关键断言 |
|---|---|---|
| T8 | `src/__tests__/use-event-stream.test.tsx`（新） | 同 `streamKey` 两个订阅者 ⇒ **EventSource 构造器调用次数 = 1** |
| T9 | 同上 | hidden ⇒ `close()` 且**不进重连定时器**；visible ⇒ 自动重连且 `attempt=0` |
| T9b | 同上 | `reconnect:false` 时 visible **仍**重建连接（工厂现状）⇒ 断言「组件侧 `gaveUp`/`streamDisconnected` 状态与工厂状态**同步复位**」（修 §1.7 缺陷 1） |
| T10 | 同上 | 退避序列 `3s→6s→12s→…→30s` 封顶；`maxAttempts` 耗尽 ⇒ 转轮询兜底 |
| T11 | 同上 | 一个订阅者 `close()` **不影响**另一个（registry 不互删） |
| T12 | 同上 | 卸载后 `visibilitychange` 监听器被摘除（监听器计数不增长） |

**阶段 3 — 领域迁移**

| # | 文件 | 关键断言 |
|---|---|---|
| T13 | `src/__tests__/features-tasks-queries.test.ts`（新） | `taskKeys.list(params)` 与旧 `queryKeys.tasks.list(params)` **逐字相等**（key 形状不变 ⇒ 缓存不失效） |
| T14 | 同上 | `features/tasks/model.ts` 的 `applyTaskStatusPatch` / `patchTaskInPage` 与旧实现**同输入同输出**（纯函数等价） |
| T15 | `src/__tests__/features-executions-queries.test.ts`（新） | executions 域同上 |
| T16 | `src/__tests__/cache-key-consistency.r138.test.tsx`（扩） | 断言「**全仓** `queryKey:` 无新增裸字面量」（棘轮式，存量豁免） |

### 8.4 验收口径（可机械判定）

```bash
# 每批次必跑
cd apps/admin-web && npx tsc -b --noEmit   # 0 错
cd apps/admin-web && npm run lint            # 0 错
cd apps/admin-web && npm test               # 全绿，且断言数不减少
cd apps/admin-web && npm run build           # 成功，首屏 ≤ 1.8 MB
node scripts/check-web-layering.mjs          # 绿（且豁免清单可收紧）
node scripts/check-web-querykey-factory.mjs  # 绿
node scripts/check-web-type-drift.mjs        # 绿（棘轮：手写类型未增长）
node scripts/check-web-handwritten-dup.mjs   # 绿（首版=报告模式）
npm run check:guards-wired                   # 绿（证明新守卫真的被 CI 跑到）
```

---

## §9 待决策项

| # | 问题 | 建议 | 影响面 | 需要谁拍板 |
|---|---|---|---|---|
| **D1** | **是否接受「不迁 44 处手写类型」的路线**（R11 延续）？本方案的 `features/` 分层**只搬 hook + 领域纯函数 + 缓存键**，类型留在 `api/` | **接受**。理由：R11 已否决迁移；且类型不搬 ⇒ 回归面小 10 倍 | 决定 §4 全部 | **主会话**（R11 是主会话裁定） |
| **D2** | **`check-web-handwritten-dup` 的 L2（字段级差异判红）是否上线？** 44 处里字段集本就不同的不少，首版判红会大面积爆红 | **首版只做 L1（可见性）+ L3（增长闸）**；L2 先跑 1 个迭代「报告模式」，基线收紧后再判红 | 守卫判据 | **主会话** |
| **D3** | **`package.json` / `ci.yml` 的守卫接线由谁改？**（R14 规定单写者串行） | **交由主会话统一落**，本报告给精确清单（阶段 1 表） | CI | **主会话** |
| **D4** | **B3 首个试点域选 `tasks` 是否同意？** | **同意**。四条理由：已有 `task-form/` 拆分样板、33 个任务域页面测试、乐观更新三层护栏、`api/queries.ts` tasks 段自包含度高 | 整个阶段 3 排期 | **主会话** |
| **D5** | **是否引入 MSW？** 唯一建议新增 devDependency | **建议引入**，但**不阻塞 B0**——B0 可以只用「手写测试」完成，MSW 作为增强 | devDeps | **主会话** |
| **D6** | **`CommandPalette` 是否要做 B7 的完整拆域？**（891 行 / 63 符号 / 4 域） | **建议做**，但排在 B4/B5 之后；先做补丁 A（4 路裸 API 换 `useQuery`） | 1 文件 | **主会话** |
| **D7** | **`ExecutorListPage` / `TaskListPage` 是否要上 TanStack Virtual？** | **暂不建议**——antd 6 内置 `virtual` 已可用（`ApplicationDetailPage.tsx:431` 是先例），零新依赖 | 2 文件 | **主会话**（低成本，随时可改） |
| **D8** | **页面拆分（B8）的粒度**：Top 8 全拆 vs 只拆 >1,200 行的 4 个 | **建议只拆 >1,200 行的 4 个**（ApplicationDetail 1,556 / TaskDetail 1,400 / TaskForm 1,360 / AgentSessions 1,304），其余降级为「观察」 | 4–8 文件 | **主会话** |
| **D9** | **日志流「可见性恢复后与轮询兜底双跑」缺陷（§1.7 缺陷 1）是否单列为一个 hotfix？** 它**不依赖**任何重构，可独立修 | **建议单列 hotfix**（阶段 2 之前先修） | 1 文件 + 2 测试 | **主会话** |

---

## 附录 A：探查方法与可复现命令

```bash
# 索引状态
codegraph status                                     # → Files 2108 / Nodes 42151 / Edges 120271
codegraph sync                                       # → Already up to date

# 分层探查
codegraph node apps/admin-web/src/api/queries.ts --symbols-only      # → 39 symbols, used by 28 files
codegraph node apps/admin-web/src/api/executors.ts --symbols-only     # → 101 symbols, used by 88 files
codegraph node apps/admin-web/src/api/tasks.ts --symbols-only         # → 187 symbols, used by 96 files
codegraph node apps/admin-web/src/components/CommandPalette.tsx --symbols-only   # → 63 symbols
codegraph node apps/admin-web/src/components/ExecutionLogSection.tsx --symbols-only # → 36 symbols
codegraph node apps/admin-web/src/api/sse-client.ts --offset 120 --limit 200      # → SSE 工厂全文

# 影响面
codegraph impact queryKeys -d 2                    # → 121 affected symbols
codegraph impact Executor --file apps/admin-web/src/api/executors.ts -d 2   # → 133
codegraph impact createSseClient -d 3             # → 68

# 覆盖盘点
codegraph callers <PageComponent> -f apps/admin-web/src/pages/<X>.tsx -j

# 守卫
node scripts/check-web-type-drift.mjs --report      # → 同名读数：44 处 / 手写 118 处
node scripts/check-guards-wired.mjs                 # → 守卫接线自检
git show --stat 39dd4001                            # → WEB-1/3/4/5 修复证据
```

## 附录 B：与既有 OSS 对照调研的交叉引用

| 本报告结论 | 交叉引用 |
|---|---|
| 「api 层职责倒置」 | `agent_talk/03_recommendations/01-priority-register.md` **R11** / **S3-C3** / **S3-C4** |
| 「手写类型不得增长」 | 同上 R11（「133 处手写类型原地不动」）——本报告 D1 延续 |
| 「web-type-drift 棘轮守卫」 | `scripts/check-web-type-drift.mjs` 头部注释（已自述盲区） |
| 「WEB-1/3/5 已修」 | `docs/archive/audits/2026-10-29-round3/INDEX.md:368-370`（✅ 三条）与 `39dd4001` commit |
| 「守卫接线单写者」 | R14（`package.json:87` / `ci.yml` 单点串行） |
| 「SSE 真实规模受限于标签页数，不夸大连压力」 | 主会话 2026-11-03 情报（python-executor 域实测「单进程/单实例」形态）+ 本报告 §1.7.1 服务端口径（`metrics-stream-slot.service.ts:16-18`、`executions-stream.controller.ts:63`） |
