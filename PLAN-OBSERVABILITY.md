# 可观测性与监控优化计划

**优先级**: 高  
**预计工作量**: 6-8 人天  
**目标**: 建立完整的监控、日志、追踪体系，快速定位生产问题

---

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

## 实施路线图

### 阶段 1（本月）- 基础设施
- [ ] 1.1-1.3 Prometheus 指标完善
- [ ] 2.1 系统总览 Dashboard
- [ ] 2.2 告警规则配置
- [ ] 5.1-5.2 健康检查增强

### 阶段 2（下月）- 日志与追踪
- [ ] 3.1 JSON 结构化日志
- [ ] 3.2 关键事件日志
- [ ] 3.3 日志聚合（Loki）
- [ ] 4.1 OpenTelemetry 集成

### 阶段 3（下季度）- 高级特性
- [ ] 2.3 业务 Dashboard
- [ ] 4.2-4.3 分布式追踪（Jaeger）
- [ ] 6.1-6.2 APM 集成（可选）
- [ ] 7.1 性能 Profiling

## 依赖项

- Prometheus + Grafana: 指标监控
- Loki + Promtail: 日志聚合
- Jaeger: 分布式追踪
- OpenTelemetry SDK: 追踪标准
- pino: 高性能 JSON 日志
- @nestjs/terminus: 健康检查
- Elastic APM / Sentry: APM（可选）

## 监控清单

- [ ] RED 指标（Rate / Errors / Duration）
- [ ] USE 指标（Utilization / Saturation / Errors）
- [ ] 业务指标（任务执行/调度器/执行器）
- [ ] 告警规则（错误率/离线/饱和/超时）
- [ ] Dashboard（系统/业务/告警）
- [ ] 日志聚合查询
- [ ] 分布式追踪可视化

## 验收标准

- [ ] MTTR（平均恢复时间）< 15 分钟
- [ ] 告警准确率 > 95%（减少误报）
- [ ] 日志查询响应 < 3 秒
- [ ] Trace 采样率 10%，性能损耗 < 5%
