/**
 * `agent-llm-retry`（推理质量轮）：分类重试 + 指数退避 + 墙钟截止。
 *
 * 为什么值得单独测：这段代码**只在故障时才走到**。真故障里它决定了三件事：
 *   ① 重试什么（对 401/400 重试 = 把失败推迟 250ms 并把账单翻一倍，
 *      还让「配置错了」看起来像「偶发抖动」）；
 *   ② 退避多久（常数退避会让 2 个 worker 在同一毫秒一起重试，把一次抖动
 *      放大成一次小风暴）；
 *   ③ 什么时候放弃（墙钟预算已到期还睡 8s，睡醒注定被下一轮闸门判死）。
 *
 * 三条都做成可注入时钟/随机源/sleep 的纯函数，所以这里能钉住**每一次**重试的
 * 间隔与判据，而不是「大概重试了」。
 */
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffDelay,
  isRetryableLlmError,
  normalizeRetryPolicy,
  withLlmRetry,
  type RetryEvent,
  type RetryGiveUp,
} from "./agent-llm-retry";

/** 构造带 http 状态码的错误（axios 形态：err.response.status）。 */
const httpError = (status: number): Error => {
  const err = new Error(`HTTP ${status}`) as Error & {
    response?: { status: number };
  };
  err.response = { status };
  return err;
};

const codeError = (code: string): Error => {
  const err = new Error(`socket ${code}`) as Error & { code?: string };
  err.code = code;
  return err;
};

describe("isRetryableLlmError —— 分类", () => {
  it("5xx / 429 / 408 可重试（provider 抖动、限流、超时）", () => {
    for (const status of [429, 408, 500, 502, 503, 504]) {
      expect(isRetryableLlmError(httpError(status))).toBe(true);
    }
  });

  it("4xx 不重试（同一请求重发必然同样失败）", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableLlmError(httpError(status))).toBe(false);
    }
  });

  it("主动中止不重试（AbortError / CanceledError 是调用方收手的信号）", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const canceled = new Error("canceled");
    canceled.name = "CanceledError";
    expect(isRetryableLlmError(abort)).toBe(false);
    expect(isRetryableLlmError(canceled)).toBe(false);
  });

  it("网络类错误码可重试（ECONNRESET 等），未知 code 交给文案判定", () => {
    expect(isRetryableLlmError(codeError("ECONNRESET"))).toBe(true);
    expect(isRetryableLlmError(codeError("ETIMEDOUT"))).toBe(true);
    // 未知 code + 无网络语义文案 → 不猜
    expect(isRetryableLlmError(codeError("ERR_BAD_OPTION"))).toBe(false);
  });

  it("无状态码时按文案判定（socket hang up / timeout）", () => {
    expect(isRetryableLlmError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableLlmError(new Error("connect ETIMEDOUT 10.0.0.1"))).toBe(
      true,
    );
    expect(isRetryableLlmError(new Error("模型返回内容格式非法"))).toBe(false);
  });

  it("null / undefined / 空串 → 不可重试（没有可判读的信息，不猜）", () => {
    expect(isRetryableLlmError(null)).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
    expect(isRetryableLlmError("")).toBe(false);
  });
});

