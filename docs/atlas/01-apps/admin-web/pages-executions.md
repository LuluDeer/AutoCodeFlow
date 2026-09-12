# 执行域页面（pages-executions）

> 所属: docs/atlas/01-apps/admin-web · 最后核对: 2026-09-13 · 对应代码: apps/admin-web/src/pages/ExecutionsPage.tsx、ExecutionDetailPage.tsx

## 职责

执行记录的两个入口面：全局执行列表（跨任务）与单次执行详情（日志流/时间线/重试链/产物/报告）。这是 admin-web 实时性要求最高的域——SSE 日志流 + 终态推送 + 轮询兜底三套机制并存。

## ExecutionsPage.tsx（335 行，路由 /executions）

- 职责：全局执行记录表——分页 + 筛选（status/taskName/executorAddress/startTime/endTime）、终止（kill）、跳转执行详情/任务详情
- 数据面：
  - `tasksApi.allExecutions`（GET /tasks/executions/all）经 `useExecutionsList`（api/queries.ts；筛选参数进 queryKey，AbortSignal 透传）
  - kill 成功 → `invalidateExecutionData(queryClient)` 失效执行列表 + Dashboard 汇总面
- 实时性（useExecutionsStream，hooks/useExecutionsStream.ts）：
  - 连接 GET /executions/stream，消费三个具名终态事件：`execution.completed` / `execution.failed` / `execution.killed`
  - 事件到达 → `invalidateExecutionData`——列表页数据形状是「分页+筛选后的行集」，终态载荷只有单行 id 级信息，invalidate（标记 stale → 活跃 observer 立即重取）是正确粒度；终态刷新 <3s 验收由此承担
  - SSE live 时 15s 轮询空转（invalidate 已即时刷新，轮询 refetch 在 staleTime 内被去重）；断线时轮询自动成为唯一新鲜度来源
  - 连接状态 connecting / live / reconnecting 外露（页面状态点）
- 测试：executions-page / use-executions-stream / use-metrics-stream / queries.abort-signal

## ExecutionDetailPage.tsx（1024 行，路由 /tasks/:taskId/executions/:execId）

注意：路由挂在 tasks 前缀下（复用任务参数结构），按业务域归入本篇。

### 1. SSE 日志流（运行中实时日志）

```ts
if (data?.status !== 'running' && data?.status !== 'pending') return;
const url = `${base}/tasks/${taskId}/executions/${execId}/logs/stream`
          + (token ? `?access_token=${encodeURIComponent(token)}` : '');
const es = new EventSource(url);
```

- EventSource 无法带请求头 → 后端仅对日志流路由支持 access_token 查询参数鉴权
- `onmessage` 逐行 append（畸形 JSON 忽略）；`done` 事件关流并 `refresh()` 拉终态
- error 关流并置 `streamDisconnected`；reconnectKey 支持手动重连

### 2. 断流轮询兜底

- 断流且执行未终态：8s 间隔轮询 refresh
- `document.visibilityState === 'visible'` 才发请求（对齐 useRequest pollingWhenHidden:false；定时器保留，回前台下一拍恢复）
- 到达终态自动停

### 3. 截断兜底（U2）

- `LOG_TRUNCATION_MARKER = /\[\s*(?:logs\s+)?truncated\b/i` 识别后端回调载荷超限时嵌的标记：
  - Node：`... [logs truncated, original length N chars] ...`
  - Python：`...[truncated, total N chars]...`
  - 后端不返回 truncated 标志，只嵌在日志文本里
- 命中后 `tasksApi.executionLogs`（GET .../logs，fromLine/limit/level）分页拉全量；`LOG_PAGE_LIMIT = 2000`（后端 task.controller.ts limit 封顶）

### 4. 日志分级与搜索（OBS-03）

- `utils/logLevel.ts`：前端行级推断（与 admin-api log-level.util.ts 同口径：行首标注/时间戳前缀标注，大小写不敏感）→ 行高亮（.log-line-error / .log-line-warn）
- level（ERROR/WARN/INFO/DEBUG）是**服务端过滤**——过滤模式下 fromLine 语义是「过滤后序列的偏移量」（后端 skip/OFFSET），totalLines 为过滤后计数，翻页循环契约 `offset += lines.length` 不变
- 关键字搜索：`utils/log-search.ts`
- 切换执行记录时丢弃上一条的完整日志与过滤结果

### 5. 重试链（CORE-02，pages/retry-chain.ts）

- 链模型：同任务下 retryCount 递增的兄弟执行行（attempt 0 = 原始执行；链上可见的是「中台重建执行行」粒度，BullMQ job 级自动重试不产生新行）
- `buildRetryChain` / `retryGapMs`（下一行 startTime − 上一行 endTime）/ `nextPendingRetryAt`（待重试提示）
- 数据：`useExecutionRetryChain` → `tasksApi.executionsWithStatus`（复用 GET /tasks/:id/executions 的 status 参数，零新端点）

### 6. 报告/时间线/对比（OBS-04）

- `useExecutionReport` → `executionReportsApi.report`（一次性端点：execution 行 + DB 时间戳映射 timeline + execution_reports 当日聚合行；缺行 report=null 属正常态，面板内降级）
- `utils/execution-timeline.ts`：三端对齐（admin-api execution-timeline.util.ts 与 mcp-server buildExecutionTimeline），缺省时刻渲染 null → UI 显示「—」
- 组件：`ExecutionReportPanel.tsx`（报告面板）/ `ExecutionCompare.tsx`（对比）

### 7. 失败定位 / 产物 / AI / 终止

- 失败定位（UI-05）：`pages/failure-runbook.ts` FAILURE_RUNBOOK_ACTIONS（BUG-10 十二类 → 中文建议动作，镜像 mcp-server，双端人工同步）
- 产物：`ArtifactsList.tsx`（自取数分支走 `useExecutionArtifacts`，上层传 artifacts prop 时不挂 hook）；下载 blob+objectURL
- AI：`tasksApi.analyzeExecution`（POST .../analyze → aiAnalysis）
- 终止：`tasksApi.killExecution`（POST .../kill）

- 测试：execution-detail-sse / -log-level / -trace / -truncated-logs / -ui05 / execution-report-panel / execution-timeline

## 常见改动场景

- 日志区加能力：优先改 `utils/log-search.ts` / `utils/logLevel.ts`（纯函数好测），页面只接线
- 新 SSE 流：仿 useMetricsStream 三件套（backoff 纯函数导出、状态外露、写 queryClient 或 invalidate）
- 加执行维度字段：TaskExecution 类型在 api/tasks.ts，列表/详情/重试链三处 UI 同步

## 与其他文档的关系

- 依赖：[api-layer.md](api-layer.md)（tasksApi/queries）、[store-and-hooks.md](store-and-hooks.md)（三个流 hook）、[domain-modules.md](domain-modules.md)（retry-chain/failure-runbook）
- 被依赖：TaskDetailPage / ExecutionsPage / CommandPalette 跳入
- 数据来源：[执行回调流程](../../04-flows/execution-callback.md)（日志/产物/状态上报）

## 相关文档

[README](README.md) · [pages-tasks.md](pages-tasks.md) · [任务生命周期](../../04-flows/task-lifecycle.md)
