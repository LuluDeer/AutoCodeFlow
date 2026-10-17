# 可观测性与监控优化计划

**优先级**: 高  
**预计工作量**: 6-8 人天  
**目标**: 建立完整的监控、日志、追踪体系，快速定位生产问题

> ## ⚠️ 实施前必读（2026-10-17 核验结论）
>
> 本计划编写时对现状有较多误判（例如以为没有 Prometheus/Grafana/Loki）。
> 下表是 CodeGraph + 配置核验后的**事实状态**。
>
> | 计划条目 | 真实状态 | 说明 |
> |---|---|---|
> | §1.1-1.3 指标完善 | ✅ **已实现（本次）** | 见下方「已实施」 |
> | §2.1 系统总览 Dashboard | ✅ **已存在** | `docs/observability/grafana-dashboard.json` 已被 compose **真实挂载**到 Grafana provisioning（22 面板 / 5 行），本次新增 RED 行 |
> | §2.2 告警规则 | ✅ **已存在且远超计划** | `config/monitoring/alerts.yml` 原 26 条，本次增至 **30 条**；有专门的同源守卫 `check-alerts-rules.mjs` |
> | §2.3 业务 Dashboard | ✅ **部分已有** | 执行趋势/延迟/容量已有面板 |
> | §3.1 结构化日志 | ✅ **已存在** | `main.ts` 用 Nest 原生 `ConsoleLogger({ json: true })`，**不需要 pino** |
> | §3.3 日志聚合 | ✅ **已存在** | `config/monitoring/loki.yml` + `promtail.yml` + Grafana datasource 全部就位 |
> | §4 分布式追踪 | ⚠️ **半成品（依赖已复核，非"死依赖"）** | 实际跑的是手写的 `TracingService`（进程内 span，日志行），默认 `OTEL_ENABLED=false`，**无 exporter**，compose 里的 `jaeger` 容器没有任何生产者。`@opentelemetry/api` **确实零 import**，但**不是可随手删的累赘**——①它是 OBS-01 认领记录里写明的 **SDK 挂载锚点**（接 Jaeger/Tempo 只需挂 `TracerProvider`，埋点调用点零改动）；②**`prom-client` 把 `@opentelemetry/api` 声明为硬运行时依赖**（`dependencies: {"@opentelemetry/api":"^1.4.0"}`，已核 lockfile），所以删掉 admin-api 的直接声明**不会把它从依赖树里移除**，只会让将来的 import 退回"依赖传递依赖"。我们的直接声明（`^1.9.1`）实际是在**钉版本**。结论：保留，缺的只是 exporter |
> | §「Alertmanager 真实接收端」 | ✅ **已完成（本轮）** | 加签侧车 `scripts/alertmanager-hmac-proxy.mjs` 落地并接线：`alertmanager.yml` 默认 receiver 已指向它，零依赖 + 离线自检（金向量/契约对账/真实 HTTP）+ CI 常驻 |
> | §5.1 详细健康检查 | ✅ **已实现（本次补磁盘/堆）** | 原有 db/redis/queue/executors/tasks/scheduler 六项；本次新增 disk + memory |
> | §5.2 Readiness vs Liveness | ✅ **已存在** | `/health/live` 与 `/health/ready` 都有，且 ready 已正确返回 **503** |
> | §6 APM / §7 Profiling | ⬜ 未实现 | 可选层 |

---

## ✅ 本次已实施（2026-10-17）

### A. HTTP RED 指标（此前完全缺失）

新增 6 个指标，全部为 `autoflow_` 前缀、声明在 `prometheus-metrics.service.ts`
（**这是 `check-alerts-rules.mjs` 指标清单的唯一来源**，写在别的文件里守卫看不见）：

| 指标 | 类型 | 标签 |
|---|---|---|
| `autoflow_http_requests_total` | Counter | `method`, `route`, `status_class` |
| `autoflow_http_request_duration_ms_bucket` | Counter（手写直方图桶） | `method`, `route`, `status_class`, `le` |
| `autoflow_http_request_duration_ms_sum` | Counter | `method`, `route`, `status_class` |
| `autoflow_http_request_duration_ms_count` | Counter | `method`, `route`, `status_class` |
| `autoflow_executors_online` | Gauge | — |
| `autoflow_executors_total` | Gauge | — |

**关键设计**（都是踩过坑的地方）：

