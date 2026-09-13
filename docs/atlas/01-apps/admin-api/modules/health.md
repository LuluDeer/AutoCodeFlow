# health 模块 — 健康检查

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/health

## 职责

暴露 admin-api 自身与核心依赖（PostgreSQL、Redis、BullMQ 队列、执行器、调度器）的健康状态，供 K8s 探针、运维巡检与 Dashboard 使用。全部路由 `@Public()`（无鉴权），返回结构不包含敏感信息。

## 目录结构与关键文件

```
modules/health/
├── health.module.ts    装配：Task/Executor/TaskExecution 实体 + BullMQ "task-queue" 队列
├── health.controller.ts  @Controller("health")，5 个 @Public() GET
└── health.service.ts   各项 check（checkDatabase/Redis/Queue/Executors/Tasks/Scheduler
                         + getFullHealth/getLiveness/getReadiness）
```

## 路由（controller 前缀 `health`，全部 `@Public()`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 全量健康：`status` + `services`（database/redis/queue/executors/tasks/scheduler）+ `metrics`（任务/执行/执行器计数）+ `components` 数组（6 项检查全聚合）；支持 `HEALTH_CACHE_TTL_MS` 短 TTL 缓存（默认 0=关闭） |
| GET | `/api/health/live` | K8s liveness：进程活着即 `{status:"healthy"}`（不缓存） |
| GET | `/api/health/ready` | K8s readiness：校验 DB 与 Redis 连接，`checks[]` 逐项 pass/fail（不缓存） |
| GET | `/api/health/services` | 各核心服务状态明细（5 项并行） |
| GET | `/api/health/metrics` | 关键系统指标：totalTasks / activeTasks / runningExecutions / totalExecutors / onlineExecutors / queueSize |

## 关键机制：各项检查的判定（health.service）

| 检查 | 手段 | 判定 |
|---|---|---|
| database | `taskRepo.query("SELECT 1")` | 异常 → unhealthy（附 error message） |
| redis | 独立 `redis` 客户端（`createClient`，REDIS_HOST/PORT/PASSWORD）`ping()` | 未连接则先 connect；异常 → unhealthy |
| queue | BullMQ `task-queue` 队列 `getWaiting/Active/Delayed/FailedCount` | failed>`HEALTH_QUEUE_FAILED_MAX`(默认100) 或 delayed>`HEALTH_QUEUE_DELAYED_MAX`(默认500) 或 waiting>`HEALTH_QUEUE_WAITING_MAX`(默认1000) → **degraded**（附积压明细），异常 → unhealthy |
| executors | Executor 实体统计 totalCount / onlineCount（`ExecutorStatus.ONLINE`） | 0 注册 → degraded；全离线 → unhealthy；在线比例 < `HEALTH_EXECUTOR_ONLINE_RATIO_MIN`(默认0.5) → degraded；异常 → unhealthy（计数归零附错误详情） |
| tasks | Task / TaskExecution 实体计数：`activeCount`（TaskStatus.ACTIVE）、`totalCount`、`runningCount`（ExecutionStatus.RUNNING） | healthy（计数值供 getFullHealth 的 services.tasks/metrics 展示）；异常 → unhealthy（计数归零，details 带错误信息） |
| scheduler | BullMQ `task-queue` 队列 `getJobs(["wait", "active"])` | 能取到 job 列表即 healthy（details 带 "N jobs in queue"），异常 → unhealthy |

注意：Redis 检查用的是 `redis` 包新建的独立客户端，而非 BullMQ 底层的 ioredis 连接——排障时"health 显示 redis unhealthy 但 BullMQ 正常（或相反）"要先想到这一点。

**异常捕获边界（WIKI-OPT-1）**：六个单项检查全部自带 try/catch，失败一律转为 unhealthy 组件详情（checkTasks/checkExecutors 失败时计数归零）——任何单项检查 reject 都不会击穿 `getFullHealth()` 的 `Promise.all`（此前 checkTasks/checkExecutors 无捕获，任一 reject 会变成 HTTP 500 而非带组件详情的 unhealthy 响应）。

