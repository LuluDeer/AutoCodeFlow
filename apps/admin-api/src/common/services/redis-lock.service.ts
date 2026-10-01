import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { randomBytes } from "crypto";

/**
 * N3: acquireLock 在 client 未 ready 时的有界等待窗口（毫秒）。
 * 启动竞态（SchedulerService.onModuleInit 先于 RedisLockService.onModuleInit
 * 执行）曾让首次 acquireLock 直接抛错并触发 ~15s 的 fail-open 假 Leader 窗口；
 * 现在首次调用会创建 client 并等待其 ready（Redis 可达时为毫秒级），超时仍
 * 抛错以保留"Redis 真不可用时 fail-open"语义。
 */
export const REDIS_READY_WAIT_MS = 3_000;

/**
 * 第四轮审计（A9）: watchdog 连续续期失败容忍上限。毫秒级 Redis 抖动（单次
 * commandTimeout/瞬断）不应立即放弃租约续期；连续 3 次（≥2 个完整续期周期）
 * 才判定为真不可用并停表。导出常量便于调用方与测试对齐语义。
 */
export const REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private client: Redis | null = null;

  constructor(private configService: ConfigService) {}

  /**
   * N3: create the client lazily but idempotently. Provider instantiation /
   * lifecycle order is not guaranteed relative to consumers — the scheduler's
   * onModuleInit used to run before this service's, so its first acquireLock
   * hit an undefined client and degraded to a fail-open "fake leader" for a
   * full retry cycle. Callers must never depend on onModuleInit having run.
   */
  private ensureClient(): Redis {
    if (!this.client) {
      this.client = new Redis({
        host: this.configService.get("redis.host"),
        port: this.configService.get<number>("redis.port"),
        password: this.configService.get("redis.password"),
        db: this.configService.get<number>("redis.db", 0),
        // P2: bound every Redis call to fail fast instead of hanging on a
        // partitioned network. Without this, the lock watchdog can wedge.
        commandTimeout: 3000,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });
      this.client.on("error", (err: Error) => {
        // Prevent unhandled rejection — ioredis auto-reconnects on connection errors
        this.logger.error(`Redis connection error: ${err.message}`);
      });
    }
    return this.client;
  }

  async onModuleInit() {
    // Establish the connection eagerly in the normal lifecycle; acquireLock
    // would otherwise create it lazily on first use (N3 ordering fix).
    this.ensureClient();
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  /**
   * N3: wait (bounded) until the client reports ready before issuing any
   * command. ioredis would otherwise buffer commands in its offline queue and
   * resolve them long after the caller has given up — for the scheduler's
   * never-released dedup locks, a late SET NX would silently suppress the
   * NEXT trigger. If Redis is truly unavailable the wait times out and
   * throws, preserving the callers' fail-open / DB-claim fallback semantics.
   */
  private async readyClient(
    timeoutMs: number = REDIS_READY_WAIT_MS,
  ): Promise<Redis> {
    const client = this.ensureClient();
    if (client.status === "ready") return client;
    if (client.status === "end") {
      // Client was quit (shutdown) — it will never become ready.
      throw new Error("Redis client has been closed (status=end)");
    }
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(
          new Error(
            `Redis connection failed while waiting for ready: ${err.message}`,
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Redis client not ready after ${timeoutMs}ms (status=${client.status})`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        client.off("ready", onReady);
        client.off("error", onError);
      };
      client.once("ready", onReady);
      client.once("error", onError);
    });
    return client;
  }

  async acquireLock(
    key: string,
    ttlMs: number,
    opts: AcquireLockOptions = {},
  ): Promise<Lock | null> {
    // R4-P0: the High-5.1 watchdog is correct for lease-style locks (leader
    // election, dispatch windows) but fatal for "TTL IS the dedup window"
    // locks such as task:trigger:* — those are deliberately never released,
    // so an auto-renewing watchdog would keep them alive forever and mute
    // every subsequent scheduled trigger. Default stays true so existing
    // lease callers keep their behaviour.
    const client = await this.readyClient();
    const renew = opts.renew !== false;
    const lockId = randomBytes(16).toString("hex");
    const result = await (client as any).set(
      `lock:${key}`,
      lockId,
      "NX",
      "PX",
      ttlMs,
    );

    if (result === "OK") {
      // High-5.1: spin up a watchdog that renews the lock at ttlMs/3 so long
      // business work (dispatch, callback ingest) does not lose the lock when
      // its TTL elapses. The watchdog is the only path that knows the lockId,
      // so a foreign release race is impossible.
      const watchdog = renew ? this.startWatchdog(key, lockId, ttlMs) : null;

      const lock: Lock = {
        key,
        lockId,
        ttlMs,
        released: false,
        release: async () => {
          if (lock.released) return false;
          watchdog?.stop();
          const ok = await this.releaseLock(key, lockId);
          if (ok) lock.released = true;
          return ok;
        },
      };
      return lock;
    }

    return null;
  }

  /**
   * High-5.1 watchdog: renew the lock every ttlMs/3 (min 1s) until stopped
   * or renewal fails. Returns a handle so non-renewing locks (or release())
   * can stop it.
   *
   * 第四轮审计（A9）: 抖动容忍——旧实现单次续期失败（一次 Redis 命令超时/
   * 瞬断）就永久停表，长业务工作（dispatch、callback ingest）随之裸奔到
   * TTL 到期。现连续 WATCHDOG_MAX_RENEW_FAILURES 次失败才停止：单次失败仅
   * warn 并在下个周期重试（commandTimeout=3s < renewMs 下限 1s 未必成立，
   * 但 ttl/3 的余量 + 指数退避的 ioredis 重连足以覆盖毫秒级抖动）；连续
   * 多次失败说明 Redis 真不可用或锁已被他人接管，停止续期并保留 error 级
   * 日志（租约自然到期，持有方按锁丢失语义处理）。
   */
  private startWatchdog(
    key: string,
    lockId: string,
    ttlMs: number,
  ): { stop: () => void } {
    let stopped = false;
    let consecutiveFailures = 0;
    const renewMs = Math.max(1000, Math.floor(ttlMs / 3));
    const watchdog = setInterval(() => {
      if (stopped) return;
      this.extendLock(key, lockId, ttlMs)
        .then((renewed: boolean) => {
          if (renewed) {
            // 单次成功即复位计数——偶发失败后的正常续期不应累积成停止理由。
            consecutiveFailures = 0;
            return;
          }
          // false = 锁已不属于本持有方（过期被抢/已被释放）：续期再多次
          // 也无意义，视为终态失败计数（与异常同池，连续达阈值即停表）。
          consecutiveFailures += 1;
          this.logger.warn(
            `Lock watchdog for ${key} lost ownership during renewal (${consecutiveFailures}/${REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES})`,
          );
          if (
            consecutiveFailures >= REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES
          ) {
            stopped = true;
            clearInterval(watchdog);
          }
        })
        .catch((err: unknown) => {
          consecutiveFailures += 1;
          this.logger.warn(
            `Lock watchdog for ${key} failed to renew (${consecutiveFailures}/${REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES}): ${err instanceof Error ? err.message : String(err)}`,
          );
          if (
            consecutiveFailures >= REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES
          ) {
            stopped = true;
            clearInterval(watchdog);
            this.logger.error(
              `Lock watchdog for ${key} stopped after ${REDIS_LOCK_WATCHDOG_MAX_CONSECUTIVE_FAILURES} consecutive renewal failures — lease will expire naturally`,
            );
          }
        });
    }, renewMs);
    // Unref so a stuck watchdog does not block process exit.
    watchdog.unref();
    return {
      stop: () => {
        stopped = true;
        clearInterval(watchdog);
      },
    };
  }

  async extendLock(
    key: string,
    lockId: string,
    ttlMs: number,
  ): Promise<boolean> {
    // Only renew if the lock still belongs to us — protects against a slow
    // watchdog that fires after the lock already expired and was re-acquired
    // by another instance.
    const client = await this.readyClient();
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await client.eval(script, 1, `lock:${key}`, lockId, ttlMs);
    return result === 1;
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    const client = await this.readyClient();
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const result = await client.eval(script, 1, `lock:${key}`, lockId);
    return result === 1;
  }

  async tryLock(
    key: string,
    ttlMs: number,
    maxRetries: number = 3,
    retryDelayMs: number = 100,
  ): Promise<Lock | null> {
    for (let i = 0; i < maxRetries; i++) {
      const lock = await this.acquireLock(key, ttlMs);
      if (lock) {
        return lock;
      }
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return null;
  }
}

export interface AcquireLockOptions {
  /**
   * High-5.1 watchdog renewal (default true): renews the lock every ttl/3
   * until release(). Set to false for locks whose TTL itself is the semantic
   * window (e.g. the scheduler's task:trigger dedup lock, which is never
   * released) — renewing those would make them immortal and permanently
   * suppress every later trigger.
   */
  renew?: boolean;
}

export interface Lock {
  key: string;
  lockId: string;
  ttlMs: number;
  released: boolean;
  release: () => Promise<boolean>;
}