- **没有引入 `prom-client` Histogram**：本仓既有直方图（`scheduler_trigger_latency_ms_*`）
  是三个手写 Counter + `doRender` 里 reset+inc 重建 series 的形态。新指标沿用同一
  惯例，不引入第二种直方图方言。
- **`route` 只能是 Express 路由模板**（`req.baseUrl + req.route.path`，如 `/tasks/:id`），
  未匹配时固定 `"unmatched"`。**绝不回退原始 URL**——未匹配路径正是扫描器最爱打的
  （`/.env`、`/wp-admin`），回退等于把基数交给攻击者。
- **SSE / 长连接排除**：拦截器按 `isSsePath` + `text/event-stream` 双判据跳过。
  一条挂几小时的日志流会让 `_sum` 变成「在线时长」，P99 直接被单条流带偏。
- **fleet gauge 在 DB 查询失败时保留旧值**（`renderExecutorFleetGauges` 直接 return）。
  这是 `AllExecutorsOffline` 告警安全的前提：一次 PG 抖动绝不能渲染出 `online=0`。
  告警侧另加 `and sum(autoflow_executors_total) > 0` 守卫，全新部署不会一装就炸。
- 埋点整段 try/catch：观测是旁路，任何异常都不能把已成功的响应变成 500。

### B. 健康检查补磁盘 / 堆水位

`health.service.ts` 新增 `checkDisk()`（`fs.statfs`，用 `bavail` 而非 `bfree`
——容器内进程常非 root，`bfree` 含保留块会系统性低估水位）与 `checkMemory()`
（`process.memoryUsage().heapUsed` / `v8.getHeapStatistics().heap_size_limit`，
**不是** `os.totalmem()`——容器限 512MB 而宿主 32GB 时用后者算比例恒个位数、
永远不会告警）。

两档阈值（默认 85% degraded / 95% unhealthy）走 `health.*` 配置并登记进
`.env.example`（`check-env-drift.mjs` 是 CI 门禁）。

**刻意不进 `/health/ready`**：就绪探针只管核心依赖，磁盘慢不该触发全站摘流量。
`readiness-http-status.spec.ts` 钉住了这个行为，并有专门用例断言 ready 不查磁盘。

### C. 告警 + 看板

- 新增 4 条规则（`AUTOFLOW_HTTP_5XX_RATE_HIGH`、`AUTOFLOW_HTTP_LATENCY_P99_HIGH`、
  `AUTOFLOW_ALL_EXECUTORS_OFFLINE`、`AUTOFLOW_SSE_TICKET_REJECTED`），同步镜像到
  `docs/observability/alerting-rules.yml`（守卫做语义级对账，两份必须一致）。
- Grafana 看板新增「HTTP RED」行（面板 601-604）。

> **守卫的已知限制**：`check-alerts-rules.mjs` 的 `PROMQL_STOPWORDS` 不含
> `route` / `status_class`，所以 `sum by (route)` 会被判成「清单外指标」。
> 本次通过「看板用未聚合 `rate()`（legend 显示 route）、告警用集群级 `sum()`」
> 绕开，**没有削弱守卫**。若将来要 per-route 告警实例，需扩充该 stopword 列表。

---

## 仍然待办（按价值排序）

1. **分布式追踪**：缺的是**真正的 OTLP exporter**（需要 collector），不是"删死依赖"。
   ~~删掉 `@opentelemetry/api`~~ —— **已驳回**：核 lockfile 后确认 `prom-client` 把
   `@opentelemetry/api` 作为**硬运行时依赖**（`dependencies["@opentelemetry/api"]="^1.4.0"`），
   删掉 admin-api 的直接声明不会把它从 `node_modules` 移除，反而让未来的 import 退回
   "靠传递依赖"（更差）；且 admin-api 的 `^1.9.1` 正是钉住版本的那一处。它同时是
   OBS-01 认领记录里的 SDK 挂载锚点。**处置：保留依赖，只补 exporter。**
   另：手写 `TracingService` 的 `parentSpanId` 恒为 `null`，没有真正的父子树。
