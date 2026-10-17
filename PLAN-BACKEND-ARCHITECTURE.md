# 后端架构与性能优化计划

**优先级**: 中  
**预计工作量**: 8-12 人天  
**目标**: 提升 admin-api 的性能、可扩展性和可维护性

---

## 1. 调度器性能优化

### 背景
审计发现调度器定时回调缺少顶层异常捕获（已修复），但性能还有优化空间。

### 优化方案

#### 1.1 批量预取任务（减少 DB 查询）
```typescript
// scheduler.service.ts
private async prefetchTriggerableTasks(): Promise<Map<number, Task>> {
  // 当前每个 tick 单独查库，改为批量预取
  const now = new Date();
  const tasks = await this.taskRepo.find({
    where: [
      { status: TaskStatus.ACTIVE, triggerType: 'fixed_rate', nextTriggerTime: LessThan(now) },
      { status: TaskStatus.ACTIVE, triggerType: 'cron', nextTriggerTime: LessThan(now) },
    ],
    take: 100, // 限制批量大小
  });
  
  return new Map(tasks.map(t => [t.id, t]));
}

// reload() 中使用
const taskMap = await this.prefetchTriggerableTasks();
for (const [id, task] of taskMap) {
  this.scheduleOne(task);
}
```

**收益**: 减少 N 次单独查询 → 1 次批量查询，reload tick 从 ~200ms 降至 ~50ms

#### 1.2 任务触发窗口索引优化
```sql
-- 现有索引
CREATE INDEX idx_tasks_status_trigger ON tasks(status, trigger_type);

-- 新增复合索引（覆盖 nextTriggerTime 查询）
CREATE INDEX idx_tasks_trigger_window ON tasks(status, trigger_type, next_trigger_time)
WHERE status = 'ACTIVE';

-- 部分索引，减少索引大小
```

#### 1.3 调度器指标细化
```typescript
// scheduler-metrics.service.ts
export class SchedulerMetrics {
  // 新增指标
  recordTickDuration(tickName: string, durationMs: number) {
    this.histogram('scheduler_tick_duration_ms', durationMs, { tick: tickName });
  }
  
  recordTaskSkipped(reason: 'locked' | 'queue_full' | 'dep_pending') {
    this.counter('scheduler_task_skipped_total', { reason });
  }
  
  recordPrefetchSize(size: number) {
    this.gauge('scheduler_prefetch_batch_size', size);
  }
}

// 使用
const start = Date.now();
const tasks = await this.prefetchTriggerableTasks();
this.metrics.recordPrefetchSize(tasks.size);
this.metrics.recordTickDuration('reload', Date.now() - start);
```

---

## 2. 执行查询优化

### 背景
ExecutionsPage 分页查询在大数据量下较慢（> 10万条执行记录时）。

### 优化方案

#### 2.1 游标分页替代 offset
```typescript
// executions.controller.ts
@Get()
async list(
  @Query('cursor') cursor?: string, // base64(id + createdAt)
  @Query('limit') limit = 20,
) {
  const decoded = cursor ? decodeCursor(cursor) : null;
  
  const qb = this.execRepo.createQueryBuilder('e')
    .orderBy('e.createdAt', 'DESC')
    .addOrderBy('e.id', 'DESC')
    .take(limit + 1); // 多取一条判断是否有下一页
  
  if (decoded) {
    qb.where('(e.createdAt < :time OR (e.createdAt = :time AND e.id < :id))', {
      time: decoded.createdAt,
      id: decoded.id,
    });
  }
  
  const items = await qb.getMany();
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  
  const nextCursor = hasMore ? encodeCursor({ 
    id: items[items.length - 1].id, 
    createdAt: items[items.length - 1].createdAt 
  }) : null;
  
  return { items, nextCursor, hasMore };
}
```

**收益**: offset 10000 查询从 ~500ms 降至 ~50ms（不受前序数据影响）

