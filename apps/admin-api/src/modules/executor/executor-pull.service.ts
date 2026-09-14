import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { EVENT_SCHEMA_VERSION } from "../../common/events/domain-events";

/**
 * ARCH-32（ADR-015）：pull 模式派发队列。
 *
 * push 派发的传输层是 axios POST 到执行器 address；pull 执行器（NAT 内、
 * 零入站可达）改为从本服务的 Redis 队列拉取。调度侧语义不变——dispatch()
 * 选坑成功后把既有派发载荷 `{executionId, task, params}` 附加 traceparent
 * 与 pushedAt 入队，执行器长轮询取走即执行。
 *
 * 队列形态：每执行器一条 List（key `acf:pull:{executorId}`），LPUSH 入队 /
 * RPOP 出队（FIFO，先入先派）。多实例安全：队列在共享 Redis（ARCH-31），
 * 任意 admin-api 副本的拉取循环等价（无实例亲和）。
 *
 * 过期语义：载荷自带 pushedAt，拉取侧超过 EXECUTOR_PULL_TTL_MS 即丢弃并
 * warn（执行器长期不拉取的场景）；执行行本身由既有 stale sweep 收敛，
 * 本服务不重复兜底、不新增后台任务。
 */
@Injectable()
export class ExecutorPullService {
  private readonly logger = new Logger(ExecutorPullService.name);
  private client: Redis | null = null;

  /** 拉取循环的轮询间隔（RPOP 无 Blocking 语义，避免占用长连接）。 */
  private static readonly POLL_INTERVAL_MS = 500;

  constructor(private configService: ConfigService) {}

  /** 惰性建连（对齐 RedisLockService N3 先例：不依赖 onModuleInit 时序）。 */
  private ensureClient(): Redis | null {
    if (this.client) return this.client;
    try {
      this.client = new Redis({
        host: this.configService.get("redis.host"),
        port: this.configService.get<number>("redis.port"),
        password: this.configService.get("redis.password") || undefined,
        commandTimeout: 3000,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        // 惰性连接：pull 端点在被调用前无需 Redis 连接
        lazyConnect: false,
        maxRetriesPerRequest: 2,
      });
      this.client.on("error", (err: Error) => {
        this.logger.error(`Redis connection error: ${err.message}`);
      });
      return this.client;
    } catch (err) {
      this.logger.error(
        `Failed to create Redis client: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private queueKey(executorId: string): string {
    return `acf:pull:${executorId}`;
  }

  /**
   * 派发载荷入队（dispatch 占坑成功后的传输分支）。入队失败抛错——调用方
   * （dispatch）按既有失败路径回滚占坑并走重试语义。
   */
  async enqueue(
    executorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const client = this.ensureClient();
    if (!client) throw new Error("Pull queue unavailable (Redis client error)");
    // PK-14: 派发载荷顶层附 schemaVersion（与 webhook 信封同源常量）——执行器
    // 未知字段忽略即可（天然向后兼容）；载荷形状演进时执行器可据此分支解析。
    const body = JSON.stringify({
      ...payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      pushedAt: Date.now(),
    });
    await client.lpush(this.queueKey(executorId), body);
  }

  /**
   * 长轮询取件：在 waitMs 窗口内每 POLL_INTERVAL_MS 取一次队头；取到过期
   * 载荷（pushedAt 早于 TTL 截止）丢弃不投递、继续等下一个。窗口耗尽返回
   * null（端点据此返回空载荷，执行器继续下一轮）。
   */
  async pull(
    executorId: string,
    waitMs: number,
  ): Promise<Record<string, unknown> | null> {
    const client = this.ensureClient();
    if (!client) return null;
    const ttlMs =
      this.configService.get<number>("executor.pullTtlMs") || 900_000;
    const deadline = Date.now() + waitMs;
    const key = this.queueKey(executorId);

    // 至少尝试取件一次，再判窗口耗尽（waitMs=0 = 立即取一次即返回）。
    while (true) {
      const raw = await client.rpop(key);
      if (raw) {
        try {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          const pushedAt = Number(payload.pushedAt ?? 0);
          if (pushedAt && Date.now() - pushedAt > ttlMs) {
            this.logger.warn(
              `Discarded stale pull payload for executor ${executorId} (age=${Date.now() - pushedAt}ms > TTL ${ttlMs}ms)`,
            );
            continue;
          }
          return payload;
        } catch (err) {
          this.logger.warn(
            `Discarded malformed pull payload for executor ${executorId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) =>
        setTimeout(r, ExecutorPullService.POLL_INTERVAL_MS),
      );
    }
    return null;
  }

  /**
   * 清空指定执行器的待拉队列（执行器删除/轮换令牌时卫生清理；best-effort，
   * 队列残留由 TTL 丢弃语义兜底）。
   */
  async clear(executorId: string): Promise<void> {
    const client = this.ensureClient();
    if (!client) return;
    await client.del(this.queueKey(executorId)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }
}
