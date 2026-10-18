import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * PLAN-BACKEND-ARCHITECTURE §4.2 收口：SystemConfig 读缓存的**跨实例失效广播**。
 *
 * ## 要解决的问题
 * PERF-2 给 SystemConfigService.findOne 加了进程内短 TTL 缓存（默认 1000ms）。
 * 全部写面（upsert / batchUpsert / remove / rollback）都只逐出**本实例**的
 * 缓存行；HA（`--scale admin-api=N`）下实例 A 改配置后，实例 B 在 TTL 窗口内
 * 仍可能读到旧值——例如轮换后的 `executor.sharedToken` 在 B 上还有最长 1s 的
 * 旧值窗口（正是 §4.2 指出的要害）。
 *
 * ## 为什么是 pub/sub 驱逐广播而不是把缓存搬进 Redis
 * 与 `executor/token-cache-sync.service.ts` **同一裁决**（该文件头注有完整
 * 论证，此处不另立一套）：缓存的本职是替掉配置读面的重复 SELECT——改成每次
 * 读先查 Redis，等于把全链路热路径（每次派发/回调/令牌校验都要读
 * `executor.sharedToken`）从「纯内存」变成「每请求一次网络往返」，并给热路径
 * 引入 Redis 可用性依赖。广播方案热路径零改动：本地缓存照旧，配置写入这个
 * **低频人工动作**多一次 PUBLISH；其他实例毫秒级收到并逐出。故本服务刻意
 * **不**引入第二种缓存形态（不搬 Redis、不换库、零新依赖）。
 *
 * ## 失效语义（fail-open 三层，逐条对齐 token-cache-sync）
 * 1. 正常：广播毫秒级送达 → 各实例逐出 → 改配置即时全集群可见；
 * 2. 消息丢失（订阅端瞬断）：退化为既有 TTL 兜底（与改造前等价，不劣化）；
 * 3. 连接恢复（ioredis `ready`，含首连与每次重连）：**全量清空**本地缓存——
 *    自愈漏掉的消息；配置表只有个位数行，清空只多几条 SELECT。
 * Redis 整体不可用：PUBLISH 失败被吞（**绝不**改变配置写操作的结果）、订阅端
 * 不建立——语义完全回到改造前的 TTL 兜底。
 *
 * ## 连接形态
 * 订阅态的 ioredis 连接不能再执行普通命令，故订阅与发布各占一条独立连接
 * （均为惰性创建；发布端 enableOfflineQueue=false——排队数分钟后才送达的驱逐
 * 没有意义，宁可如实失败走 TTL 兜底）。参数与 RedisLockService 同源
 * （redis.host / port / password / db）。
 *
 * ## 逃生舱
 * 需要强一致（连 TTL 窗口都不接受）时置 `SYSTEM_CONFIG_CACHE_TTL_MS=0`——缓存
 * 整体关闭，本服务随之成为 no-op，无需改代码（与改造前逐字节一致）。
 */

export const SYSTEM_CONFIG_EVICT_CHANNEL = "config:system-config:evict";

export interface ConfigCacheSyncHandlers {
  /** 远端广播（带 key）：逐出该配置键在本实例的缓存行。 */
  onEvict: (key: string) => void;
  /** 远端广播（不带 key / 载荷畸形）与订阅连接（重）连上：全量清空本地缓存。 */
  onFlush: () => void;
}

