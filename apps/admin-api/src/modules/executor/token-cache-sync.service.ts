import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * ARCH-31 §3.7 收口：执行器令牌缓存的**跨实例驱逐广播**。
 *
 * ## 要解决的问题
 * ExecutorService 的三张正缓存（tokenValidationCache / callbackSecretCache /
 * issuedTokenCache）都是进程内的：`rotateToken`/`removeById` 只逐出**本实例**的
 * 条目，其他实例最长 TOKEN_CACHE_TTL_MS（60s）内仍把旧 hash 当 HMAC 候选、旧
 * token 仍命中校验正缓存——「撤销凭据」在多实例下出现 60s 的失效窗口（矩阵
 * 3.7 🟡 的要害）。
 *
 * ## 为什么是 pub/sub 驱逐广播而不是把缓存搬进 Redis
 * 缓存的本职是替掉 bcrypt（~100-300ms CPU）——若改成每次校验先查 Redis，等于
 * 把高频热路径（callback/heartbeat）从「纯内存」变成「每请求一次网络往返」，
 * 并给热路径引入 Redis 可用性依赖。广播方案热路径零改动：本地缓存照旧，
 * 轮换/删除的**低频管理动作**多一次 PUBLISH；其他实例毫秒级收到并逐出。
 *
 * ## 失效语义（fail-open 三层）
 * 1. 正常：广播毫秒级送达 → 各实例逐出 → 撤销即时生效；
 * 2. 消息丢失（订阅端瞬断）：退化为既有 60s TTL 兜底（与改造前等价，不劣化）；
 * 3. 连接恢复（ioredis `ready`，含首连与每次重连）：**全量清空**本地三缓存——
 *    自愈漏掉的消息；正缓存只存成功结果，清空只多一轮 bcrypt + DB 读。
 * Redis 整体不可用：PUBLISH 失败被吞（不改写轮换结果）、订阅端不建立——
 * 语义完全回到改造前的 60s TTL。
 *
 * ## 连接形态
 * 订阅态的 ioredis 连接不能再执行普通命令，故订阅与发布各占一条独立连接
 * （均为惰性创建；发布端 enableOfflineQueue=false——排队数分钟后才送达的
 * 驱逐没有意义，宁可如实失败走 TTL 兜底）。参数与 RedisLockService 同源。
 */

export const EXECUTOR_TOKEN_EVICT_CHANNEL = "executor:token-cache:evict";

export interface TokenCacheSyncHandlers {
  /** 远端广播到达：逐出该地址在本实例的三张缓存。 */
  onEvict: (address: string) => void;
  /** 订阅连接（重）连上：全量清空本地缓存，自愈错过的消息。 */
  onFlush: () => void;
}

@Injectable()
export class ExecutorTokenCacheSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutorTokenCacheSyncService.name);
  private subscriber: Redis | null = null;
  private publisher: Redis | null = null;
  private handlers: TokenCacheSyncHandlers | null = null;
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
      // 迟到的驱逐只会多余地多一轮 bcrypt/DB 读（正缓存会重建），不值得为
      // 它把命令排在断连队列里数分钟——如实失败走 TTL 兜底。
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
   * 由 ExecutorService.onModuleInit 调用。handler 内的异常一律吞掉并记日志
   * ——订阅回调抛错绝不能杀死订阅循环（ioredis message handler 抛错会打到
   * uncaughtException 路径）。
   */
  bindHandlers(handlers: TokenCacheSyncHandlers): void {
    this.handlers = handlers;
  }

  /** 惰性建立订阅连接并接线。Redis 不可用时不抛——退化为 TTL 兜底。 */
  onModuleInit(): void {
    try {
      this.subscriber = this.createSubscriberClient();
      this.subscriber.on("error", (err: Error) => {
        this.logger.warn(
          `token-cache 订阅连接错误（退化 TTL 兜底）: ${err.message}`,
        );
      });
      this.subscriber.on("ready", () => {
        // 首连与每次重连都到这：全量清空，自愈断连窗口内错过的驱逐消息。
        try {
          this.handlers?.onFlush();
        } catch (err) {
          this.logger.warn(
            `token-cache flush 回调失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      this.subscriber.on("message", (channel: string, payload: string) => {
        if (channel !== EXECUTOR_TOKEN_EVICT_CHANNEL) return;
        try {
          const parsed = JSON.parse(payload) as { address?: unknown };
          if (typeof parsed?.address !== "string" || parsed.address === "")
            return;
          this.handlers?.onEvict(parsed.address);
        } catch (err) {
          this.logger.warn(
            `token-cache 驱逐消息解析失败（忽略）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      void this.subscriber
        .subscribe(EXECUTOR_TOKEN_EVICT_CHANNEL)
        .catch((err: Error) => {
          this.logger.warn(
            `token-cache 订阅失败（退化 TTL 兜底）: ${err.message}`,
          );
        });
    } catch (err) {
      this.logger.warn(
        `token-cache 订阅端初始化失败（退化 TTL 兜底）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 广播「该地址的令牌派生缓存全部失效」。fire-and-forget：任何失败都被吞
   * （失败 = 退化为既有 60s TTL，绝不影响轮换/删除本体的结果）。
   */
  async publishTokenEviction(address: string): Promise<void> {
    if (this.destroyed || !address) return;
    try {
      if (!this.publisher) this.publisher = this.createPublisherClient();
      await this.publisher.publish(
        EXECUTOR_TOKEN_EVICT_CHANNEL,
        JSON.stringify({ address }),
      );
    } catch (err) {
      this.logger.debug(
        `token-cache 驱逐广播失败（其他实例走 TTL 兜底）: ${err instanceof Error ? err.message : String(err)}`,
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
