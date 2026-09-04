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
   */
  private startWatchdog(
    key: string,
    lockId: string,
    ttlMs: number,
  ): { stop: () => void } {
    let stopped = false;
    const renewMs = Math.max(1000, Math.floor(ttlMs / 3));
    const watchdog = setInterval(() => {
      if (stopped) return;
      this.extendLock(key, lockId, ttlMs).catch((err: unknown) => {
        this.logger.warn(
          `Lock watchdog for ${key} failed to renew: ${err instanceof Error ? err.message : String(err)}`,
        );
        stopped = true;
        clearInterval(watchdog);
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
