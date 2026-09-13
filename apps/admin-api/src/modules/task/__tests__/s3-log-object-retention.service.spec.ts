import { ConfigService } from "@nestjs/config";
import { S3LogStorage } from "../log-storage/s3-log-storage";
import {
  S3LogObjectRetentionService,
  S3_LOG_OBJECT_BATCH_SIZE,
  S3_LOG_OBJECT_MAX_ROUNDS,
  TERMINAL_EXECUTION_STATUSES,
} from "../log-retention/s3-log-object-retention.service";
import {
  TaskExecution,
  ExecutionStatus,
} from "../entities/task-execution.entity";

/** 候选行桩：只带查询投影的两列（id + logObjectKey） */
const row = (i: number): TaskExecution =>
  ({
    id: `exec-${String(i).padStart(4, "0")}`,
    logObjectKey: `execution-logs/exec-${String(i).padStart(4, "0")}.log.gz`,
  }) as unknown as TaskExecution;

/**
 * 仓储桩：createQueryBuilder 每次新建 qb（select/where/andWhere/orderBy/take
 * 链式 returnThis），getMany 依序消费 batches 队列（耗尽后返回空数组=收口）。
 */
const mockRepo = () => {
  const qbs: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    take: jest.Mock;
    getMany: jest.Mock;
  }[] = [];
  const batches: TaskExecution[][] = [];
  return {
    qbs,
    batches,
    createQueryBuilder: jest.fn(() => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => batches.shift() ?? []),
      };
      qbs.push(qb);
      return qb;
    }),
    update: jest.fn(async () => ({ affected: 1 })),
  };
};