describe("normalizeRetryPolicy —— 脏值回落默认", () => {
  it("全空 → 默认策略", () => {
    expect(normalizeRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    expect(normalizeRetryPolicy(null)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("非正/非数值 → 回落；maxAttempts 至少 1；factor 至少 1；jitter 至少 0", () => {
    const p = normalizeRetryPolicy({
      maxAttempts: 0,
      initialDelayMs: -5,
      backoffFactor: 0.5,
      maxDelayMs: Number.NaN,
      jitterRatio: -1,
    });
    // maxAttempts=0 无意义（不是「不重试」，那是 1）→ 回落默认；下限 1 只兜负数
    expect(p.maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(p.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    expect(p.backoffFactor).toBe(DEFAULT_RETRY_POLICY.backoffFactor);
    expect(p.maxDelayMs).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
    expect(p.jitterRatio).toBe(DEFAULT_RETRY_POLICY.jitterRatio);
  });

  it("合法值原样保留（含 maxAttempts 小数向下取整）", () => {
    const p = normalizeRetryPolicy({
      maxAttempts: 4.9,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 900,
      jitterRatio: 0.1,
    });
    expect(p).toEqual({
      maxAttempts: 4,
      initialDelayMs: 100,
      backoffFactor: 2,
      maxDelayMs: 900,
      jitterRatio: 0.1,
    });
  });
});

describe("computeBackoffDelay —— 指数 + 上限 + 对称抖动", () => {
  const policy = {
    maxAttempts: 5,
    initialDelayMs: 200,
    backoffFactor: 2,
    maxDelayMs: 1_000,
    jitterRatio: 0,
  };

  it("按 factor^n 增长并在上限截断", () => {
    expect(computeBackoffDelay(0, policy)).toBe(200);
    expect(computeBackoffDelay(1, policy)).toBe(400);
    expect(computeBackoffDelay(2, policy)).toBe(800);
    expect(computeBackoffDelay(3, policy)).toBe(1_000); // 1600 → cap 1000
    expect(computeBackoffDelay(10, policy)).toBe(1_000);
  });

  it("负数/小数重试序号按 0 起算（不产生 NaN 或不存在的负延迟）", () => {
    expect(computeBackoffDelay(-3, policy)).toBe(200);
    expect(computeBackoffDelay(0.7, policy)).toBe(200);
  });

  it("抖动是**对称**的：random()=0 → -ratio，random()→1 → +ratio", () => {
    const jittered = { ...policy, jitterRatio: 0.25 };
    expect(computeBackoffDelay(0, jittered, () => 0)).toBe(150); // 200 × 0.75
    expect(computeBackoffDelay(0, jittered, () => 0.999999)).toBe(250); // ≈200 × 1.25
    // 期望值不漂：中点仍是基数
    expect(computeBackoffDelay(0, jittered, () => 0.5)).toBe(200);
  });

  it("jitterRatio=0 时不调用随机源（确定性路径零依赖）", () => {
    const random = jest.fn(() => 0.5);
    computeBackoffDelay(1, policy, random);
    expect(random).not.toHaveBeenCalled();
  });
});

describe("withLlmRetry —— 重试/放弃/截止", () => {
  const sleepSpy = () => {
    const calls: number[] = [];
    return {
      calls,
      sleep: async (ms: number) => {
        calls.push(ms);
      },
    };
  };

  it("首次成功：不 sleep、不触发 onRetry", async () => {
    const { calls, sleep } = sleepSpy();
    const onRetry = jest.fn();
    const out = await withLlmRetry(async () => "ok", { sleep, onRetry });
    expect(out).toBe("ok");
    expect(calls).toEqual([]);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("可重试错误：按策略重试并**抛最后一个原始错误**（不包装）", async () => {
    const { calls, sleep } = sleepSpy();
    const events: RetryEvent[] = [];
    const giveUp: RetryGiveUp[] = [];
    const original = httpError(503);
    const call = jest.fn(async () => {
      throw original;
    });

    await expect(
      withLlmRetry(call, {
        policy: { maxAttempts: 3, initialDelayMs: 10, jitterRatio: 0 },
        sleep,
        onRetry: (e) => events.push(e),
        onGiveUp: (g) => giveUp.push(g),
      }),
    ).rejects.toBe(original); // 身份相等：包装会把 401/502 的第一手信息埋掉

    expect(call).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
    expect(events.map((e) => e.delayMs)).toEqual([10, 20]);
    expect(calls).toEqual([10, 20]);
    expect(giveUp).toEqual([
      { attempts: 3, error: original, reason: "exhausted" },
    ]);
  });

  it("确定性错误：**一次都不重试**，立即放弃并抛原错", async () => {
    const { calls, sleep } = sleepSpy();
    const giveUp: RetryGiveUp[] = [];
    const original = httpError(401);
    const call = jest.fn(async () => {
      throw original;
    });

    await expect(
      withLlmRetry(call, { sleep, onGiveUp: (g) => giveUp.push(g) }),
    ).rejects.toBe(original);

    expect(call).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(giveUp).toEqual([
      { attempts: 1, error: original, reason: "fatal" },
    ]);
  });

  it("墙钟预算不足：不睡、不再试（睡醒也会被预算闸门判死）", async () => {
    const { calls, sleep } = sleepSpy();
    const giveUp: RetryGiveUp[] = [];
    const original = httpError(502);
    const call = jest.fn(async () => {
      throw original;
    });

    await expect(
      withLlmRetry(call, {
        policy: { maxAttempts: 5, initialDelayMs: 1_000, jitterRatio: 0 },
        deadlineAt: 1_500, // now=0，首次延迟 1000 能等，第二次 2000 等不起
        now: () => 0,
        sleep,
        onGiveUp: (g) => giveUp.push(g),
      }),
    ).rejects.toBe(original);

    expect(call).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([1_000]); // 只睡得起第一次
    expect(giveUp[0]).toMatchObject({ attempts: 2, reason: "deadline" });
  });

  it("shouldRetry 可覆盖判据（运维临时放宽/收紧时不用改库）", async () => {
    const { sleep } = sleepSpy();
    const call = jest
      .fn()
      .mockRejectedValueOnce(new Error("自定义可重试"))
      .mockResolvedValueOnce("ok");

    const out = await withLlmRetry(call, {
      shouldRetry: () => true,
      sleep,
    });
    expect(out).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("maxAttempts=1：等价于不重试（但错误仍原样抛出）", async () => {
    const { calls, sleep } = sleepSpy();
    const original = httpError(503);
    await expect(
      withLlmRetry(
        async () => {
          throw original;
        },
        { policy: { maxAttempts: 1 }, sleep },
      ),
    ).rejects.toBe(original);
    expect(calls).toEqual([]);
  });
});