2. ~~**Alertmanager 没有真实接收端**~~ ✅ **已完成（本轮）**：加了零依赖加签
   侧车 `scripts/alertmanager-hmac-proxy.mjs`（`node:24-alpine` 只读挂载，不映射
   宿主端口），`config/monitoring/alertmanager.yml` 的默认 `route.receiver` 已从
   `'noop'` 改为 `'hmac-proxy'`——30 条规则不再进黑洞。启用只需 `.env` 里设
   `ALERT_WEBHOOK_SECRET` + 拉起 monitoring profile。未配置 secret 时侧车
   **拒绝启动**（fail-closed，`restart: 'no'` 不会重启刷屏），Alertmanager 自身
   日志会报投递失败——**可见的失败**，刻意不做成静默黑洞。自检
   `npm run test:alert-proxy`（已进 CI）；同一组金向量同时钉在 admin-api 的
   `webhook-hmac.util.spec.ts`，两侧算法单侧漂移必然被拦。
3. **APM / Profiling**（§6-§7）：可选层，未实现。
4. `TraceMiddleware` 是死代码（`TraceIdMiddleware` 已接线，`TraceMiddleware` 没有）。
5. `main.ts` 的 fatal 路径仍用裸 `console.error`，会污染 JSON 日志流。

---

## 优化方案（原始草案，供参考）

## 1. Prometheus 指标体系完善

### 背景
当前已有基础指标，但覆盖不全。

### 优化方案

#### 1.1 业务指标（RED 方法）
```typescript
// metrics/business.metrics.ts
@Injectable()
export class BusinessMetrics {
  // Rate（请求速率）
  recordRequest(endpoint: string, method: string) {
    this.counter('http_requests_total', { endpoint, method });
  }
  
  // Error（错误率）
  recordError(endpoint: string, statusCode: number) {
    this.counter('http_errors_total', { endpoint, status: String(statusCode) });
  }
  
  // Duration（响应时间）
  recordDuration(endpoint: string, durationMs: number) {
    this.histogram('http_request_duration_ms', durationMs, { endpoint });
  }
  
  // 任务执行指标
  recordTaskExecution(runtime: string, status: string, durationMs: number) {
    this.counter('task_executions_total', { runtime, status });
    this.histogram('task_execution_duration_ms', durationMs, { runtime });
  }
  
  // 调度器指标
  recordSchedulerTick(tickName: string, durationMs: number, skipped: number) {
    this.histogram('scheduler_tick_duration_ms', durationMs, { tick: tickName });
    this.gauge('scheduler_tasks_skipped', skipped, { tick: tickName });
  }
}
```

#### 1.2 系统指标（USE 方法）
```typescript
// metrics/system.metrics.ts
@Injectable()
export class SystemMetrics {
  private interval: NodeJS.Timeout;
  
  onModuleInit() {
    // 每 15 秒采集一次系统指标
    this.interval = setInterval(() => this.collect(), 15000);
  }
  
  private async collect() {
    // Utilization（利用率）
    const cpuUsage = process.cpuUsage();
    this.gauge('process_cpu_user_seconds_total', cpuUsage.user / 1e6);
    this.gauge('process_cpu_system_seconds_total', cpuUsage.system / 1e6);
    
    const memUsage = process.memoryUsage();
    this.gauge('process_memory_heap_bytes', memUsage.heapUsed);
    this.gauge('process_memory_external_bytes', memUsage.external);
    
    // Saturation（饱和度）
    const pool = this.dataSource.driver.pool;
    this.gauge('db_pool_active_connections', pool.totalCount - pool.idleCount);
    this.gauge('db_pool_idle_connections', pool.idleCount);
    this.gauge('db_pool_utilization', (pool.totalCount - pool.idleCount) / pool.totalCount);
    
    // Errors（错误）
    const errorCount = await this.getErrorCountLast5Min();
    this.gauge('errors_last_5min', errorCount);
  }
}
```

#### 1.3 自定义业务指标
```typescript
// 执行器在线数
this.gauge('executors_online_count', onlineCount);

// 任务队列深度
this.gauge('task_queue_depth', queueSize, { priority: 'high' });

// outbox 积压
this.gauge('outbox_pending_count', pendingCount);

// 用户活跃度
this.gauge('active_sessions_count', sessionCount);
```

---

## 2. Grafana Dashboard

### 背景
有指标但没有可视化面板。

### 优化方案

