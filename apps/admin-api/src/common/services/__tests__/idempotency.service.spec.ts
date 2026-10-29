import { IdempotencyService } from "../idempotency.service";
import type { RedisLockService } from "../redis-lock.service";

/**
 * G10：触发面幂等键（Redis SETNX + 载荷指纹）。
 *
 * 语义要点：同键同参 → replay；同键**不同参** → payload_mismatch（绝不静默
 * 返回旧结果）；Redis 不可用 → unavailable（调用方 fail-open）；触发失败必须
 * 能 release（否则一次失败的重试会被当成 replay）。
 */
function fakeRedis(
  opts: {
    first?: boolean;
    existing?: string | null;
    fail?: boolean;
  } = {},
) {
  return {
    setIfAbsent: jest.fn(async (_k: string, _ttl: number, _v?: string) => {
      if (opts.fail) throw new Error("redis down");
      return opts.first !== false;
    }),
    getValue: jest.fn(async () => opts.existing ?? null),
    deleteKey: jest.fn(async () => undefined),
  } as unknown as RedisLockService & Record<string, jest.Mock>;
}

describe("IdempotencyService（G10）", () => {
  it("首次抢占成功；release 删除键（失败重试不被误判 replay）", async () => {
    const redis = fakeRedis({ first: true });
    const svc = new IdempotencyService(redis);
    const hash = IdempotencyService.payloadHash({ params: { a: 1 } });

    const res = await svc.claim("task:t1", "key-12345678", hash);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    await res.release();
    expect(redis.deleteKey).toHaveBeenCalledTimes(1);
  });

  it("同键同参 → replay", async () => {
    const hash = IdempotencyService.payloadHash({ params: { a: 1 } });
    const redis = fakeRedis({ first: false, existing: hash });
    const svc = new IdempotencyService(redis);
    await expect(svc.claim("task:t1", "key-12345678", hash)).resolves.toEqual({
      ok: false,
      reason: "replay",
    });
  });

  it("同键不同参 → payload_mismatch（不静默返回旧结果）", async () => {
    const redis = fakeRedis({ first: false, existing: "different-hash" });
    const svc = new IdempotencyService(redis);
    await expect(
      svc.claim("task:t1", "key-12345678", "new-hash"),
    ).resolves.toEqual({ ok: false, reason: "payload_mismatch" });
  });

  it("Redis 缺失/异常 → unavailable（调用方 fail-open）", async () => {
    await expect(
      new IdempotencyService(null).claim("task:t1", "key-12345678", "h"),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(
      new IdempotencyService(fakeRedis({ fail: true })).claim(
        "task:t1",
        "key-12345678",
        "h",
      ),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("键形状校验：8-128 字符、字母数字/._:-", () => {
    expect(IdempotencyService.isValidKey("abcd1234")).toBe(true);
    expect(IdempotencyService.isValidKey("a".repeat(128))).toBe(true);
    expect(IdempotencyService.isValidKey("short")).toBe(false);
    expect(IdempotencyService.isValidKey("a".repeat(129))).toBe(false);
    expect(IdempotencyService.isValidKey("has space")).toBe(false);
    expect(IdempotencyService.isValidKey("中文键名")).toBe(false);
  });
});
