/**
 * NETOPT-8④: cappedBatchedDelete 公共 helper 行为 spec（镜像
 * log-retention-cleanup.service.spec 的 LOG-RETENTION-01 用例形态）：
 * - affected 恒返满批 → 达轮数上限终止且 warn 被调（不挂死、不静默）；
 * - 墙钟闸：注入 fake clock 推过 deadline → 终止且 warn 被调；
 * - 单批不足批大小 → 即停、无 warn（正常收口路径不告警）。
 */
import { cappedBatchedDelete } from "./capped-batched-delete.util";

describe("cappedBatchedDelete (NETOPT-8④)", () => {
  const logger = { warn: jest.fn(), log: jest.fn() };

  beforeEach(() => {
    logger.warn.mockClear();
  });

  it("affected 恒返满批 → 在轮数上限处终止（不会挂死）", async () => {
    const executeBatch = jest.fn().mockResolvedValue(500);
    const total = await cappedBatchedDelete({
      batchSize: 500,
      executeBatch,
      logLabel: "TEST",
      logger,
      maxRounds: 7,
      maxDurationMs: 60_000,
    });
    expect(executeBatch).toHaveBeenCalledTimes(7);
    expect(total).toBe(500 * 7);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("轮数上限"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("余量交下一 cron 周期"),
    );
  });

  it("墙钟闸：fake clock 推过 deadline 即停（不依赖轮数）", async () => {
    let tick = 0;
    const executeBatch = jest.fn().mockResolvedValue(500);
    const total = await cappedBatchedDelete({
      batchSize: 500,
      executeBatch,
      logLabel: "TEST",
      logger,
      maxRounds: 100,
      maxDurationMs: 10,
      // 每次读时钟推进 100ms：第一批后 deadline(基线+10) 必然已过
      now: () => {
        tick += 100;
        return tick;
      },
    });
    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(total).toBe(500);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("时间上限"),
    );
  });

  it("单批不足批大小 → 即停且无 warn（正常收口）", async () => {
    const executeBatch = jest.fn().mockResolvedValue(42);
    const total = await cappedBatchedDelete({
      batchSize: 500,
      executeBatch,
      logLabel: "TEST",
      logger,
      maxRounds: 10,
    });
    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(total).toBe(42);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("executeBatch 抛错原样外抛（由调用方 cron 入口兜底）", async () => {
    const executeBatch = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(
      cappedBatchedDelete({
        batchSize: 500,
        executeBatch,
        logLabel: "TEST",
        logger,
      }),
    ).rejects.toThrow("db down");
  });
});