#### 2.1 系统总览 Dashboard
```json
// grafana/dashboards/overview.json
{
  "dashboard": {
    "title": "AutoCodeFlow 系统总览",
    "panels": [
      {
        "title": "请求速率",
        "targets": [{
          "expr": "rate(http_requests_total[5m])"
        }]
      },
      {
        "title": "错误率",
        "targets": [{
          "expr": "rate(http_errors_total[5m]) / rate(http_requests_total[5m])"
        }]
      },
      {
        "title": "P99 响应时间",
        "targets": [{
          "expr": "histogram_quantile(0.99, rate(http_request_duration_ms_bucket[5m]))"
        }]
      },
      {
        "title": "执行器在线数",
        "targets": [{
          "expr": "executors_online_count"
        }]
      },
      {
        "title": "任务执行成功率",
        "targets": [{
          "expr": "rate(task_executions_total{status=\"SUCCESS\"}[5m]) / rate(task_executions_total[5m])"
        }]
      }
    ]
  }
}
```

#### 2.2 告警 Dashboard
```yaml
# prometheus/alerts/autocodeflow.yml
groups:
  - name: autocodeflow
    interval: 30s
    rules:
      # 错误率过高
      - alert: HighErrorRate
        expr: rate(http_errors_total[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "错误率超过 5%"
          description: "最近 5 分钟错误率为 {{ $value | humanizePercentage }}"
      
      # 执行器全部离线
      - alert: AllExecutorsOffline
        expr: executors_online_count == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "所有执行器离线"
          description: "没有可用的执行器，任务无法执行"
      
      # 数据库连接池饱和
      - alert: DBPoolSaturated
        expr: db_pool_utilization > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "数据库连接池利用率过高"
          description: "连接池利用率 {{ $value | humanizePercentage }}，可能需要扩容"
      
      # 调度器 tick 超时
      - alert: SchedulerTickSlow
        expr: histogram_quantile(0.95, rate(scheduler_tick_duration_ms_bucket[5m])) > 5000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "调度器 tick 响应慢"
          description: "95% 的 tick 超过 5 秒"
```

#### 2.3 业务 Dashboard
```json
{
  "title": "任务执行监控",
  "panels": [
    {
      "title": "执行趋势（最近 24 小时）",
      "type": "graph",
      "targets": [{
        "expr": "increase(task_executions_total[1h])",
        "legendFormat": "{{status}}"
      }]
    },
    {
      "title": "执行时长分布",
      "type": "heatmap",
      "targets": [{
        "expr": "rate(task_execution_duration_ms_bucket[5m])"
      }]
    },
    {
      "title": "Top 10 最慢任务",
      "type": "table",
      "targets": [{
        "expr": "topk(10, avg_over_time(task_execution_duration_ms[1h]))"
      }]
    }
  ]
}
```

---

## 3. 结构化日志

### 背景
当前日志是纯文本，难以查询和分析。

### 优化方案

#### 3.1 JSON 格式日志
```typescript
// logging/json-logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: req.headers,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
  base: {
    service: 'admin-api',
    version: process.env.npm_package_version,
    hostname: os.hostname(),
  },
});

// 使用
logger.info({ 
  msg: 'Task executed', 
  taskId: 123, 
  executionId: 456, 
  duration: 1234, 
  status: 'SUCCESS' 
});
// 输出：
// {"level":"info","time":1234567890,"service":"admin-api","msg":"Task executed","taskId":123,...}
```

#### 3.2 关键事件日志
```typescript
// 审计日志
logger.info({ 
  event: 'user.login', 
  userId: user.id, 
  ip: req.ip, 
  userAgent: req.headers['user-agent'] 
});

// 安全事件
logger.warn({ 
  event: 'auth.failed', 
  username: dto.username, 
  ip: req.ip, 
  reason: 'invalid_password',
  attemptCount: 3,
});

// 性能事件
logger.debug({ 
  event: 'query.slow', 
  duration: 1234, 
  query: sql, 
  table: 'executions' 
});
```

#### 3.3 日志聚合（Loki / ELK）
```yaml
# docker-compose.yml
loki:
  image: grafana/loki:2.9.0
  ports:
    - "3100:3100"
  command: -config.file=/etc/loki/local-config.yaml

promtail:
  image: grafana/promtail:2.9.0
  volumes:
    - /var/log:/var/log
    - ./promtail-config.yml:/etc/promtail/config.yml
  command: -config.file=/etc/promtail/config.yml

# promtail-config.yml
clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: admin-api
    static_configs:
      - targets:
          - localhost
        labels:
          job: admin-api
          __path__: /var/log/admin-api/*.log
```

---

## 4. 分布式追踪

