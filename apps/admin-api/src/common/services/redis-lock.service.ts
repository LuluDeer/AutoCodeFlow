import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { randomBytes } from "crypto";

@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private client: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
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

  async onModuleDestroy() {
    await this.client.quit();
  }

  async acquireLock(key: string, ttlMs: number): Promise<Lock | null> {
    const lockId = randomBytes(16).toString("hex");
    const result = await (this.client as any).set(
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

      const lock: Lock = {
        key,
        lockId,
        ttlMs,
        released: false,
        release: async () => {
          if (lock.released) return false;
          stopped = true;
          clearInterval(watchdog);
          const ok = await this.releaseLock(key, lockId);
          if (ok) lock.released = true;
          return ok;
        },
      };
      return lock;
    }

    return null;
  }

  async extendLock(
    key: string,
    lockId: string,
    ttlMs: number,
  ): Promise<boolean> {
    // Only renew if the lock still belongs to us — protects against a slow
    // watchdog that fires after the lock already expired and was re-acquired
    // by another instance.
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.client.eval(
      script,
      1,
      `lock:${key}`,
      lockId,
      ttlMs,
    );
    return result === 1;
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.client.eval(script, 1, `lock:${key}`, lockId);
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

export interface Lock {
  key: string;
  lockId: string;
  ttlMs: number;
  released: boolean;
  release: () => Promise<boolean>;
}
