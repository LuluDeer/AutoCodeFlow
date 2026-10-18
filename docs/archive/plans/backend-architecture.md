# 后端架构与性能优化计划

**优先级**: 中  
**预计工作量**: 8-12 人天  
**目标**: 提升 admin-api 的性能、可扩展性和可维护性

> ## ⚠️ 实施前必读（2026-10-17 核验结论）
>
> 19 个条目逐项用 CodeGraph 核验后：**5 项早已实现**，**2 项按计划实施会造成
> 严重破坏**，真正值得做的只有 3 项。
>
> | 条目 | 真实状态 | 说明 |
> |---|---|---|
> | 1.1 批量预取 | ✅ **已实现** | `scheduler.service.ts:1517-1591` keyset 分页 id 扫描 + 一次 `In(missingIds)` 批量取。计划里的 `nextTriggerTime` 列**不存在**（调度器是内存定时器） |
> | 1.2 触发窗口索引 | ⚠️ 部分 | 有 `idx_tasks_status` / `idx_tasks_status_trigger_type`，**缺 `(status,id)`**——真实查询是 `status=ACTIVE AND id>$cursor ORDER BY id` |
> | 1.3 调度器指标 | ✅ **已实现且更细** | 5 种 skip reason + P99 直方图 + per-tick 计时 |
> | 2.1 游标分页 | ⛔ **勿按文本实施** | 见下方「最高风险」 |
> | 2.2 执行记录归档 | ⚠️ 部分 | 有 90 天保留 cron（leader 门禁 + 分批），但**只删不归档** |
> | 2.3 物化视图 | ⛔ 勿实施 | 需要 `pg_cron` 扩展，本部署没有 |
> | 3.1 动态连接池 | ✅ **已实现** | `DB_POOL_SIZE` + min/idle/conn/`statement_timeout` 全部可配 |
> | 3.2 连接池监控 | ✅ **已实现** | 4 个 `autoflow_db_pool_*` gauge 已导出 |
> | 3.3 慢查询日志 | ⬜ **缺失** | 无 subscriber / `maxQueryExecutionTime`，只有 `logging` 开关 |
> | 4.1 Redis 缓存层 | ⬜ 缺失 | 无 `cache-manager` 依赖 |
> | 4.2 系统配置缓存 | ⬜ **缺失** | `config.service.ts:57-61` 每次调用都查库 |
> | 4.3 HTTP 响应缓存 | ⬜ 缺失 | 只有一处 ETag + SSE `no-cache` |
> | 5.1 分层限流 | ⚠️ 部分 | 有 AUTH/OPS/WEBHOOK 档 + IP/executor 维度，**无 per-user 维度** |
> | 5.2 动态限流 | ⬜ 缺失 | 无负载自适应 |
> | 6.1 事件总线订阅 | ✅ **已实现且超出** | `outbound-event-dispatcher` + outbox + dead-letter 表 |
> | 6.2 事件重放 | ⚠️ 部分 | 只有 dead-letter 重放，无按类型/时间范围重放 |
> | 7.1 URL 版本控制 | ⛔ **勿按文本实施** | 见下方「最高风险」 |
> | 7.2 向后兼容层 | ⚠️ 部分 | 逐端点 compat 别名，无通用 DTO 转换层（大概率不需要） |
>
> ### 🚨 最高风险：§7.1 会一次打断四端
>
> 计划建议 `setGlobalPrefix('api/v1')`。但 `main.ts:297-307` 已经用了
> `enableVersioning({type: URI})` 且**刻意不设 `defaultVersion`**
> （VERSION_NEUTRAL）。加 `/v1` 前缀会**同时**打断 admin-web、acf-cli、
> mcp-server 与执行器机器面路由——这是本计划里危害最大的一条。
>
> ### 🚨 §2.1 会破坏响应契约
>
> 游标分页要改响应信封（`nextCursor`），而
> `apps/admin-web/src/api/tasks.ts:396-430` 是**逐字段校验**的，
> `check:openapi-response-schema` 也钉住了 226 个响应形态。
>
> ### ✅ 真正值得做的三项
> 1. **3.3 慢查询日志**（`maxQueryExecutionTime`，配置层）
> 2. **1.2 `(status,id)` 复合索引**（纯迁移；`check-index-drift.mjs` 是单向的
>    entity ⊆ DDL，DDL-only 索引能过）
> 3. **4.2 SystemConfig 缓存**（写路径全部收敛在 `upsert/remove/rollback`，
>    本地失效完备；跨实例可复用 `token-cache-sync.service.ts:141-154` 的 pub/sub）

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

## 实施路线图（2026-10-17 核验后重排）

### ✅ 已完成（无需动工）
- [x] **1.1 批量预取任务**——keyset 分页 + 单次批量取
- [x] **1.3 调度器指标细化**——5 种 skip reason + P99 直方图 + per-tick 计时
- [x] **3.1 动态连接池**——`DB_POOL_SIZE` + min/idle/conn/statement 全可配
- [x] **3.2 连接池监控**——4 个 `autoflow_db_pool_*` gauge
- [x] **6.1 事件总线订阅**——outbound dispatcher + outbox + dead-letter
- [x] **7.1 URL 版本控制**——`enableVersioning(URI)`，刻意 VERSION_NEUTRAL