### 背景
跨服务调用链路不可见，难以定位性能瓶颈。

### 优化方案

#### 4.1 OpenTelemetry 集成
```typescript
// tracing/otel.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

const sdk = new NodeSDK({
  traceExporter: new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces',
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new PgInstrumentation(),
  ],
});

sdk.start();
```

#### 4.2 自定义 Span
```typescript
import { trace } from '@opentelemetry/api';

async function enqueueTask(task: Task) {
  const tracer = trace.getTracer('scheduler');
  const span = tracer.startSpan('enqueue_task', {
    attributes: {
      'task.id': task.id,
      'task.name': task.name,
      'task.runtime': task.runtime,
    },
  });
  
  try {
    await this.claimTaskTrigger(task);
    await this.queue.add('execute', { taskId: task.id });
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
```

#### 4.3 Trace 可视化（Jaeger）
```yaml
# docker-compose.yml
jaeger:
  image: jaegertracing/all-in-one:1.51
  ports:
    - "5775:5775/udp"
    - "6831:6831/udp"
    - "6832:6832/udp"
    - "5778:5778"
    - "16686:16686" # Web UI
    - "14268:14268"
```

**访问**: http://localhost:16686

---

## 5. 健康检查增强

### 背景
当前 /health 端点只返回 200，没有细节。

### 优化方案

#### 5.1 详细健康检查
```typescript
// health/health.controller.ts
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator, DiskHealthIndicator, MemoryHealthIndicator } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private disk: DiskHealthIndicator,
    private memory: MemoryHealthIndicator,
    private customIndicators: CustomHealthIndicators,
  ) {}
  
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.customIndicators.redisCheck('redis'),
      () => this.customIndicators.executorsCheck('executors'),
      () => this.customIndicators.schedulerCheck('scheduler'),
      () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.9 }),
      () => this.memory.checkHeap('memory_heap', 768 * 1024 * 1024), // 768MB
    ]);
  }
}

// 返回示例
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up", "ping": "1ms" },
    "executors": { "status": "up", "online": 3, "total": 5 },
    "scheduler": { "status": "up", "lastTick": "2s ago" },
    "disk": { "status": "up", "used": "45%" },
    "memory_heap": { "status": "up", "used": "512MB", "limit": "768MB" }
  },
  "error": {},
  "details": { ... }
}
```

#### 5.2 Readiness vs Liveness
```typescript
// Liveness: 进程是否存活（Kubernetes 用于重启）
@Get('live')
live() {
  return { status: 'ok' };
}

// Readiness: 是否准备好接收流量（Kubernetes 用于负载均衡）
@Get('ready')
@HealthCheck()
ready() {
  return this.health.check([
    () => this.db.pingCheck('database'),
    () => this.customIndicators.redisCheck('redis'),
    // 不检查 disk/memory，只要核心依赖可用就算 ready
  ]);
}
```

---

## 6. APM 集成（可选）

### 背景
需要更专业的应用性能监控。

### 优化方案

#### 6.1 Elastic APM
```typescript
// main.ts
import apm from 'elastic-apm-node';

if (process.env.ELASTIC_APM_ENABLED === 'true') {
  apm.start({
    serviceName: 'admin-api',
    serverUrl: process.env.ELASTIC_APM_SERVER_URL,
    environment: process.env.NODE_ENV,
  });
}
```

**收益**:
- 自动追踪 HTTP / DB / Redis 调用
- 错误堆栈自动上报
- 慢事务自动标记
- 服务地图可视化

#### 6.2 Sentry 错误追踪
```typescript
// main.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1, // 10% 的请求发送 trace
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new Sentry.Integrations.Postgres(),
  ],
});

// 全局错误处理器
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    Sentry.captureException(exception);
    // ... 返回响应
  }
}
```

---

## 7. 性能 Profiling

### 背景
生产环境偶发性能问题，需要 profiling 工具。

### 优化方案

