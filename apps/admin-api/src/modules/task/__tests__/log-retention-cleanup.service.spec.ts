import { ConfigService } from "@nestjs/config";
import {
  LogRetentionCleanupService,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_BATCH_SIZE,
} from "../log-retention/log-retention-cleanup.service";
import { ExecutionLogLine } from "../entities/execution-log-line.entity";
import { partitionNameFor, partitionRangeFor } from "../log-retention/log-partition.util";

const mockRepo = () => {
  const qb = () => ({
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  });
  return {
    createQueryBuilder: jest.fn(qb),
    query: jest.fn().mockResolvedValue([]),
  };
};

/** 分区库探测桩：relkind='p' */
const partitionedRows = [{ relkind: "p" }];
/** 普通表探测桩：relkind='r' */
const plainRows = [{ relkind: "r" }];
/** 空结果 = 表不存在 */
const noRows: { relkind: string }[] = [];

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

  describe("cleanupExpiredLines — legacy 分批 DELETE（fallback 路径）", () => {
    beforeEach(() => {
      // 默认：普通表（未分区化）
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) ? Promise.resolve(plainRows) : Promise.resolve([]),
      );
    });

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
    beforeEach(() => {
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) ? Promise.resolve(plainRows) : Promise.resolve([]),
      );
    });

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

  describe("cleanupExpiredLines — 分区库 DETACH 主路径（ARCH-22）", () => {
    const now = new Date("2026-09-08T03:30:00.000Z"); // 保留 30 天 → cutoff = 08-09T03:30 UTC 前推 30 天 = 2026-08-09T03:30Z

    /** 组装 listPartitions 的 pg_class 查询结果桩 */
    const setPartitions = (
      parts: { name: string; bound: string; approxRows?: string | null }[],
    ) => {
      repo.query.mockImplementation((sql: string) => {
        if (/pg_class/.test(sql) && /relkind/.test(sql)) {
          return Promise.resolve(partitionedRows);
        }
        if (/pg_inherits/.test(sql)) {
          return Promise.resolve(
            parts.map((p) => ({
              name: p.name,
              bound: p.bound,
              // undefined（未传）→ 缺省 "100"；显式 null 原样透传
              approxRows:
                p.approxRows === undefined ? "100" : p.approxRows,
            })),
          );
        }
        // CREATE TABLE IF NOT EXISTS 等命令
        return Promise.resolve(undefined);
      });
    };

    it("上界 ≤ cutoff 的分区被 DETACH + DROP，其余保留", async () => {
      setPartitions([
        {
          name: "execution_log_lines_20260801",
          bound:
            "FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-08-02 00:00:00')",
          approxRows: "42000",
        },
        {
          name: "execution_log_lines_20260809",
          bound:
            "FOR VALUES FROM ('2026-08-09 00:00:00') TO ('2026-08-10 00:00:00')",
          // 上界 08-10T00:00Z < cutoff 08-09T03:30Z? 否——上界更晚，保留
        },
        {
          name: "execution_log_lines_20260808",
          bound:
            "FOR VALUES FROM ('2026-08-08 00:00:00') TO ('2026-08-09 00:00:00')",
          approxRows: "1500",
        },
        {
          name: "execution_log_lines_20260908", // 未来（now 当日）分区必保留
          bound:
            "FOR VALUES FROM ('2026-09-08 00:00:00') TO ('2026-09-09 00:00:00')",
        },
      ]);

      const total = await service.cleanupExpiredLines(now);

      const detachCalls = repo.query.mock.calls
        .filter(([sql]) => String(sql).includes("DETACH PARTITION"))
        .map(([sql]) => String(sql));
      // 08-01（上界 08-02）与 08-08（上界 08-09）两块全超期；08-09 上界
      // 08-10 > cutoff 保留；09-08 未来分区保留
      expect(detachCalls).toHaveLength(2);
      expect(detachCalls[0]).toContain('"execution_log_lines_20260801"');
      expect(detachCalls[1]).toContain('"execution_log_lines_20260808"');
      const dropCalls = repo.query.mock.calls
        .filter(([sql]) => String(sql).startsWith("DROP TABLE"))
        .map(([sql]) => String(sql));
      expect(dropCalls).toHaveLength(2);
      // 清理行数 = 估算行数和（42000 + 1500）
      expect(total).toBe(43500);
    });

    it("边界不可解析的分区跳过并在日志点名，不误删", async () => {
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});
      setPartitions([
        {
          name: "execution_log_lines_weird",
          bound: "FOR VALUES IN ('a','b')",
          approxRows: "999",
        },
      ]);

      const total = await service.cleanupExpiredLines(now);

      expect(total).toBe(0);
      expect(
        repo.query.mock.calls.filter(([sql]) =>
          String(sql).includes("DETACH PARTITION"),
        ),
      ).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("execution_log_lines_weird"),
      );
      warnSpy.mockRestore();
    });

    it("时钟回拨保护：上界晚于当前时刻的分区绝不 DETACH", async () => {
      // 保留期 1 天 → cutoff = 09-07T03:30Z；构造一个上界 09-09（未来）
      // 的分区——若未按时钟保护会因上界 > cutoff 之外被误判
      configService.get.mockImplementation((key: string) =>
        key === "logRetention.days" ? 1 : undefined,
      );
      setPartitions([
        {
          name: "execution_log_lines_20260909",
          bound:
            "FOR VALUES FROM ('2026-09-09 00:00:00') TO ('2026-09-10 00:00:00')",
        },
      ]);

      const total = await service.cleanupExpiredLines(now);
      expect(total).toBe(0);
      expect(
        repo.query.mock.calls.filter(([sql]) =>
          String(sql).includes("DETACH PARTITION"),
        ),
      ).toHaveLength(0);
    });

    it("reltuples 估算缺失（null / 非数字）按 0 行计，DETACH 仍执行", async () => {
      setPartitions([
        {
          name: "execution_log_lines_20260801",
          bound:
            "FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-08-02 00:00:00')",
          approxRows: null,
        },
        {
          name: "execution_log_lines_20260802",
          bound:
            "FOR VALUES FROM ('2026-08-02 00:00:00') TO ('2026-08-03 00:00:00')",
          approxRows: "abc",
        },
      ]);

      const total = await service.cleanupExpiredLines(now);
      // null → 0（?? 0），"abc" → parseInt NaN → 0（Number.isFinite 过滤）
      expect(total).toBe(0);
      expect(
        repo.query.mock.calls.filter(([sql]) =>
          String(sql).includes("DETACH PARTITION"),
        ),
      ).toHaveLength(2);
    });
  });

  describe("cleanupExpiredLines — 路径选择与开关（ARCH-22）", () => {
    it("分区库 + LOG_PARTITION_ENABLED=false → 回退 legacy DELETE 路径", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "logPartition.enabled") return false;
        return undefined;
      });
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) && /relkind/.test(sql)
          ? Promise.resolve(partitionedRows)
          : Promise.resolve([]),
      );
      repo.createQueryBuilder.mockImplementation(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 12 }),
      }));

      const total = await service.cleanupExpiredLines();
      expect(total).toBe(12);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
      // 未走 DETACH
      expect(
        repo.query.mock.calls.filter(([sql]) =>
          String(sql).includes("DETACH"),
        ),
      ).toHaveLength(0);
    });

    it("分区库 + 开关经原始 env 字符串 'false'（Joi 未注册的测试桩形态）也回退", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "LOG_PARTITION_ENABLED") return "false";
        return undefined;
      });
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) && /relkind/.test(sql)
          ? Promise.resolve(partitionedRows)
          : Promise.resolve([]),
      );

      await service.cleanupExpiredLines();
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("分区库 + 开关缺省 → 默认走 DETACH 主路径", async () => {
      repo.query.mockImplementation((sql: string) => {
        if (/pg_class/.test(sql) && /relkind/.test(sql)) {
          return Promise.resolve(partitionedRows);
        }
        if (/pg_inherits/.test(sql)) return Promise.resolve([]);
        return Promise.resolve(undefined);
      });

      await service.cleanupExpiredLines();
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("表不存在（探测空结果）→ legacy DELETE 路径兜底不抛错", async () => {
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) ? Promise.resolve(noRows) : Promise.resolve([]),
      );
      repo.createQueryBuilder.mockImplementation(() => ({
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      }));

      const total = await service.cleanupExpiredLines();
      expect(total).toBe(3);
    });
  });

  describe("ensureUpcomingPartitions — 未来分区每日预建（ARCH-22）", () => {
    /** pg_class 桩：分区库 + 既有分区集合 */
    const setPartitionedWithExisting = (existing: string[]) => {
      repo.query.mockImplementation((sql: string) => {
        if (/pg_class/.test(sql) && /relkind/.test(sql)) {
          return Promise.resolve(partitionedRows);
        }
        if (/pg_inherits/.test(sql)) {
          return Promise.resolve(
            existing.map((name) => ({
              name,
              bound:
                "FOR VALUES FROM ('2026-09-08 00:00:00') TO ('2026-09-09 00:00:00')",
              approxRows: "0",
            })),
          );
        }
        return Promise.resolve(undefined);
      });
    };

    it("预建今天+1..+7 共 7 个日分区（CREATE TABLE IF NOT EXISTS）", async () => {
      setPartitionedWithExisting([]);

      const now = new Date("2026-09-08T19:00:00.000Z");
      const created = await service.ensureUpcomingPartitions(now);

      expect(created).toHaveLength(7);
      const names = repo.query.mock.calls
        .filter(([sql]) => String(sql).startsWith("CREATE TABLE"))
        .map(
          ([sql]) =>
            /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(String(sql))![1],
        );
      expect(names).toEqual([
        "execution_log_lines_20260909",
        "execution_log_lines_20260910",
        "execution_log_lines_20260911",
        "execution_log_lines_20260912",
        "execution_log_lines_20260913",
        "execution_log_lines_20260914",
        "execution_log_lines_20260915",
      ]);
      // 边界表达式对齐 util 约定（首分区 09-09）
      const firstCreate = String(
        repo.query.mock.calls.find(([sql]) =>
          String(sql).startsWith("CREATE TABLE"),
        )![0],
      );
      const { from, to } = partitionRangeFor(new Date("2026-09-09T00:00:00Z"));
      expect(firstCreate).toContain(`FROM ('${from} 00:00:00')`);
      expect(firstCreate).toContain(`TO ('${to} 00:00:00')`);
      expect(partitionNameFor(new Date("2026-09-09T00:00:00Z"))).toBe(
        "execution_log_lines_20260909",
      );
    });

    it("已存在的分区跳过（只补缺失的，幂等可重入）", async () => {
      setPartitionedWithExisting([
        "execution_log_lines_20260909",
        "execution_log_lines_20260910",
      ]);

      const created = await service.ensureUpcomingPartitions(
        new Date("2026-09-08T19:00:00.000Z"),
      );

      expect(created).toEqual([
        "execution_log_lines_20260911",
        "execution_log_lines_20260912",
        "execution_log_lines_20260913",
        "execution_log_lines_20260914",
        "execution_log_lines_20260915",
      ]);
      const createCalls = repo.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith("CREATE TABLE"),
      );
      expect(createCalls).toHaveLength(5);
    });

    it("非分区库返回空数组且零 CREATE（S3 驱动 / 未迁移库安全）", async () => {
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) && /relkind/.test(sql)
          ? Promise.resolve(plainRows)
          : Promise.resolve(undefined),
      );

      const created = await service.ensureUpcomingPartitions();
      expect(created).toEqual([]);
      expect(
        repo.query.mock.calls.filter(([sql]) =>
          String(sql).startsWith("CREATE TABLE"),
        ),
      ).toHaveLength(0);
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

    it("分区库上清理抛错不阻断后续分区预建（预建独立兜底）", async () => {
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) && /relkind/.test(sql)
          ? Promise.resolve(partitionedRows)
          : Promise.resolve(undefined),
      );
      const cleanupSpy = jest
        .spyOn(service, "cleanupExpiredLines")
        .mockRejectedValue(new Error("detach failed"));
      const ensureSpy = jest
        .spyOn(service, "ensureUpcomingPartitions")
        .mockResolvedValue(["execution_log_lines_20260909"]);

      await expect(service.handleDailyCleanup()).resolves.toBeUndefined();
      expect(ensureSpy).toHaveBeenCalledTimes(1);
      cleanupSpy.mockRestore();
      ensureSpy.mockRestore();
    });

    it("预建抛错同样只记日志不传播", async () => {
      repo.query.mockImplementation((sql: string) =>
        /pg_class/.test(sql) && /relkind/.test(sql)
          ? Promise.resolve(partitionedRows)
          : Promise.resolve(undefined),
      );
      jest.spyOn(service, "cleanupExpiredLines").mockResolvedValue(0);
      const ensureSpy = jest
        .spyOn(service, "ensureUpcomingPartitions")
        .mockRejectedValue(new Error("create failed"));

      await expect(service.handleDailyCleanup()).resolves.toBeUndefined();
      ensureSpy.mockRestore();
    });

    it("legacy 库 / 开关关闭时 cron 不做分区预建", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "logPartition.enabled") return false;
        return undefined;
      });
      const ensureSpy = jest
        .spyOn(service, "ensureUpcomingPartitions")
        .mockResolvedValue([]);
      jest.spyOn(service, "cleanupExpiredLines").mockResolvedValue(0);

      await service.handleDailyCleanup();
      expect(ensureSpy).not.toHaveBeenCalled();
      ensureSpy.mockRestore();
    });
  });
});
