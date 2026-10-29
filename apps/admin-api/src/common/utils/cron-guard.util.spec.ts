/**
 * rt-5: guardedCron 的**契约** spec——这个 util 的全部价值在两条判据：
 *   ① body 抛错（同步 throw 或异步 reject）→ 本 util **resolve**（不上抛），
 *      且 logger.warn 被调、文案里带得回 cron 名与原始错误；
 *   ② 成功 → 原样透传返回值（cron 体的返回语义不被包装改变）。
 *
 * 这两条缺一不可：只测「不 reject」会放过「静默吞掉、无日志可循」的实现，
 * 只测「透传」则完全测不到本 util 存在的理由。
 */
import { guardedCron } from "./cron-guard.util";

describe("guardedCron (rt-5 CRON-GUARD)", () => {
  const logger = { warn: jest.fn<undefined, [string]>() };

  beforeEach(() => {
    logger.warn.mockClear();
  });

  it("body 异步 reject → 本 util resolve（不上抛），并 warn 出 cron 名与原始错误", async () => {
    const boom = new Error("connection terminated unexpectedly");
    // 关键断言之一是「不 reject」：若实现里漏了 try/catch，这一行直接让用例红。
    await expect(
      guardedCron("executor.detectLostExecutions", logger, async () => {
        throw boom;
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = logger.warn.mock.calls[0][0];
    expect(msg).toContain("executor.detectLostExecutions");
    expect(msg).toContain("connection terminated unexpectedly");
    expect(msg).toContain("CRON-GUARD");
  });

  it("body 同步 throw（非 async 体）同样被兜住（不 reject）", async () => {
    await expect(
      guardedCron("auth.cleanupExpiredTokens", logger, () => {
        throw new Error("duplicate key value violates unique constraint");
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("auth.cleanupExpiredTokens");
  });

  it("非 Error 抛出物（字符串 / undefined）不会让日志路径二次抛错", async () => {
    await expect(
      guardedCron("audit.cleanupOldAuditLogs", logger, () =>
        Promise.reject("string-rejection"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      guardedCron("audit.cleanupOldAuditLogs", logger, () =>
        Promise.reject(undefined),
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toContain("string-rejection");
    expect(logger.warn.mock.calls[1][0]).toContain("undefined");
  });

  it("成功 → 原样透传返回值（数字 / 对象 / undefined 三种形态）", async () => {
    await expect(guardedCron("a.b", logger, async () => 42)).resolves.toBe(42);
    const payload = { deleted: 7 };
    await expect(guardedCron("a.c", logger, () => payload)).resolves.toBe(
      payload,
    );
    await expect(
      guardedCron("a.d", logger, async () => undefined),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("成功路径不记日志（避免每拍 cron 都刷一行 warn）", async () => {
    await guardedCron("scheduler.reload", logger, async () => {});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("await 语义保留：本 util 等到 body 真正结束才 resolve（cron 体重叠不被掩盖）", async () => {
    const order: string[] = [];
    await guardedCron("a.slow", logger, async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("body-done");
    });
    order.push("guard-resolved");
    expect(order).toEqual(["body-done", "guard-resolved"]);
  });
});
