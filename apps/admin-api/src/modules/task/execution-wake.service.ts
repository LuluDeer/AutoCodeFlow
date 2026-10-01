import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * FIX-4.2: 执行终态唤醒（Redis pub/sub）——webhook ?wait=1 同步等待的事件化。
 *
 * 背景：waitForTerminal 此前以固定 500ms DB 轮询等终态，单个挂起请求在 300s
 * 上限内最多打 ~600 次点查；自动化平台批量并发 wait 时 DB 压力随并发线性增长。
 * 本服务提供跨实例的「终态唤醒」通道：
 *  - 发布侧：task.service（回调 winner / kill）与 task.processor（派发失败
 *    终态）在终态**落库后** PUBLISH `acf:execution-wake <executionId>`
 *    （best-effort，任何失败都不影响主链——轮询兜底仍在）；
 *  - 订阅侧：webhook 等待方 waitWakeup(executionId, timeoutMs) 挂起等待唤醒，
 *    收到信号立即复查 DB（发布点在提交之后，唤醒即意味着终态已可见）；
 *    超时返回 false，调用方按 1s→5s 退避继续轮询兜底（覆盖 CANCELLED 等
 *    无事件终态、跨实例 pub/sub 抖动与旧发布点遗漏）。
 *
 * 连接纪律（对齐 redis-lock.service）：ioredis 的 SUBSCRIBE 是连接级独占模式，
 * 订阅端使用**独立连接**（懒建，首个等待方到来才创建）；发布端复用普通连接。
 * Redis 不可用时 waitWakeup 立即返回 false（等价纯轮询），publish 静默吞掉
 * ——本服务整体是旁路增强，绝不产生新的失败面。
 */
export const EXECUTION_WAKE_CHANNEL = "acf:execution-wake";

@Injectable()
export class ExecutionWakeService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionWakeService.name);
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private subscribed = false;
  /** executionId → 等待中的唤醒回调集合（waitWakeup 注册 / 消息到达或超时移除）。 */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly configService: ConfigService) {}

  private createClient(): Redis {
    return new Redis({
      host: this.configService.get("redis.host"),
      port: this.configService.get<number>("redis.port"),
      password: this.configService.get("redis.password"),
      db: this.configService.get<number>("redis.db", 0),
      commandTimeout: 3000,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      // 订阅连接在 ready 前注册的 waiter 依赖 message 事件；连接层错误
      // 交给 retryStrategy 重连，等待方由自身超时兜底，不打日志刷屏。
      lazyConnect: false,
    });
  }

  private ensurePublisher(): Redis | null {
    if (!this.publisher || this.publisher.status === "end") {
      try {
        this.publisher = this.createClient();
        this.publisher.on("error", () => undefined);
      } catch (err: unknown) {
        this.logger.warn(
          `ExecutionWake publisher unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
    return this.publisher;
  }

  private ensureSubscriber(): Redis | null {
    if (!this.subscriber || this.subscriber.status === "end") {
      try {
        this.subscriber = this.createClient();
        this.subscriber.on("error", () => undefined);
        this.subscriber.on("message", (channel, message) => {
          if (channel !== EXECUTION_WAKE_CHANNEL || !message) return;
          const set = this.waiters.get(message);
          if (!set || set.size === 0) return;
          // 唤醒是单次信号：先摘除再触发，避免回调内重复注册竞态。
          this.waiters.delete(message);
          for (const wake of [...set]) {
            try {
              wake();
            } catch {
              /* waiter 回调只做 resolve，不应抛错 */
            }
          }
        });
        this.subscribed = false;
      } catch (err: unknown) {
        this.logger.warn(
          `ExecutionWake subscriber unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
    if (!this.subscribed) {
      // 懒订阅：首个等待方到来才进入 SUBSCRIBE 模式（多数部署不用 wait）。
      void this.subscriber
        .subscribe(EXECUTION_WAKE_CHANNEL)
        .then(() => {
          this.subscribed = true;
        })
        .catch(() => undefined);
      // subscribed 置位提前到发起时——重连竞态下宁可多发一次 SUBSCRIBE
      //（幂等）也不要漏发导致等待方永远收不到信号。
      this.subscribed = true;
    }
    return this.subscriber;
  }

  /** 发布执行终态唤醒（best-effort：任何失败静默吞掉，绝不影响主链）。 */
  publishTerminal(executionId: string): void {
    try {
      const client = this.ensurePublisher();
      if (!client) return;
      const result = client.publish(EXECUTION_WAKE_CHANNEL, executionId);
      if (result && typeof result.catch === "function") {
        result.catch(() => undefined);
      }
    } catch {
      /* best-effort：唤醒失败由轮询兜底 */
    }
  }

  /**
   * 等待该执行的终态唤醒信号，至多 timeoutMs。返回 true=已唤醒（调用方应
   * 立即复查 DB）；false=超时（调用方按退避节奏轮询兜底）。Redis 不可用时
   * 直接按 false 处理——等待退化为纯轮询，行为与引入本服务前等价。
   */
  async waitWakeup(executionId: string, timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
    const sub = this.ensureSubscriber();
    if (!sub) return false;
    return new Promise<boolean>((resolve) => {
      const set = this.waiters.get(executionId) ?? new Set<() => void>();
      set.add(waiter);
      this.waiters.set(executionId, set);
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      // 定时器不阻塞进程退出（测试环境尤其敏感）。
      timer.unref?.();
      function waiter() {
        cleanup();
        resolve(true);
      }
      function cleanup() {
        clearTimeout(timer);
        set.delete(waiter);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    // 唤醒所有悬挂等待方（让其走最后一轮 DB 复查后自然结束）。
    for (const [, set] of this.waiters) {
      for (const wake of [...set]) {
        try {
          wake();
        } catch {
          /* ignore */
        }
      }
    }
    this.waiters.clear();
    if (this.publisher) {
      await this.publisher.quit().catch(() => undefined);
      this.publisher = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }
}