#### 7.1 内置 profiler 端点（仅开发环境）
```typescript
// profiler.controller.ts
import v8Profiler from 'v8-profiler-next';
import heapdump from 'heapdump';

@Controller('profiler')
@UseGuards(AdminGuard)
export class ProfilerController {
  @Post('cpu/start')
  startCpuProfile() {
    v8Profiler.startProfiling('cpu', true);
    return { message: 'CPU profiling started' };
  }
  
  @Post('cpu/stop')
  async stopCpuProfile(@Res() res: Response) {
    const profile = v8Profiler.stopProfiling('cpu');
    profile.export((error, result) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="cpu-${Date.now()}.cpuprofile"`);
      res.send(result);
      profile.delete();
    });
  }
  
  @Post('heap/snapshot')
  async takeHeapSnapshot(@Res() res: Response) {
    const filename = `/tmp/heapsnapshot-${Date.now()}.heapsnapshot`;
    heapdump.writeSnapshot(filename, (err, filepath) => {
      res.download(filepath);
    });
  }
}
```

**使用**:
1. POST /profiler/cpu/start
2. 执行负载
3. POST /profiler/cpu/stop（下载 .cpuprofile 文件）
4. 在 Chrome DevTools > Performance 中加载分析

---

## 实施路线图（2026-10-17 核验后重排）

### ✅ 已完成
- [x] **1.1-1.3 Prometheus 指标完善**——HTTP RED（4 个）+ 执行器 fleet（2 个）
- [x] **2.1 系统总览 Dashboard**——**早已存在**并被 compose 真实挂载；本次加 RED 行
- [x] **2.2 告警规则配置**——**早已存在**（26 条）；本次增至 30 条
- [x] **5.1-5.2 健康检查增强**——live/ready 早已有；本次补 disk + memory
- [x] **3.1 JSON 结构化日志**——**早已存在**（Nest `ConsoleLogger({json:true})`，无需 pino）
- [x] **3.3 日志聚合（Loki）**——**早已存在**（loki.yml + promtail.yml + datasource）

### ⬜ 仍然待办
1. **4.1 分布式追踪**——真正的 OTLP exporter（**不是**"删死依赖"：已核 lockfile，
   `@opentelemetry/api` 是 `prom-client` 的硬运行时依赖 + 本仓的 SDK 挂载锚点）
2. **Alertmanager 真实接收端**——需要 HMAC 签名 sidecar
3. **3.2 关键事件日志**——部分已有，可继续补齐结构化事件字段
4. **2.3 业务 Dashboard**——补执行趋势/成功率面板（数据源已具备）
5. **6.1-6.2 APM**、**7.1 Profiling**——可选层

## 依赖项（核验后）

**已在用**：Prometheus + Grafana、Loki + Promtail、prom-client、Redis exporter、
postgres exporter。

**计划中提到但本仓并不需要 / 并未引入**：
- `pino`——**不需要**，Nest 原生 JSON logger 已够用，引入反而是第二套日志方言。
- `@nestjs/terminus`——**不需要**，健康检查是手写实现且已覆盖 six checks + 探针语义；
  换 terminus 会重写已验证的 503 行为。
- `@opentelemetry/*`——**已复核**：`@opentelemetry/api` 在源码里零 import，但
  (a) 是 OBS-01 认领记录写明的 SDK 挂载锚点（接 Jaeger/Tempo 只挂 `TracerProvider`，
  埋点调用点零改动）；(b) `prom-client` 已把它作为**硬运行时依赖**引入
  （`dependencies["@opentelemetry/api"]="^1.4.0"`）——**删掉 admin-api 的直接声明
  不会把它从依赖树移除**，只会让未来的 import 退回依赖传递依赖；本仓的 `^1.9.1`
  是在钉版本。故**保留**。**未引入**：`sdk-*` / `exporter-*`（无 collector 部署）。
- Jaeger——compose 有容器但无生产者。

## 监控清单（核验后）

- [x] RED 指标（Rate / Errors / Duration）——**本次新增**
- [x] USE 指标（Utilization / Saturation / Errors）——db pool / redis memory 已有
- [x] 业务指标（任务执行/调度器/执行器）——已有 + 本次补 fleet
- [x] 告警规则（错误率/离线/饱和/超时）——30 条
- [x] Dashboard（系统/业务/告警）——已有 + RED 行
- [x] 日志聚合查询——Loki + Promtail 就位
- [ ] 分布式追踪可视化——**无生产者，未打通**

## 验收标准

- [ ] MTTR（平均恢复时间）< 15 分钟——需真机基线验证
- [ ] 告警准确率 > 95%（减少误报）——需真机基线验证
- [x] 日志查询响应 < 3 秒——Loki 已就位，查询路径可用
- [ ] Trace 采样率 10%，性能损耗 < 5%——**未实现**（无 exporter）