describe("S3LogObjectRetentionService", () => {
  let service: S3LogObjectRetentionService;
  let repo: ReturnType<typeof mockRepo>;
  let configService: { get: jest.Mock };
  let s3: { remove: jest.Mock };
  let fromConfigSpy: jest.SpyInstance;

  beforeEach(() => {
    repo = mockRepo();
    configService = { get: jest.fn().mockReturnValue(undefined) };
    service = new S3LogObjectRetentionService(
      repo as unknown as import("typeorm").Repository<TaskExecution>,
      configService as unknown as ConfigService,
    );
    // mock S3：spy 静态 fromConfig（不触达 minio Client 构造），storage 只留
    // 本服务消费的 remove 面
    s3 = { remove: jest.fn().mockResolvedValue(undefined) };
    fromConfigSpy = jest
      .spyOn(S3LogStorage, "fromConfig")
      .mockReturnValue(s3 as unknown as S3LogStorage);
  });

  afterEach(() => {
    fromConfigSpy.mockRestore();
  });

  describe("cleanupExpiredObjects — 候选行筛选", () => {
    it("只选 s3 指针非空 + 终态 + 终态时间早于保留期截止的行", async () => {
      const now = new Date("2026-09-13T19:35:00.000Z");
      await service.cleanupExpiredObjects(now);

      const qb = repo.qbs[0];
      expect(qb.where).toHaveBeenCalledWith("e.logStorage = :logStorage", {
        logStorage: "s3",
      });
      const andWhereSqls = qb.andWhere.mock.calls.map((c: unknown[]) =>
        String(c[0]),
      );
      expect(andWhereSqls).toContain("e.logObjectKey IS NOT NULL");
      // 终态集合 = 5 个终态，绝不含 PENDING/RUNNING（在途日志仍会被续写）
      expect(TERMINAL_EXECUTION_STATUSES).toEqual([
        ExecutionStatus.SUCCESS,
        ExecutionStatus.FAILED,
        ExecutionStatus.TIMEOUT,
        ExecutionStatus.KILLED,
        ExecutionStatus.CANCELLED,
      ]);
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(
        ExecutionStatus.PENDING,
      );
      expect(TERMINAL_EXECUTION_STATUSES).not.toContain(
        ExecutionStatus.RUNNING,
      );
      const statusCall = qb.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes("e.status IN"),
      );
      expect(statusCall![1]).toEqual({
        terminalStatuses: TERMINAL_EXECUTION_STATUSES,
      });
      // 终态时间：COALESCE(endTime, createdAt) 参数化 cutoff（默认 30 天）
      const endTimeCall = qb.andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes("COALESCE(e.endTime, e.createdAt)"),
      );
      expect(endTimeCall![1].cutoff.getTime()).toBe(
        now.getTime() - 30 * 86_400_000,
      );
      expect(qb.orderBy).toHaveBeenCalledWith("e.id", "ASC");
      expect(qb.take).toHaveBeenCalledWith(S3_LOG_OBJECT_BATCH_SIZE);
      // 投影只取 id + logObjectKey 两列
      expect(qb.select).toHaveBeenCalledWith(["e.id", "e.logObjectKey"]);
    });

    it("logRetention.days=7（与 DB 行清理同源配置）时 cutoff = now - 7d", async () => {
      configService.get.mockImplementation((key: string) =>
        key === "logRetention.days" ? 7 : undefined,
      );
      const now = new Date("2026-09-13T19:35:00.000Z");
      await service.cleanupExpiredObjects(now);
      const endTimeCall = repo.qbs[0].andWhere.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]).includes("COALESCE(e.endTime, e.createdAt)"),
      );
      expect(endTimeCall![1].cutoff.getTime()).toBe(
        now.getTime() - 7 * 86_400_000,
      );
    });
  });

  describe("cleanupExpiredObjects — 回收语义", () => {
    it("remove 成功后带守卫清空 logObjectKey（WHERE id AND logObjectKey）", async () => {
      repo.batches.push([row(1), row(2)]);

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(2);
      expect(s3.remove).toHaveBeenCalledTimes(2);
      expect(s3.remove).toHaveBeenNthCalledWith(
        1,
        "execution-logs/exec-0001.log.gz",
      );
      expect(s3.remove).toHaveBeenNthCalledWith(
        2,
        "execution-logs/exec-0002.log.gz",
      );
      expect(repo.update).toHaveBeenCalledTimes(2);
      // 守卫条件：指针仍指刚删的对象才清（TypeORM update criteria 生成
      // WHERE id = ? AND logObjectKey = ?），防并发重复删/误清
      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        { id: "exec-0001", logObjectKey: "execution-logs/exec-0001.log.gz" },
        { logObjectKey: null },
      );
      expect(repo.update).toHaveBeenNthCalledWith(
        2,
        { id: "exec-0002", logObjectKey: "execution-logs/exec-0002.log.gz" },
        { logObjectKey: null },
      );
    });

    it("remove 失败仅 warn 跳过该行（fail-open，指针保留=下轮 cron 重试）", async () => {
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
      repo.batches.push([row(1), row(2)]);
      s3.remove.mockImplementation(async (key: string) => {
        if (key.includes("exec-0001")) throw new Error("S3 unavailable");
      });

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(1);
      // 失败行不清指针、成功行正常清
      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(
        { id: "exec-0002", logObjectKey: "execution-logs/exec-0002.log.gz" },
        { logObjectKey: null },
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("exec-0001"),
      );
      warnSpy.mockRestore();
    });

    it("清指针失败仅 warn：对象已回收计满，指针留待下轮幂等补清", async () => {
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
      repo.batches.push([row(1)]);
      repo.update.mockRejectedValueOnce(new Error("db down"));

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("logObjectKey"),
      );
      warnSpy.mockRestore();
    });

    it("对象已不存在时 remove 不抛（MinIO DELETE 204 语义）即幂等成功", async () => {
      // remove 的桩 resolved 即模拟 MinIO 对不存在键的成功响应——无需
      // 调用方吞 NotFound，重跑不抛错
      repo.batches.push([row(1)]);

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(1);
      expect(s3.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanupExpiredObjects — 驱动开关与分页", () => {
    it("非 s3 驱动（fromConfig 返回 null）整段 no-op", async () => {
      fromConfigSpy.mockReturnValue(null);

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(0);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(s3.remove).not.toHaveBeenCalled();
    });

    it("S3 后端进程内单例：多次 pass 只解析一次 fromConfig", async () => {
      await service.cleanupExpiredObjects();
      await service.cleanupExpiredObjects();
      expect(fromConfigSpy).toHaveBeenCalledTimes(1);
    });

    it("keyset 分页：下一批查询以上一批最后一行 id 为游标，首批无游标", async () => {
      const batch1 = Array.from(
        { length: S3_LOG_OBJECT_BATCH_SIZE },
        (_, i) => row(i),
      );
      repo.batches.push(batch1, [row(1000)]);

      await service.cleanupExpiredObjects();

      expect(repo.qbs).toHaveLength(2);
      const firstCursor = repo.qbs[0].andWhere.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes("e.id > :afterId"),
      );
      expect(firstCursor).toBeUndefined();
      const secondCursor = repo.qbs[1].andWhere.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes("e.id > :afterId"),
      );
      expect(secondCursor![1]).toEqual({ afterId: "exec-0199" });
    });

    it("不满批即提前收口（不再发起下一轮查询）", async () => {
      repo.batches.push([row(1), row(2)]);

      const total = await service.cleanupExpiredObjects();

      expect(total).toBe(2);
      expect(repo.qbs).toHaveLength(1);
    });

    it("达轮数上限即停（剩余候选留下一轮 cron，日志可见）", async () => {
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
      // 每轮 getMany 都取满批 → 永不自然终止，只能靠轮数上限刹车
      for (let r = 0; r < S3_LOG_OBJECT_MAX_ROUNDS + 3; r++) {
        repo.batches.push(
          Array.from(
            { length: S3_LOG_OBJECT_BATCH_SIZE },
            (_, i) => row(r * 1000 + i),
          ),
        );
      }

      const total = await service.cleanupExpiredObjects();

      expect(repo.qbs).toHaveLength(S3_LOG_OBJECT_MAX_ROUNDS);
      expect(total).toBe(S3_LOG_OBJECT_MAX_ROUNDS * S3_LOG_OBJECT_BATCH_SIZE);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("轮数上限"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("handleDailyObjectCleanup — cron 入口", () => {
    it("整段 pass 抛错只记 error 不向外传播（与 handleDailyCleanup 同姿态）", async () => {
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => {});
      const spy = jest
        .spyOn(service, "cleanupExpiredObjects")
        .mockRejectedValue(new Error("boom"));

      await expect(service.handleDailyObjectCleanup()).resolves.toBeUndefined();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
      spy.mockRestore();
      errorSpy.mockRestore();
    });

    it("回收数 > 0 时记 info 日志（含数量）", async () => {
      const logSpy = jest
        .spyOn((service as any).logger, "log")
        .mockImplementation(() => {});
      const spy = jest
        .spyOn(service, "cleanupExpiredObjects")
        .mockResolvedValue(7);

      await service.handleDailyObjectCleanup();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("7"));
      spy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
