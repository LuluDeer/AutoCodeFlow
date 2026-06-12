import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { randomBytes } from "crypto";

@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    this.client = new Redis({
      host: this.configService.get("redis.host"),
      port: this.configService.get<number>("redis.port"),
      password: this.configService.get("redis.password"),
      retryStrategy: (times) => Math.min(times * 100, 3000),
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
      return {
        key,
        lockId,
        ttlMs,
        released: false,
        release: async () => this.releaseLock(key, lockId),
      };
    }

    return null;
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