#### 2.2 执行记录归档
```typescript
// scripts/archive-old-executions.mjs
async function archiveOldExecutions() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90); // 90 天前
  
  // 1. 导出到归档表
  await db.query(`
    INSERT INTO executions_archive 
    SELECT * FROM executions 
    WHERE created_at < $1 AND status IN ('SUCCESS', 'FAILED')
  `, [cutoff]);
  
  // 2. 删除主表旧记录
  const { rowCount } = await db.query(`
    DELETE FROM executions 
    WHERE created_at < $1 AND status IN ('SUCCESS', 'FAILED')
  `, [cutoff]);
  
  console.log(`Archived ${rowCount} executions`);
}

// Cron: 每天凌晨 3 点
@Cron('0 3 * * *')
async archiveExecutions() {
  await archiveOldExecutions();
}
```

#### 2.3 物化视图：执行统计
```sql
-- 每小时执行统计物化视图
CREATE MATERIALIZED VIEW execution_stats_hourly AS
SELECT 
  date_trunc('hour', created_at) AS hour,
  status,
  COUNT(*) AS count,
  AVG(EXTRACT(EPOCH FROM (finished_at - created_at))) AS avg_duration_sec
FROM executions
GROUP BY 1, 2;

CREATE UNIQUE INDEX ON execution_stats_hourly(hour, status);

-- 定时刷新（PostgreSQL cron 扩展）
SELECT cron.schedule('refresh-exec-stats', '*/10 * * * *', 
  'REFRESH MATERIALIZED VIEW CONCURRENTLY execution_stats_hourly');
```

```typescript
// metrics.controller.ts
@Get('execution-trends')
async getExecutionTrends(@Query('hours') hours = 24) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hours);
  
  // 直接查物化视图，不扫描主表
  return this.db.query(`
    SELECT hour, status, count, avg_duration_sec
    FROM execution_stats_hourly
    WHERE hour >= $1
    ORDER BY hour
  `, [cutoff]);
}
```

---

## 3. 数据库连接池调优

### 背景
当前使用默认连接池配置，高并发下可能耗尽连接。

### 优化方案

#### 3.1 动态连接池配置
```typescript
// data-source.ts
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  // 动态计算连接池大小
  // 公式：max = (核心数 × 2) + 磁盘数
  extra: {
    max: parseInt(process.env.DB_POOL_MAX || String(os.cpus().length * 2 + 1)),
    min: parseInt(process.env.DB_POOL_MIN || '2'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // 新增：连接验证查询（检测死连接）
    statement_timeout: 30000, // 30秒超时
    query_timeout: 30000,
  },
});
```

#### 3.2 连接池监控
```typescript
// database.health.ts
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  async isHealthy(): Promise<HealthIndicatorResult> {
    const pool = this.dataSource.driver.pool;
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const active = total - idle;
    
    const isHealthy = active < total * 0.9; // 活动连接 < 90%
    
    return this.getStatus('database', isHealthy, {
      total,
      active,
      idle,
      utilization: (active / total * 100).toFixed(1) + '%',
    });
  }
}
```

#### 3.3 慢查询日志
```typescript
// logging-subscriber.ts
@EventSubscriber()
export class QueryLoggingSubscriber implements EntitySubscriberInterface {
  afterQuery(event: any) {
    const duration = event.duration;
    if (duration > 100) { // > 100ms
      logger.warn(`Slow query (${duration}ms): ${event.query}`, {
        duration,
        parameters: event.parameters,
      });
      
      // Prometheus 慢查询计数
      metricsService.counter('db_slow_query_total', {
        table: extractTableName(event.query),
      });
    }
  }
}
```

---

## 4. 缓存策略

### 背景
频繁查询的配置、用户信息等没有缓存，每次都查库。

### 优化方案