### ⛔ 不要实施（会造成破坏）
- **7.1 按计划文本加 `/api/v1` 前缀**——同时打断四端
- **2.1 游标分页**——改响应信封，破坏 admin-web 逐字段校验与 226 个 schema 基线
- **2.3 物化视图**——依赖 `pg_cron`，本部署没有

### ✅ 已实施（2026-10-17 第二轮）
1. ~~3.3 慢查询日志~~ ✅ **已实施**——`DB_SLOW_QUERY_MS`（默认 1000，0=关闭）→
   TypeORM **顶层** `maxQueryExecutionTime`（非 `extra`：`PostgresQueryRunner`
   读的是 `driver.options.maxQueryExecutionTime`）+ Joi 校验 + `.env.example` 登记。
2. ~~1.2 `(status,id)` 复合索引~~ ✅ **已实施**——迁移 `1790000000056`，
   `idx_tasks_status_id`，`CREATE INDEX CONCURRENTLY` + `transaction=false`。
   **刻意不删**已冗余的 `idx_tasks_status`（删索引不可逆，需先量测）。
3. ~~4.2 SystemConfig 缓存~~ ✅ **已实施**——`SYSTEM_CONFIG_CACHE_TTL_MS`
   （默认 1000，0=关闭），**4 条写路径全部 `try/finally` 失效**
   （upsert / batchUpsert / remove / rollback——失败也要失效，因为写可能部分生效）。
   不做负缓存；跨实例 pub/sub **明确未做**，限制与逃生舱写在代码注释里。

### ⬜ 仍然待办（按价值排序）
1. **2.2 执行记录保留**——**部分完成（2026-10-17 第三轮）**：
   · ✅ 复核确认 `task_executions` 走 **90 天硬删**（`executor.service.cleanupOldRecords`
     → `cleanupOldTaskExecutions`，每日 02:00 cron + LeaderGate，分批 DELETE 并连带
     回收执行日志与 S3 日志对象），且 **90 天此前是硬编码**。已改为可配置
     `TASK_EXECUTION_RETENTION_DAYS`（缺省 90 = 行为逐字节不变；非法/零/负数归一为 90，
     取用点再归一一次——**防"配错一个字符把 cutoff 推到未来而删空表"**）。
     "硬删除且不可逆、没有归档表"的语义已写进 `.env.example` / `docs/deployment.md`
     / `docs/operations.md` 三处（此前是隐含约定）。
   · ⬜ **归档表本身未建**：这是**业务决策**（"合规是否要求留存超过保留期的执行
     记录"），没有这个前提就建表 = 凭空多一条要长期维护的写入路径 + 一份永远没人
     查的数据。前置信息本轮已备齐，决策留给维护者。
2. ~~**2.1 游标分页**~~ ✅ **已完成（2026-10-17 第五轮，加性过渡）**：`GET /tasks/:id/executions`
   已支持可选 `cursor` 参数 + 响应**追加** `nextCursor`。既有 6 个信封字段的名字/类型/
   必现性**一个没动**——不带 `cursor` 时走原 OFFSET 路径且**逐字节不变**（用 `undefined`
   让键整个不出现，而不是恒下发 `null`，后者会多一个键）。带 `cursor` 时走 keyset 分支，
   复用既有 `(taskId, createdAt DESC, id DESC)` 索引。
   **修掉一个真实精度缺陷**：`createdAt` 是 PG `TIMESTAMP`（微秒）而 JS `Date` 只有毫秒，
   教科书式元组比较 `(a,b) < (:at,:id)` 会把同一毫秒内的行**重复返回**（库里
   `…:00.123456 > …:00.123`）→ 翻页永不到末页。改用毫秒半开区间谓词
   `(createdAt < :at OR (createdAt < :atNext AND id < :cursorId))`，对微秒/毫秒两种行集
   判定完全一致。非法游标一律 400（**绝不**静默退回第一页——那是死循环的源头）。
   `total` 仍返回真实总数：它不是「估算」，四端都在渲染「共 N 条」，改语义即撒谎。
   ⬜ **仍未做**：推广到其余分页端点（`GET /tasks` / `executions/all` / audit /
   executor-package）+ admin-web 迁移消费 `nextCursor`。**刻意分轮**：一次改四端是反模式。
3. **5.1 per-user 限流维度**、**4.1/4.3 缓存层**、**5.2 动态限流**、
   **6.2 按类型/时间重放**——价值中等，需先有真实负载基线再决定。
4. ~~**4.2 跨实例缓存失效**~~ ✅ **已完成（2026-10-17 第五轮）**：新增
   `config-cache-sync.service.ts`，**逐条照抄** `token-cache-sync.service.ts` 已验证的
   先例（不发明第三套缓存方言）：写面 PUBLISH 逐出、`ready` 事件全量清空自愈断连窗口、
   fail-open 三层（PUBLISH 失败不改写操作结果 / Redis 不可用靠 TTL 兜底 / 不建立订阅）。
   `@Optional` 尾参注入，既有 `config.service` 单测零破坏。

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
