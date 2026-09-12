# metrics 模块 — 指标查询、Prometheus 抓取与 SSE 流

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/metrics

## 职责

双面模块：**对 admin-api 自身**提供 Dashboard 汇总/趋势/失败列表查询、Prometheus 文本抓取端点（R7）、两条 SSE 推送流；**对执行上报侧**持有 `ExecutionReport` 实体（`execution_reports` 表，按天聚合的执行结果/耗时统计，task 模块在执行链路读它做"当日聚合行"展示）。

## 目录结构与关键文件

```
modules/metrics/
├── metrics.module.ts        imports: Task/TaskExecution/Executor/ExecutionReport 实体、
│                            BullMQ task-queue、SchedulerModule(forwardRef)、TaskModule
├── metrics.controller.ts    @Controller("metrics") — 查询 + Prometheus 端点
├── metrics.service.ts       getSummary/getDailyTrend/getExecutorStats/
│                            getRecentFailures/getSchedulerMetrics + execution_reports 聚合
├── prometheus-metrics.service.ts  独立 prom-client Registry，scheduler/queue/runtime 指标映射
├── metrics-stream.controller.ts   @Controller("metrics") — GET /metrics/stream（Dashboard SSE）
├── executions-stream.controller.ts @Controller("executions") — GET /executions/stream（执行终态 SSE）
├── metrics-stream-slot.service.ts 汇总流并发槽位（默认上限 32，METRICS_STREAM_MAX_GLOBAL）
├── runtime-metrics.ts / runtime-metrics-entry.ts  运行时计数器（模块级埋点入口）
└── entities/execution-report.entity.ts  execution_reports 表（triggerDay 唯一）
```

## 路由

**MetricsController（`metrics`，类级 JwtAuthGuard）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/metrics` | **Prometheus 抓取端点**（text exposition）：`autoflow_scheduler_*`、`autoflow_queue_*`、PG 连接池水位、executor 磁盘水位、callback 鉴权分类、runtime 计数 + 默认进程指标。`@Res()` 直写绕过全局 JSON 包装；`METRICS_PROMETHEUS_ENABLED=false` → 404 |
| GET | `/api/metrics/summary` | 今日总览（任务/执行器/执行计数、状态分布、平均耗时） |
| GET | `/api/metrics/trend?days=` | 每日趋势（1–90 天封顶，防全表扫描） |
| GET | `/api/metrics/executors` | 执行器统计 |
| GET | `/api/metrics/failures` | 最近失败列表 |
| GET | `/api/metrics/scheduler` | 调度可观测性（tick/trigger 计数 + 队列深度，R4-§5.5） |

**流控制器**（JWT 鉴权，支持 `?access_token=` 查询参数兜底——EventSource 无法带 Header，见 [auth.md](auth.md)）：

| 控制器 | 路由 | 数据源 |
|---|---|---|
| MetricsStreamController | GET `/api/metrics/stream` | 周期轮询 MetricsService 汇总后推送；`@Res()` 直写（`@Sse()` 会破全局 envelope 拦截器） |
| ExecutionsStreamController | GET `/api/executions/stream` | 订阅 DomainEventBus 执行终态事件转发（FEAT-16），零 DB 查询 |

## 关键机制

### Prometheus 指标映射（prometheus-metrics.service）

- **独立 `Registry`**（非全局默认），避免与依赖库指标互相污染，单测天然隔离。
- 抓取时读取 `SchedulerMetricsService` 进程内快照 → `reset + inc` 同步进自有 Counter（快照是单调计数器/唯一事实来源，映射后 counter 语义仍成立，对 scheduler 热路径零侵入）。
- 运行时指标（执行成败/SSE 并发/通知投递/callback 分类）埋点在 TaskService/NotificationService 经 `runtime-metrics-entry` 的模块级入口，这里只做 snapshot→render。
- SSE 并发 gauge：`MetricsStreamSlotService` 占用/释放两点同步 `set()`（BUG-05 容量纪律）。
- 暴露的 series 家族（核实于 service 源码）：`autoflow_scheduler_*`（ticks/tickDurationMsTotal/lastTickDurationMs/triggers/triggersSkipped/dependencyTriggers）、`autoflow_queue_depth{state}`（waiting/active/delayed/failed/completed）、`autoflow_queue_up`、PG 连接池 `autoflow_db_pool_*`（max/active/idle/waiting）、`autoflow_executor_disk_usage_percent{address}`、callback 鉴权分类 Counter、`autoflow_metrics_streams_active/limit`。

### ExecutionReport（execution_reports）

按 `triggerDay`（DATE，唯一索引）一行的日聚合：

| 字段 | 含义 |
|---|---|
| runningCount / successCount / failCount / timeoutCount / cancelledCount | 当日各终态执行计数 |
| avgDurationMs / maxDurationMs / minDurationMs | 当日成功执行耗时统计（float） |

生成方式（`metrics.service`）：按 `createdAt` 落在当日窗口的 TaskExecution 分组统计（`GROUP BY status` + AVG/MAX/MIN duration，仅 status=SUCCESS 参与耗时），`reportRepo.create + save` 落库。task 模块是**读侧**——`task.service` 注入 `ExecutionReport` Repository，在执行详情里取 `triggerDay = execution.createdAt 所在日` 的聚合行（迁移注释明确："执行报告读侧；写方 MetricsService"）。

## 与其他模块的关系

- **依赖 [task.md](task.md) / [executor.md](executor.md) / [scheduler.md](scheduler.md)（均下一批次）**：读 Task/TaskExecution/Executor 实体；`SchedulerModule` forwardRef 提供 `SchedulerService`/`SchedulerMetricsService`（调度计数唯一事实来源）；`TaskModule` 提供 `ExecutionCallbackMetricsService`（callback 401 分类计数）。
- **被 task 模块依赖**：`ExecutionReport` Repository（经 `MetricsModule` exports `MetricsService, PrometheusMetricsService`；task 侧经 `TypeOrmModule.forFeature` 独立注册实体亦可，以 task.module 装配为准）。
- **被 task 模块的 SSE 先例对齐**：`/logs/stream` 的并发槽位与查询参数鉴权先例被本模块三条流复用。
- **消费方**：Prometheus Server 抓取 `/api/metrics`；admin-web Dashboard 消费 summary/trend/stream——见 [../../01-apps/admin-web/README.md](../../admin-web/README.md)（规划中）。

## 常见改动场景

- **新增业务指标**：先在埋点侧（runtime-metrics-entry 或 SchedulerMetricsService）落计数，再在 `prometheus-metrics.service` 注册 Counter/Gauge 并在 render 处映射；勿直接在热路径调 prom-client。
- **加查询接口**：放 `metrics.controller`（类级 JwtAuthGuard 已兜底）；大数据量聚合记得像 trend 一样做参数上限。
- **加 SSE 流**：抄 executions-stream 的 `@Res()` 直写 + `?access_token=` 兜底 + 并发槽位三板斧；不要用 `@Sse()` 装饰器（会破全局 ResponseInterceptor）。
- **多实例部署**：每个实例暴露自己的进程内计数，Prometheus 按 per-target 抓取区分；不想重复暴露可 `METRICS_PROMETHEUS_ENABLED=false` 关掉部分实例。

## 相关文档

- 健康检查（另一套可观测面）：[health.md](health.md)；JWT 查询参数兜底：[auth.md](auth.md)
- 调度器指标来源：[scheduler.md](scheduler.md)（下一批次）；事件总线：[../README.md](../README.md) 的 DomainEventModule
- 执行回调链路：[../../04-flows/execution-callback.md](../../../04-flows/execution-callback.md)