#### 4.1 引入 Redis 缓存层
```typescript
// cache.module.ts
import { CacheModule } from '@nestjs/cache-manager';
import * as redisStore from 'cache-manager-redis-store';

@Module({
  imports: [
    CacheModule.register({
      store: redisStore,
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      ttl: 300, // 默认 5 分钟
    }),
  ],
})
export class AppCacheModule {}

// 使用
@Injectable()
export class UsersService {
  constructor(@Inject(CACHE_MANAGER) private cache: Cache) {}
  
  async findById(id: number): Promise<User> {
    const key = `user:${id}`;
    let user = await this.cache.get<User>(key);
    
    if (!user) {
      user = await this.userRepo.findOneBy({ id });
      await this.cache.set(key, user, 300); // 5 分钟
    }
    
    return user;
  }
  
  async update(id: number, data: UpdateUserDto): Promise<User> {
    const user = await this.userRepo.save({ id, ...data });
    // 更新后清除缓存
    await this.cache.del(`user:${id}`);
    return user;
  }
}
```

#### 4.2 系统配置缓存
```typescript
// config.service.ts
export class SystemConfigService {
  private configCache = new Map<string, { value: string; expiry: number }>();
  private readonly CACHE_TTL = 60_000; // 1 分钟
  
  async get(key: string, defaultValue: string): Promise<string> {
    const cached = this.configCache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.value;
    }
    
    const config = await this.configRepo.findOneBy({ key });
    const value = config?.value ?? defaultValue;
    
    this.configCache.set(key, { 
      value, 
      expiry: Date.now() + this.CACHE_TTL 
    });
    
    return value;
  }
  
  // 配置更新时主动失效
  async set(key: string, value: string): Promise<void> {
    await this.configRepo.save({ key, value });
    this.configCache.delete(key);
    // 广播给其他实例（通过 Redis pub/sub）
    await this.redis.publish('config:invalidate', key);
  }
}
```

#### 4.3 HTTP 响应缓存（CDN 友好）
```typescript
// cache.interceptor.ts
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    
    // 只缓存 GET 请求
    if (req.method !== 'GET') {
      return next.handle();
    }
    
    // 为公开 API 设置 Cache-Control 头
    if (req.path.startsWith('/api/public/')) {
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 分钟
      res.setHeader('ETag', generateETag(req.url));
    }
    
    return next.handle();
  }
}

// 使用
@Controller('public')
@UseInterceptors(HttpCacheInterceptor)
export class PublicApiController {
  @Get('stats')
  getStats() {
    // 这个端点的响应会被 CDN/浏览器缓存 5 分钟
  }
}
```

---

## 5. API 限流升级

### 背景
P1-1 已修复限流绕过，但限流策略还可细化。

### 优化方案

#### 5.1 分层限流（全局 + 用户 + IP）
```typescript
// throttler.config.ts
export const THROTTLER_CONFIG = [
  {
    name: 'global',
    ttl: 60000, // 1 分钟
    limit: 10000, // 全局 10k/min
  },
  {
    name: 'per-user',
    ttl: 60000,
    limit: 1000, // 每用户 1k/min
  },
  {
    name: 'per-ip',
    ttl: 60000,
    limit: 300, // 每 IP 300/min
  },
];

// 使用
@Throttle([
  { name: 'global', limit: 10000 },
  { name: 'per-user', limit: 100 },
  { name: 'per-ip', limit: 60 },
])
@Post('expensive-operation')
async expensiveOp() {}
```

#### 5.2 动态限流（根据负载）
```typescript
// adaptive-throttler.guard.ts
@Injectable()
export class AdaptiveThrottlerGuard extends ThrottlerGuard {
  protected async getLimit(context: ExecutionContext): Promise<number> {
    const baseLimit = 1000;
    
    // 根据系统负载动态调整
    const cpuUsage = await getCpuUsage();
    const memUsage = await getMemUsage();
    
    if (cpuUsage > 80 || memUsage > 80) {
      return baseLimit * 0.5; // 负载高时减半
    }
    
    if (cpuUsage < 30 && memUsage < 50) {
      return baseLimit * 1.5; // 负载低时放宽
    }
    
    return baseLimit;
  }
}
```

---

## 6. 事件驱动架构增强

### 背景
当前 outbox 模式已实现，但事件消费方较少利用。