@Injectable()
export class ConfigCacheSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(ConfigCacheSyncService.name);
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private handlers: ConfigCacheSyncHandlers | null = null;
  private destroyed = false;

  constructor(private readonly config: ConfigService) {}

  /** 测试缝：注入现成客户端替代真实连接。 */
  protected createPublisherClient(): Redis {
    return new Redis({
      host: this.config.get("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get("redis.password"),
      db: this.config.get<number>("redis.db", 0),
      commandTimeout: 3000,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      // 迟到的驱逐只会多重读一次库（缓存会重建），不值得为它把命令排在断连
      // 队列里数分钟——如实失败走 TTL 兜底。
      enableOfflineQueue: false,
    });
  }

  /** 测试缝：订阅端连接（subscribe 模式下不能再跑普通命令，必须独立连接）。 */
  protected createSubscriberClient(): Redis {
    return new Redis({
      host: this.config.get("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get("redis.password"),
      db: this.config.get<number>("redis.db", 0),
      retryStrategy: (times) => Math.min(times * 100, 3000),
      // ioredis 重连后自动重放 subscribe；`ready` 事件（首连+每次重连）由
      // 下方接线成 flush 信号，自愈断连窗口内错过的消息。
    });
  }

  /**
   * 由 SystemConfigService.onModuleInit 调用。handler 内的异常一律吞掉并记
   * 日志——订阅回调抛错绝不能杀死订阅循环（ioredis message handler 抛错会打到
   * uncaughtException 路径）。
   */
  bindHandlers(handlers: ConfigCacheSyncHandlers): void {
    this.handlers = handlers;
  }

  /** 惰性建立订阅连接并接线。Redis 不可用时不抛——退化为 TTL 兜底。 */
  onModuleInit(): void {
    try {
      this.subscriber = this.createSubscriberClient();
      this.subscriber.on("error", (err: Error) => {
        this.logger.warn(
          `system-config 缓存订阅连接错误（退化 TTL 兜底）: ${err.message}`,
        );
      });
      this.subscriber.on("ready", () => {
        // 首连与每次重连都到这：全量清空，自愈断连窗口内错过的驱逐消息。
        try {
          this.handlers?.onFlush();
        } catch (err) {
          this.logger.warn(
            `system-config 缓存 flush 回调失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      this.subscriber.on("message", (channel: string, payload: string) => {
        if (channel !== SYSTEM_CONFIG_EVICT_CHANNEL) return;
        try {
          const parsed = JSON.parse(payload) as { key?: unknown };
          if (typeof parsed?.key === "string" && parsed.key !== "") {
            this.handlers?.onEvict(parsed.key);
            return;
          }
          // 无 key（写入方要求全清）与「key 存在但非法」都走全清：宁可多读
          // 几次库，也不可在配置这种「读错就按旧值派发」的面向上留陈旧值。
          if (parsed?.key !== undefined && parsed?.key !== null) {
            this.logger.warn(
              `system-config 驱逐消息的 key 非法（${String(parsed.key)}），按全量清空处理`,
            );
          }
          this.handlers?.onFlush();
        } catch (err) {
          // 载荷解析失败同样保守全清——不认识的广播最可能的含义就是「有变化」。
          this.logger.warn(
            `system-config 驱逐消息解析失败（按全量清空处理）: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            this.handlers?.onFlush();
          } catch (flushErr) {
            this.logger.warn(
              `system-config 缓存 flush 回调失败: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`,
            );
          }
        }
      });
      void this.subscriber
        .subscribe(SYSTEM_CONFIG_EVICT_CHANNEL)
        .catch((err: Error) => {
          this.logger.warn(
            `system-config 缓存订阅失败（退化 TTL 兜底）: ${err.message}`,
          );
        });
    } catch (err) {
      this.logger.warn(
        `system-config 缓存订阅端初始化失败（退化 TTL 兜底）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 广播「配置缓存失效」。`key` 缺省 = 全量清空（供 batchUpsert / rollback 这类
   * 一次动多个键、或键未知的写面使用）。
   *
   * fire-and-forget：任何失败都被吞（失败 = 退化为既有 TTL 兜底，**绝不**影响
   * 配置写入本体的结果）。
   */
  async publishInvalidate(key?: string): Promise<void> {
    if (this.destroyed) return;
    try {
      if (!this.publisher) this.publisher = this.createPublisherClient();
      const payload: { key?: string } =
        typeof key === "string" && key !== "" ? { key } : {};
      await this.publisher.publish(
        SYSTEM_CONFIG_EVICT_CHANNEL,
        JSON.stringify(payload),
      );
    } catch (err) {
      this.logger.debug(
        `system-config 缓存失效广播失败（其他实例走 TTL 兜底）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const client of [this.publisher, this.subscriber]) {
      if (client) {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }
    }
    this.publisher = null;
    this.subscriber = null;
  }
}
