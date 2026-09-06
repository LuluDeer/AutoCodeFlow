import { ConfigService } from "@nestjs/config";
import {
  LogRetentionCleanupService,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_BATCH_SIZE,
} from "../log-retention/log-retention-cleanup.service";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";

const mockRepo = () => {
  const qb = () => ({
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  });
  return { createQueryBuilder: jest.fn(qb) };
};

describe("LogRetentionCleanupService", () => {
  let service: LogRetentionCleanupService;
  let repo: ReturnType<typeof mockRepo>;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    repo = mockRepo();
    // ARCH-27: 保留期改为经 ConfigService 读 logRetention.days —— spec 用
    // 桩 ConfigService 提供配置值，不再操纵 process.env。
    configService = { get: jest.fn().mockReturnValue(undefined) };
    service = new LogRetentionCleanupService(
      repo as unknown as import("typeorm").Repository<ExecutionLogLine>,
      configService as unknown as ConfigService,
    );
  });

  /** 取第 n 次批删除的 where 参数（cutoff / batchSize） */
  const getBatchCall = (callIndex: number) => {
    const qb = repo.createQueryBuilder.mock.results[callIndex].value;
    expect(qb.delete).toHaveBeenCalledWith();
    return qb.where.mock.calls[0][1] as {
      cutoff: Date;
      batchSize: number;
    };
  };

  describe("cleanupExpiredLines — 分批删除", () => {
    it("超过一批时循环删除，直至影响行数 < 批大小", async () => {
      // 注意：execute 必须跨批共享同一个 mock，否则每批都会重新消费 mockResolvedValueOnce 队列
      const execute = jest
        .fn()
        // 第 1、2 批满批 → 继续；第 3 批 230 行 → 停止
        .mockResolvedValueOnce({ affected: LOG_RETENTION_BATCH_SIZE })
        .mockResolvedValueOnce({ affected: LOG_RETENTION_BATCH_SIZE })
        .mockResolvedValueOnce({ affected: 230 });
      repo.createQueryBuilder.mockImplementation(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute,
      }));

      const total = await service.cleanupExpiredLines();
      expect(execute).toHaveBeenCalledTimes(3);
      expect(total).toBe(LOG_RETENTION_BATCH_SIZE * 2 + 230);
    });

    it("空表（affected=0）时只执行一批即停止", async () => {
      const total = await service.cleanupExpiredLines();
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(total).toBe(0);
    });

    it("每批 DELETE 限制批大小为 5000", async () => {
      repo.createQueryBuilder.mockImplementation(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 10 }),
      }));

      await service.cleanupExpiredLines();
      const params = getBatchCall(0);
      expect(params.batchSize).toBe(LOG_RETENTION_BATCH_SIZE);
      expect(params.batchSize).toBe(5000);
    });

    it("affected 缺失时按 0 处理并停止循环", async () => {
      repo.createQueryBuilder.mockImplementation(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: undefined }),
      }));

      const total = await service.cleanupExpiredLines();
      expect(total).toBe(0);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanupExpiredLines — 保留期计算（ARCH-27: 经 ConfigService）", () => {
    it("未配置（logRetention.days 缺失）时默认保留 30 天，cutoff = now - 30d", async () => {
      const now = new Date("2026-09-02T03:30:00.000Z");
      await service.cleanupExpiredLines(now);
      const { cutoff } = getBatchCall(0);
      expect(cutoff.getTime()).toBe(
        now.getTime() - DEFAULT_LOG_RETENTION_DAYS * 86_400_000,
      );
      expect(configService.get).toHaveBeenCalledWith("logRetention.days");
    });

    it("logRetention.days=7（Joi 校验后的数字）时 cutoff = now - 7d", async () => {
      configService.get.mockImplementation((key: string) =>
        key === "logRetention.days" ? 7 : undefined,
      );
      const now = new Date("2026-09-02T03:30:00.000Z");
      await service.cleanupExpiredLines(now);
      const { cutoff } = getBatchCall(0);
      expect(cutoff.getTime()).toBe(now.getTime() - 7 * 86_400_000);
    });

    it("非法配置（NaN / 0 / 负数）回退默认 30 天", async () => {
      const now = new Date("2026-09-02T03:30:00.000Z");
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
      for (const bad of [NaN, 0, -5]) {
        repo.createQueryBuilder.mockClear();
        configService.get.mockImplementation((key: string) =>
          key === "logRetention.days" ? bad : String(bad),
        );
        await service.cleanupExpiredLines(now);
        const { cutoff } = getBatchCall(0);
        expect(cutoff.getTime()).toBe(
          now.getTime() - DEFAULT_LOG_RETENTION_DAYS * 86_400_000,
        );
      }
      expect(warnSpy).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });

    it("where 子句使用参数化 cutoff（无 SQL 注入面）", async () => {
      const now = new Date("2026-09-02T03:30:00.000Z");
      await service.cleanupExpiredLines(now);
      const qb = repo.createQueryBuilder.mock.results[0].value;
      const [sql, params] = qb.where.mock.calls[0];
      expect(String(sql)).toContain(":cutoff");
      expect(params).toEqual({
        cutoff: new Date(
          now.getTime() - DEFAULT_LOG_RETENTION_DAYS * 86_400_000,
        ),
        batchSize: LOG_RETENTION_BATCH_SIZE,
      });
    });
  });

  describe("handleDailyCleanup — cron 入口", () => {
    it("正常路径调用 cleanupExpiredLines 且吞掉异常不抛出", async () => {
      const spy = jest
        .spyOn(service, "cleanupExpiredLines")
        .mockResolvedValue(0);
      await expect(service.handleDailyCleanup()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("清理抛错时仅记日志，不向外传播", async () => {
      const spy = jest
        .spyOn(service, "cleanupExpiredLines")
        .mockRejectedValue(new Error("db down"));
      await expect(service.handleDailyCleanup()).resolves.toBeUndefined();
      spy.mockRestore();
    });
  });
});
