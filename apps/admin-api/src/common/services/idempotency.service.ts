import { Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";

import { RedisLockService } from "./redis-lock.service";

/**
 * G10（OSS 对照审计）：触发面幂等键。
 *
 * 语义（对齐 trigger.dev / Stripe 的 Idempotency-Key）：
 *   · 作用域 = 一个路由 + 一个业务对象（这里是 `task:<taskId>`）；
 *   · 同一 (scope, key) 在 TTL 内只允许一次「新触发」；
 *   · 同键同参重放 → `replay`（调用方映射 409，提示用新键）；
 *   · 同键**不同参** → `payload_mismatch`（409；绝不静默返回旧结果，那会让
 *     客户端以为新参数生效了）。
 *
 * 为什么用 Redis 而不是 DB 列：幂等键是**短生命周期**（24h）的去重信号，不是
 * 业务事实；放 DB 要迁移 + partial unique 索引 + retention，而 Redis 已是强依赖
 * （锁/节流/outbox 唤醒）。代价是 Redis 故障期间失去幂等——此时返回
 * `unavailable`，调用方选择 **fail-open**（警告后照常触发）：去重是加固，不是
 * 可用性前提。
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type IdempotencyClaimResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: "replay" | "payload_mismatch" | "unavailable" };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Optional()
    private readonly redis?: RedisLockService | null,
  ) {}

  /** 键形状校验（非法键由调用方映射 400，不静默忽略——那等于没有幂等）。 */
  static isValidKey(key: string): boolean {
    return KEY_RE.test(key);
  }

  /** 载荷指纹（同键不同参要能区分；JSON 键序由调用方保证稳定）。 */
  static payloadHash(payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(payload ?? null))
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * 抢占幂等键。
   *
   * 成功时返回 `release()`：**触发失败**必须调用它——否则一次失败的重试会被
   * 当成 replay，把「可重试的故障」变成「客户端被永久告知重复」，正好与幂等
   * 的目的相反。
   */
  async claim(
    scope: string,
    key: string,
    payloadHash: string,
    ttlMs: number = IDEMPOTENCY_TTL_MS,
  ): Promise<IdempotencyClaimResult> {
    if (!this.redis) return { ok: false, reason: "unavailable" };
    const redisKey = `idem:${scope}:${createHash("sha256")
      .update(key)
      .digest("hex")}`;
    try {
      const first = await this.redis.setIfAbsent(redisKey, ttlMs, payloadHash);
      if (!first) {
        const existing = await this.redis.getValue(redisKey);
        return {
          ok: false,
          reason:
            existing !== null && existing !== payloadHash
              ? "payload_mismatch"
              : "replay",
        };
      }
      return {
        ok: true,
        release: async () => {
          try {
            await this.redis?.deleteKey(redisKey);
          } catch (err: unknown) {
            this.logger.warn(
              `Idempotency key release failed (key expires by TTL anyway): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Idempotency claim unavailable (proceeding without dedupe): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, reason: "unavailable" };
    }
  }
}
