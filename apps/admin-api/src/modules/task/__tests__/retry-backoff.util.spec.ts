import {
  jitteredRetryDelayMs,
  RETRY_JITTER_RATIO,
} from "../retry-backoff.util";

describe("retry-backoff.util / jitteredRetryDelayMs", () => {
  it("returns 0 for non-positive or missing retryDelay (no-delay semantics preserved)", () => {
    expect(jitteredRetryDelayMs(0, 1)).toBe(0);
    expect(jitteredRetryDelayMs(undefined, 1)).toBe(0);
    expect(jitteredRetryDelayMs(null, 1)).toBe(0);
    expect(jitteredRetryDelayMs(-5, 1)).toBe(0);
    expect(jitteredRetryDelayMs(Number.NaN, 1)).toBe(0);
    expect(jitteredRetryDelayMs(Number.POSITIVE_INFINITY, 1)).toBe(0);
  });

  it("returns base delay when ratio=0 (jitter disabled)", () => {
    expect(jitteredRetryDelayMs(5, 1, Math.random, 0)).toBe(5_000);
    expect(jitteredRetryDelayMs(5, 3, Math.random, 0)).toBe(20_000);
  });

  it("scales exponentially with attempt (ratio=0 sanity matrix)", () => {
    // 10s base: attempt 1/2/3 → 10s/20s/40s
    expect(jitteredRetryDelayMs(10, 1, Math.random, 0)).toBe(10_000);
    expect(jitteredRetryDelayMs(10, 2, Math.random, 0)).toBe(20_000);
    expect(jitteredRetryDelayMs(10, 3, Math.random, 0)).toBe(40_000);
  });

  it("clamps attempt below 1 to 1", () => {
    expect(jitteredRetryDelayMs(5, 0, Math.random, 0)).toBe(5_000);
    expect(jitteredRetryDelayMs(5, -2, Math.random, 0)).toBe(5_000);
    expect(jitteredRetryDelayMs(5, Number.NaN, Math.random, 0)).toBe(5_000);
  });

  it("stays within ±20% band across the random space (boundary sampling)", () => {
    // random=0 → 下界（-20%）；random 趋近 1 → 上界（+20%）
    expect(jitteredRetryDelayMs(10, 1, () => 0)).toBe(8_000);
    expect(jitteredRetryDelayMs(10, 1, () => 0.5)).toBe(10_000);
    expect(jitteredRetryDelayMs(10, 1, () => 0.999999)).toBe(12_000);
    // 指数基座同样受抖动：attempt=3、10s → base 40s，±20% → [32s, 48s]
    expect(jitteredRetryDelayMs(10, 3, () => 0)).toBe(32_000);
    expect(jitteredRetryDelayMs(10, 3, () => 0.999999)).toBe(48_000);
  });

  it("property: 1000 samples all within [base*0.8, base*1.2] and integral", () => {
    const base = 40_000; // 20s * 2^(2-1) = 40s, attempt 2
    for (let i = 0; i < 1000; i++) {
      const ms = jitteredRetryDelayMs(20, 2);
      expect(ms).toBeGreaterThanOrEqual(base * (1 - RETRY_JITTER_RATIO));
      expect(ms).toBeLessThanOrEqual(base * (1 + RETRY_JITTER_RATIO));
      expect(Number.isInteger(ms)).toBe(true);
    }
  });

  it("spreads delays (not all samples identical)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) samples.add(jitteredRetryDelayMs(30, 1));
    // 50 个样本全部碰撞的概率在连续分布下可忽略
    expect(samples.size).toBeGreaterThan(1);
  });

  it("is deterministic under injected random (same seed → same value)", () => {
    const a = jitteredRetryDelayMs(5, 2, () => 0.25);
    const b = jitteredRetryDelayMs(5, 2, () => 0.25);
    expect(a).toBe(b);
  });

  it("computes expected value precisely", () => {
    // base=5000*2^(2-1)=10000；factor=1+(0.25*2-1)*0.2=0.9 → 9000
    expect(jitteredRetryDelayMs(5, 2, () => 0.25)).toBe(9_000);
  });
});
