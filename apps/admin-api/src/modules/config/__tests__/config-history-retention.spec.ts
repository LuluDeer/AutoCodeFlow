import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Logger } from "@nestjs/common";
import {
  SystemConfigService,
  CONFIG_HISTORY_RETENTION_BATCH_SIZE,
  CONFIG_HISTORY_RETENTION_PER_KEY,
} from "../config.service";
import { SystemConfig } from "../entities/system-config.entity";
import { ConfigHistory } from "../entities/config-history.entity";

/**
 * B-10: config_history 只增不删的 retention spec。
 *
 * upsert/rollback/remove 每次落一行历史，此前全仓对该表零 delete——永久堆积。
 * 修法比照 outbox 每日 retention 先例：@Cron + LeaderGate 门禁 +
 * cappedBatchedDelete 分批（LOG-RETENTION-01 轮数/墙钟双闸），每键保留最近
 * CONFIG_HISTORY_RETENTION_PER_KEY 条（rollback 可用面）。
 */
describe("B-10: config_history retention", () => {
  const historyRepoMock = {
    createQueryBuilder: jest.fn(),
  };
  const makeDeleteQb = (affected: number) => ({
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected }),
  });

  let service: SystemConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: getRepositoryToken(SystemConfig), useValue: {} },
        {
          provide: getRepositoryToken(ConfigHistory),
          useValue: historyRepoMock,
        },
      ],
    }).compile();
    service = moduleRef.get(SystemConfigService);
  });

  it("清理谓词按 (configKey, createdAt DESC, id DESC) 窗口编号、只删 rn > 保留数的行", async () => {
    historyRepoMock.createQueryBuilder.mockImplementationOnce(() =>
      makeDeleteQb(3),
    );
    const deleted = await service.cleanupHistoryOverflow();
    expect(deleted).toBe(3);
    const qb = historyRepoMock.createQueryBuilder.mock.results[0].value as {
      where: jest.Mock;
    };
    const [sql, params] = qb.where.mock.calls[0] as [
      string,
      { keep: number; batchSize: number },
    ];
    expect(sql).toContain('PARTITION BY "h"."configKey"');
    expect(sql).toContain('ORDER BY "h"."createdAt" DESC, "h"."id" DESC');
    // 边界内保留：rn <= keep（每键最近 50 条，rollback 依赖）绝不在删除集内
    expect(sql).toContain('"rn" > :keep');
    expect(params.keep).toBe(CONFIG_HISTORY_RETENTION_PER_KEY);
    expect(params.batchSize).toBe(CONFIG_HISTORY_RETENTION_BATCH_SIZE);
  });

  it("affected 恒满批时在轮数上限处终止并 warn（LOG-RETENTION-01 双闸）", async () => {
    const { LOG_RETENTION_MAX_DELETE_ROUNDS } =
      await import("../../../common/utils/capped-batched-delete.util");
    historyRepoMock.createQueryBuilder.mockImplementation(() =>
      makeDeleteQb(CONFIG_HISTORY_RETENTION_BATCH_SIZE),
    );
    const warnSpy = jest.spyOn(Logger.prototype, "warn");
    try {
      const deleted = await service.cleanupHistoryOverflow();
      expect(historyRepoMock.createQueryBuilder).toHaveBeenCalledTimes(
        LOG_RETENTION_MAX_DELETE_ROUNDS,
      );
      expect(deleted).toBe(
        CONFIG_HISTORY_RETENTION_BATCH_SIZE * LOG_RETENTION_MAX_DELETE_ROUNDS,
      );
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("轮数上限")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("单批不满即止（affected < 批大小 → 不再开下一轮）", async () => {
    historyRepoMock.createQueryBuilder.mockImplementationOnce(() =>
      makeDeleteQb(1),
    );
    expect(await service.cleanupHistoryOverflow()).toBe(1);
    expect(historyRepoMock.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it("cron 入口：非 Leader 不执行任何清理（ARCH-31 §5 门禁）", async () => {
    (
      service as unknown as { leaderGate: { isLeader: boolean } | null }
    ).leaderGate = { isLeader: false };
    await service.handleDailyHistoryRetention();
    expect(historyRepoMock.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("cron 入口：Leader 执行清理；失败只记日志不外抛（下轮重试）", async () => {
    (
      service as unknown as { leaderGate: { isLeader: boolean } | null }
    ).leaderGate = { isLeader: true };
    historyRepoMock.createQueryBuilder.mockImplementation(() =>
      makeDeleteQb(7),
    );
    await expect(
      service.handleDailyHistoryRetention(),
    ).resolves.toBeUndefined();
    expect(historyRepoMock.createQueryBuilder).toHaveBeenCalledTimes(1);

    historyRepoMock.createQueryBuilder.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(
      service.handleDailyHistoryRetention(),
    ).resolves.toBeUndefined();
  });
});