**短 TTL 缓存（WIKI-OPT-1）**：`HEALTH_CACHE_TTL_MS`（默认 0=关闭，行为与未缓存完全一致）>0 时，`getFullHealth()` 在 TTL 窗口内直接返回缓存的整个响应对象（含 timestamp），降低高频探针下 DB count / 队列统计 / Redis ping 的压力；`live`/`ready` 探针不缓存。阈值与缓存均经 ConfigService 读 `configuration.ts` 的 `health` 节（Joi 注册于 app.module.ts，env 登记于 `.env.example`）。

## 与其他模块的关系

- **依赖 [task.md](task.md) / [executor.md](executor.md)（均下一批次）**：读 Task、TaskExecution、Executor 实体做计数；调度器状态经 BullMQ 队列探测（不依赖 SchedulerService）。
- **依赖 BullMQ**：`BullModule.registerQueue({ name: "task-queue" })` 与 task/scheduler 模块同名注册（BullMQ 允许多处同名注册，共享底层连接）。
- **被运维设施消费**：compose/K8s 探针、`GET /api/health` 巡检脚本；Prometheus 指标不在这里（见 [metrics.md](metrics.md)）。
- **依赖 [config.md](config.md) 不成立**：health 直接经 ConfigService 读 `REDIS_*` env，不走 SystemConfigService。

## 常见改动场景

- **加一项健康检查（如 MinIO）**：`health.service` 加 `checkXxx()` 返回 `{status, details?}` → `getFullHealth()`（services + components 两处登记，components 必须全聚合）与 `services` 路由登记；判定阈值风格对齐 queue 的 degraded 语义；新阈值按"新增配置项"纪律三处同批（Joi + configuration.ts + .env.example）。
- **调探针压力/判定灵敏度（WIKI-OPT-1）**：阈值与缓存全部 env 可调——`HEALTH_QUEUE_FAILED_MAX/DELAYED_MAX/WAITING_MAX`（积压 degraded 阈值）、`HEALTH_EXECUTOR_ONLINE_RATIO_MIN`（在线比例下限）、`HEALTH_CACHE_TTL_MS`（全量响应缓存，0=关闭）；探针频率高时开缓存 TTL（如 5000~15000ms）最直接。
- **改探针行为**：`live`/`ready` 是 K8s 契约，`ready` 现只校验 DB+Redis——把强依赖加进去会放大重启风险，谨慎。
- **排查"readiness 失败"**：`checks[]` 会点名 database/redis 哪项 fail；details 字段带底层错误消息。
- **排查"executors 显示异常"**：onlineCount 来自 `ExecutorStatus.ONLINE` 的行数，先看执行器心跳是否超时（心跳窗口参数 `EXECUTOR_HEARTBEAT_*`，见 [../README.md](../README.md)），而不是 health 本身。
- **排查"整体 unhealthy 但看不出哪项坏"**：看 `components[]`（6 项全聚合，tasks 也在内）的 message 字段——单项检查失败已全部转为组件详情，不会再出现整体 500。

## 全量响应示例（以 service 返回为准；controller 的 Swagger example 暂未列 tasks 项，openapi.json 为提交的生成物、未随本次同步）

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00Z",
  "services": {
    "database": { "status": "healthy" },
    "redis": { "status": "healthy" },
    "queue": { "status": "healthy", "size": 0 },
    "executors": { "status": "healthy", "onlineCount": 3, "totalCount": 3 },
    "tasks": { "status": "healthy", "activeCount": 8, "totalCount": 10, "runningCount": 2 },
    "scheduler": { "status": "healthy" }
  },
  "metrics": {
    "totalTasks": 10, "activeTasks": 8, "runningExecutions": 2,
    "totalExecutors": 3, "onlineExecutors": 3, "queueSize": 0
  },
  "components": [
    { "name": "database", "status": "healthy" },
    { "name": "redis", "status": "healthy" },
    { "name": "queue", "status": "healthy" },
    { "name": "executors", "status": "healthy" },
    { "name": "tasks", "status": "healthy" },
    { "name": "scheduler", "status": "healthy" }
  ]
}
```

## 相关文档

- Prometheus 指标（另一套可观测面）：[metrics.md](metrics.md)
- 执行器状态语义：[executor.md](executor.md)（下一批次）
- 调度器：[scheduler.md](scheduler.md)（下一批次）
- 部署与探针配置：[../../06-infra/README.md](../../../06-infra/README.md)（规划中）
