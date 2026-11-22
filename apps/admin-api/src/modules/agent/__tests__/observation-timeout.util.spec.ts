/**
 * R213 · **观测调用超时**（`observation-timeout.util`）。
 *
 * 判据（完整推导见 `docs/observability/observation-timeout-criterion.md`）：
 * > **观测调用必须在上界内返回**；超时必须被当作「读失败」处理，
 * > **而不是**继续等待（Redis 卡住时那样会让端点**挂死**，R212 真机实测）。
 *
 * ## 本文件钉什么
 *
 * ① 正常（远快于上界）⇒ **不改变结果**（正例控制组，防「加了超时就把快的也弄坏」）；
 * ② 超时 ⇒ 抛 `ObservationTimeoutError`，且带 label（诊断要知道是**哪个**观测）；
 * ③ **上界 ≤ 0 ⇒ 不设超时**（配错时「不保护」而不是「全部立刻失败」——后者会让整个观测面永久降级）；
 * ④ **超时后底层 promise 的迟到 reject 不得变成 unhandledRejection**
 *    （否则一条**已处理**的超时会变成进程告警噪声）；
 * ⑤ `ObservationBudget`：总预算耗尽 ⇒ `expired()`，且 `sliceMs()` 不超过剩余预算
 *    （串行循环的后段不能各给满额，否则整次请求仍会超出总预算）。
 */
import {
  DEFAULT_OBSERVATION_TIMEOUT_MS,
  ObservationBudget,
  ObservationTimeoutError,
  withObservationTimeout,
} from "../runtime/observation-timeout.util";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("R213 · 观测调用超时", () => {
  it("① 远快于上界 ⇒ **不改变结果**（正例控制组）", async () => {
    const v = await withObservationTimeout("fast", async () => 42, 5_000);
    expect(v).toBe(42);
  });

  it("② 超时 ⇒ 抛 `ObservationTimeoutError` 且带 label（诊断要知道是哪个观测）", async () => {
    await expect(
      withObservationTimeout(
        "queue-stall.workers",
        async () => {
          await sleep(200);
          return 1;
        },
        20,
      ),
    ).rejects.toBeInstanceOf(ObservationTimeoutError);

    // 单独校验字段（`toBeInstanceOf` 只看类型）
    let caught: unknown;
    try {
      await withObservationTimeout("queue-idle.#3", () => sleep(200), 20);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ObservationTimeoutError);
    expect((caught as ObservationTimeoutError).label).toBe("queue-idle.#3");
    expect((caught as ObservationTimeoutError).timeoutMs).toBe(20);
  });

  it("③ 上界 ≤ 0 / 非法 ⇒ **不设超时**（配错时「不保护」，不是「全部立刻失败」）", async () => {
    // 关键取舍：若这里抛错，`AGENT_OBSERVATION_TIMEOUT_MS=0` 会让**整个观测面永久降级**
    // —— 那是「配错一个字 = 全场红」，比不保护更糟。
    await expect(
      withObservationTimeout("zero", async () => "ok", 0),
    ).resolves.toBe("ok");
    await expect(
      withObservationTimeout("neg", async () => "ok", -1),
    ).resolves.toBe("ok");
    await expect(
      withObservationTimeout("nan", async () => "ok", Number.NaN),
    ).resolves.toBe("ok");
  });

  it("④ 超时后底层的**迟到 reject** 不得变成 unhandledRejection", async () => {
    // 这是真实风险：`Promise.race` 不取消底层 promise。若底层在上限之后才 reject，
    // 且没人接住，Node 会打印 unhandledRejection ⇒ 一条**已处理**的超时变成告警噪声。
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        withObservationTimeout(
          "late-reject",
          async () => {
            await sleep(80);
            throw new Error("late boom");
          },
          10,
        ),
      ).rejects.toBeInstanceOf(ObservationTimeoutError);
      // 给迟到的 reject 足够时间冒出来
      await sleep(150);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("⑤ 默认上界 = 5000ms（connectTimeout 的一半，推导见常量注释）", () => {
    expect(DEFAULT_OBSERVATION_TIMEOUT_MS).toBe(5_000);
  });
});

describe("R213 · ObservationBudget（串行探测的总预算）", () => {
  it("① 未耗尽 ⇒ `expired()` 为 false，`sliceMs()` = 单调用上界", () => {
    const b = new ObservationBudget(8_000, 1_000);
    expect(b.expired(1_000)).toBe(false);
    expect(b.sliceMs(5_000, 1_000)).toBe(5_000);
    expect(b.remainingMs(1_000)).toBe(8_000);
  });

  it("② 耗尽 ⇒ `expired()` 为 true", () => {
    const b = new ObservationBudget(8_000, 1_000);
    expect(b.expired(9_000)).toBe(true);
    expect(b.remainingMs(9_000)).toBe(0);
  });

  it("③ **后段 `sliceMs()` 不得超过剩余预算**（否则整次请求仍会超总预算）", () => {
    // 这是本条最容易写错的格子：串行循环第 199 次时，剩余可能只剩 300ms；
    // 若仍给满 5000ms，整次请求就会超出总预算 —— 那正是本条要治的病。
    const b = new ObservationBudget(8_000, 1_000);
    expect(b.sliceMs(5_000, 8_800)).toBe(200);
    // 已耗尽 ⇒ 0（调用方应据此**不再发请求**）
    expect(b.sliceMs(5_000, 9_500)).toBe(0);
  });

  it("④ 预算 ≤ 0 / 非法 ⇒ **不做预算限制**（同 `withObservationTimeout` 的取舍）", () => {
    const b = new ObservationBudget(0, 1_000);
    expect(b.expired(Date.now() + 10 ** 9)).toBe(false);
    expect(b.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(b.sliceMs(5_000)).toBe(5_000);
  });
});