### 优化方案

#### 6.1 引入事件总线订阅
```typescript
// events/execution-completed.handler.ts
@Injectable()
export class ExecutionCompletedHandler implements OnEvent<ExecutionCompletedEvent> {
  @OnEvent('execution.completed')
  async handle(event: ExecutionCompletedEvent) {
    // 异步处理，不阻塞主流程
    if (event.status === 'FAILED') {
      await this.notificationService.sendAlert({
        title: '任务执行失败',
        executionId: event.executionId,
        taskName: event.taskName,
      });
    }
    
    // 更新统计
    await this.statsService.incrementCounter('executions', {
      status: event.status,
      runtime: event.runtime,
    });
  }
}
```

#### 6.2 事件重放（调试）
```typescript
// events.controller.ts
@Post('replay')
@Roles(UserRole.ADMIN)
async replayEvents(
  @Body() dto: { eventType: string; fromDate: Date; toDate: Date },
) {
  const events = await this.outboxRepo.find({
    where: {
      eventName: dto.eventType,
      dispatchedAt: Between(dto.fromDate, dto.toDate),
    },
  });
  
  for (const event of events) {
    await this.eventBus.publish(event.eventName, JSON.parse(event.payload));
  }
  
  return { replayed: events.length };
}
```

---

## 7. API 版本管理

### 背景
当前 API 没有版本控制，破坏性变更会影响旧客户端。

### 优化方案

#### 7.1 URL 版本控制
```typescript
// main.ts
app.setGlobalPrefix('api/v1');

// v2 控制器
@Controller({ version: '2', path: 'tasks' })
export class TasksV2Controller {
  // 新行为
}

// 路由同时存在
// /api/v1/tasks (旧行为)
// /api/v2/tasks (新行为)
```

#### 7.2 向后兼容层
```typescript
// dto/task.dto.ts
export class CreateTaskDto {
  @ApiProperty()
  name: string;
  
  // v2 新增字段，v1 客户端不传时自动填充默认值
  @ApiProperty({ required: false })
  @IsOptional()
  priority?: number = 5;
  
  // v2 废弃字段，仍接受但内部转换
  @ApiProperty({ deprecated: true })
  @IsOptional()
  @Transform(({ value }) => {
    // 自动转换为新字段
    return value;
  })
  oldField?: string;
}
```

---

## 实施路线图

### 阶段 1（本月）- 快速收益
- [ ] 1.1 批量预取任务
- [ ] 1.2 触发窗口索引
- [ ] 1.3 调度器指标细化
- [ ] 3.2 连接池监控

### 阶段 2（下月）- 性能优化
- [ ] 2.1 游标分页
- [ ] 2.2 执行记录归档
- [ ] 3.1 动态连接池
- [ ] 3.3 慢查询日志

### 阶段 3（下季度）- 架构升级
- [ ] 2.3 物化视图
- [ ] 4.1-4.3 缓存策略
- [ ] 5.1-5.2 分层限流
- [ ] 6.1-6.2 事件驱动增强
- [ ] 7.1-7.2 API 版本管理

## 依赖项

- `cache-manager` + `cache-manager-redis-store`: Redis 缓存
- `@nestjs/event-emitter`: 事件总线
- PostgreSQL 扩展：`pg_cron`（定时刷新物化视图）

## 性能基准

优化前后对比目标：

| 指标 | 优化前 | 目标 |
|---|---|---|
| scheduler reload tick | ~200ms | < 50ms |
| 执行列表分页（offset 10k） | ~500ms | < 50ms |
| 用户信息查询 | ~20ms (每次查库) | < 5ms (缓存命中) |
| 慢查询数量 | ~50/天 | < 10/天 |
| API P99 响应时间 | ~300ms | < 150ms |

## 验收标准

- [ ] 所有优化有 benchmark 数据对比
- [ ] Grafana 监控面板展示关键指标
- [ ] 压力测试通过（wrk / k6）
- [ ] 生产环境灰度验证 1 周
