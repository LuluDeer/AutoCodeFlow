/**
 * NETOPT-8⑦: ArtifactsRetentionService 行为 spec。
 *
 * 语义（本条修复后）：磁盘清盘与 DB 清单**同步回收**——修复前磁盘按
 * LOG_RETENTION_DAYS（默认 30d）独立回收而 DB 清单列随执行行 90d 走，
 * 30-90 天窗口内执行详情仍列产物但下载 404。
 *
 * 覆盖：
 * - 清盘后被清 execId 的 artifacts 清单置 NULL（分批 IN）；
 * - 未清目录的清单不动；
 * - UPDATE 失败不阻断磁盘清理（best-effort，warn）；
 * - execRepo 缺席（@Optional 既有装配）仅磁盘清理照旧。
 *
 * DL-1（双轨同进同退）：同一 chunk 的「jsonb 置空 + 索引行删除」放进同一事务；
 * 任一侧失败 → 整 chunk 回滚（降级装配下即整 chunk 跳过），DB 未清可由下轮重试。
 * DL-2（IN 列表 uuid 形状）：产物根下的非 UUID 子目录不进 IN()，否则 PG 22P02
 * 会让整 chunk 永久失败。
 */
// 注意：不能用整体工厂替换 fs 模块——spec 间接加载 typeorm（实体装饰器），
// 其内部 path-scurry 依赖真实 fs。保留真实实现、仅覆盖本服务消费的面。
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: jest.fn(() => true),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(),
  promises: { ...jest.requireActual("fs").promises, rm: jest.fn() },
}));
import * as fs from "fs";
import * as path from "path";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ArtifactsRetentionService } from "../artifacts-retention.service";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { ExecutionArtifactRow } from "../entities/execution-artifact.entity";

const mockFs = {
  existsSync: fs.existsSync as unknown as jest.Mock,
  readdirSync: fs.readdirSync as unknown as jest.Mock,
  statSync: fs.statSync as unknown as jest.Mock,
  promises: { rm: fs.promises.rm as unknown as jest.Mock },
};

const NOW = new Date("2026-09-20T03:45:00.000Z");
const NOW_MS = NOW.getTime();
/** 产物根目录（cwd 下 uploads/artifacts，与 artifacts.constants 一致） */
const ROOT = path.join(process.cwd(), "uploads", "artifacts");

/** DL-2: task_executions.id 是 uuid 列，目录名必须是同形状的 uuid。 */
const OLD_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const FRESH_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const uuidLike = (i: number) =>
  `3f2504e0-4f89-41d3-9a0c-${String(i).padStart(12, "0")}`;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const makeExecRepo = () => ({
  update: jest.fn().mockResolvedValue({ affected: 1 }),
});

const makeIndexRepo = () => ({
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
});

/** DataSource 桩：transaction 直接跑回调，回调抛错即 reject（≈ 回滚）。 */
const makeDataSource = (manager: Record<string, jest.Mock>) => ({
  transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
    cb(manager),
  ),
});

const makeManager = () => ({
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
});

const makeConfig = () =>
  ({ get: jest.fn().mockReturnValue(30) }) as unknown as ConfigService;

type ExecRepo = import("typeorm").Repository<TaskExecution>;
type IndexRepo = import("typeorm").Repository<ExecutionArtifactRow>;
type DS = import("typeorm").DataSource;

const build = (
  opts: {
    execRepo?: ReturnType<typeof makeExecRepo> | null;
    indexRepo?: ReturnType<typeof makeIndexRepo> | null;
    dataSource?: ReturnType<typeof makeDataSource> | null;
  } = {},
) =>
  new ArtifactsRetentionService(
    makeConfig(),
    null,
    (opts.execRepo === undefined ? null : opts.execRepo) as unknown as ExecRepo,
    (opts.indexRepo === undefined
      ? null
      : opts.indexRepo) as unknown as IndexRepo,
    (opts.dataSource === undefined ? null : opts.dataSource) as unknown as DS,
  );

describe("ArtifactsRetentionService (NETOPT-8⑦)", () => {
  const logSpies: jest.SpyInstance[] = [];
  const spyLogs = () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const log = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    logSpies.push(warn, log);
    return { warn, log };
  };

  beforeEach(() => {
    // 清掉上一用例的调用记录（工厂默认实现经 jest.fn(impl) 提供，clear 后仍在）
    jest.clearAllMocks();
  });

  afterEach(() => {
    logSpies.splice(0).forEach((s) => s.mockRestore());
  });

  const seedTwoDirs = () => {
    (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
      if (p === ROOT) return [OLD_ID, FRESH_ID];
      return []; // 产物子目录内无文件 → newestMtimeMs 回退目录自身 mtime
    });
    (mockFs.statSync as jest.Mock).mockImplementation((p: string) => {
      if (String(p).endsWith(OLD_ID)) {
        return { isDirectory: () => true, mtimeMs: 1_000 };
      }
      return { isDirectory: () => true, mtimeMs: NOW_MS };
    });
  };

  it("清盘后被清 execId 的 artifacts 清单同步置 NULL（分批 IN）", async () => {
    seedTwoDirs();
    const execRepo = makeExecRepo();
    const service = build({ execRepo });

    const removed = await service.cleanupExpiredArtifacts(NOW);

    expect(removed).toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
    expect(String(mockFs.promises.rm.mock.calls[0][0])).toContain(OLD_ID);
    // UPDATE task_executions SET artifacts = NULL WHERE id IN (清盘 execId)
    expect(execRepo.update).toHaveBeenCalledTimes(1);
    const [where, patch] = execRepo.update.mock.calls[0] as [
      { id: { value: string[] } },
      { artifacts: null },
    ];
    expect(where.id.value).toEqual([OLD_ID]);
    expect(patch).toEqual({ artifacts: null });
  });

  it("未清目录的清单不动（fresh 目录不进 UPDATE 集合）", async () => {
    seedTwoDirs();
    const execRepo = makeExecRepo();
    const service = build({ execRepo });

    await service.cleanupExpiredArtifacts(NOW);

    const [where] = execRepo.update.mock.calls[0] as [
      { id: { value: string[] } },
    ];
    expect(where.id.value).not.toContain(FRESH_ID);
  });

  it("UPDATE 失败不阻断磁盘清理（best-effort，warn，返回已删目录数）", async () => {
    seedTwoDirs();
    const { warn } = spyLogs();
    const execRepo = makeExecRepo();
    execRepo.update.mockRejectedValue(new Error("db down"));
    const service = build({ execRepo });

    await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("execRepo 缺席（@Optional 既有装配）仅磁盘清理照旧", async () => {
    seedTwoDirs();
    const service = build({});

    await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
  });

  it("大清单分批 IN（>1000 个 execId 时切多批 UPDATE）", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => uuidLike(i));
    (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) =>
      p === ROOT ? many : [],
    );
    (mockFs.statSync as jest.Mock).mockImplementation(() => ({
      isDirectory: () => true,
      mtimeMs: 1_000,
    }));
    const execRepo = makeExecRepo();
    const service = build({ execRepo });

    const removed = await service.cleanupExpiredArtifacts(NOW);

    expect(removed).toBe(2500);
    expect(execRepo.update).toHaveBeenCalledTimes(3); // 1000 + 1000 + 500
    const allIds = execRepo.update.mock.calls.flatMap(
      (c) => (c[0] as { id: { value: string[] } }).id.value,
    );
    expect(allIds).toHaveLength(2500);
    expect(new Set(allIds).size).toBe(2500);
  });

  // A-10: 过期判据从「目录内最旧 mtime」改为「目录内最新 mtime」——长执行
  // 的目录（旧文件先行过期、期间持续产出新产物）不再被连坐清除。
  describe("A-10 判据改最新 mtime", () => {
    const MIXED_ID = "0f8fad5b-d9cb-4196-9b41-1e2b2c1c9a01";
    const seedMixedDir = () => {
      (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        if (p === ROOT) return [MIXED_ID];
        // exec-mixed 目录内有新旧两个产物文件
        return ["step1-old.log", "step9-new.log"];
      });
      (mockFs.statSync as jest.Mock).mockImplementation((p: string) => {
        if (String(p).endsWith("step1-old.log")) {
          return { isDirectory: () => false, mtimeMs: 1_000 };
        }
        if (String(p).endsWith("step9-new.log")) {
          return { isDirectory: () => false, mtimeMs: NOW_MS - 60_000 };
        }
        return { isDirectory: () => true, mtimeMs: 1_000 };
      });
    };

    it("目录内新旧产物混合（新产物仍在保留期内）→ 整目录保留", async () => {
      seedMixedDir();
      const service = build({});

      // 最旧文件 mtime=1ms 早已过期，但最新文件距 now 仅 60s → 不删除
      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(0);
      expect(mockFs.promises.rm).not.toHaveBeenCalled();
    });

    it("目录内全部产物（含最新）都早于保留期 → 仍照常过期删除", async () => {
      seedMixedDir();
      // 把保留期拉长到 30d 之外也无法挽救：把最新文件也调到过期
      (mockFs.statSync as jest.Mock).mockImplementation((p: string) => {
        if (String(p).endsWith("step1-old.log")) {
          return { isDirectory: () => false, mtimeMs: 1_000 };
        }
        if (String(p).endsWith("step9-new.log")) {
          return {
            isDirectory: () => false,
            mtimeMs: NOW_MS - 40 * 86_400_000,
          };
        }
        return { isDirectory: () => true, mtimeMs: 1_000 };
      });
      const service = build({});

      const removed = await service.cleanupExpiredArtifacts(NOW);
      expect(removed).toBe(1);
      expect(String(mockFs.promises.rm.mock.calls[0][0])).toContain(MIXED_ID);
    });
  });

  // ARTIFACTS-INDEX-46: TTL 清理双轨——jsonb 置空的同批 execId，索引表行
  //（execution_artifacts）同步 delete（两侧恒同宽，否则 GET /artifacts 列幽灵产物）。
  describe("ARTIFACTS-INDEX-46 索引表同批回收", () => {
    it("清盘后同批 execId 的索引行同步 delete（分批 IN 与 jsonb 同宽）", async () => {
      seedTwoDirs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      const service = build({ execRepo, indexRepo });

      const removed = await service.cleanupExpiredArtifacts(NOW);

      expect(removed).toBe(1);
      expect(indexRepo.delete).toHaveBeenCalledTimes(1);
      const where = indexRepo.delete.mock.calls[0][0] as {
        executionId: { value: string[] };
      };
      expect(where.executionId.value).toEqual([OLD_ID]);
    });

    it("索引 repo 缺席（@Optional 降级）→ 仅 jsonb 置空（旧行为）", async () => {
      seedTwoDirs();
      const execRepo = makeExecRepo();
      const service = build({ execRepo });

      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
      expect(execRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  // DL-1: 同一 chunk 的两个 DB 写（jsonb 置空 + 索引行删除）必须同进同退。
  // 磁盘目录已 rm -rf（不可逆），一侧成功一侧失败会留下「详情列产物但下载
  // 404」/「索引已删但 jsonb 仍列」的长期不一致；旧实现两个 try/catch 各自
  // best-effort，互不感知。
  describe("DL-1 双轨同一事务（同进同退）", () => {
    it("有 DataSource → 两个写都在同一事务内，不直连 repo（都成功时都生效）", async () => {
      seedTwoDirs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      const manager = makeManager();
      const dataSource = makeDataSource(manager);
      const service = build({ execRepo, indexRepo, dataSource });

      const removed = await service.cleanupExpiredArtifacts(NOW);

      expect(removed).toBe(1);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // 两个写都在事务 manager 上，且是同一批 execId
      expect(manager.update).toHaveBeenCalledTimes(1);
      const [target, where, patch] = manager.update.mock.calls[0] as [
        unknown,
        { id: { value: string[] } },
        { artifacts: null },
      ];
      expect(target).toBe(TaskExecution);
      expect(where.id.value).toEqual([OLD_ID]);
      expect(patch).toEqual({ artifacts: null });
      expect(manager.delete).toHaveBeenCalledTimes(1);
      const [delTarget, delWhere] = manager.delete.mock.calls[0] as [
        unknown,
        { executionId: { value: string[] } },
      ];
      expect(delTarget).toBe(ExecutionArtifactRow);
      expect(delWhere.executionId.value).toEqual([OLD_ID]);
      // 事务路径下不得再绕过事务直写 repo
      expect(execRepo.update).not.toHaveBeenCalled();
      expect(indexRepo.delete).not.toHaveBeenCalled();
    });

    it("事务内 m.update 抛错 → 整 chunk 回滚：m.delete 不执行、jsonb 未生效（旧实现已生效），warn 带 chunk 大小与首个 id", async () => {
      seedTwoDirs();
      const { warn } = spyLogs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      const manager = makeManager();
      manager.update.mockRejectedValue(new Error("db down"));
      const dataSource = makeDataSource(manager);
      const service = build({ execRepo, indexRepo, dataSource });

      // 磁盘回收已完成是事实，仍返回 1
      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(execRepo.update).not.toHaveBeenCalled();
      // 失败可见：warn 带 chunk 大小与首个 id，并说明 DB 未清、下轮重试
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("chunk=1");
      expect(msg).toContain(OLD_ID);
      expect(msg).toContain("下轮重试");
    });

    it("事务内 m.delete 抛错 → 同一事务里的 m.update 一并回滚（不吞错，warn 可见）", async () => {
      seedTwoDirs();
      const { warn } = spyLogs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      const manager = makeManager();
      manager.delete.mockRejectedValue(new Error("fk violation"));
      const dataSource = makeDataSource(manager);
      const service = build({ execRepo, indexRepo, dataSource });

      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
      expect(manager.update).toHaveBeenCalledTimes(1);
      // 无 DataSource 时代的直写 repo 路径不得被触发（否则就是绕过事务）
      expect(execRepo.update).not.toHaveBeenCalled();
      expect(indexRepo.delete).not.toHaveBeenCalled();
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("chunk=1");
      expect(msg).toContain("下轮重试");
    });

    it("降级（无 DataSource）→ 先删索引行、成功后再置空 jsonb（顺序钉死）", async () => {
      seedTwoDirs();
      const order: string[] = [];
      const execRepo = makeExecRepo();
      execRepo.update.mockImplementation(async () => {
        order.push("jsonb");
        return { affected: 1 };
      });
      const indexRepo = makeIndexRepo();
      indexRepo.delete.mockImplementation(async () => {
        order.push("index");
        return { affected: 1 };
      });
      const service = build({ execRepo, indexRepo });

      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
      // 索引先删：GET /artifacts 的读面先于 jsonb 收敛，不列幽灵产物
      expect(order).toEqual(["index", "jsonb"]);
    });

    it("降级（无 DataSource）→ 索引 delete 抛错即整 chunk 跳过：jsonb 不置空（旧实现照旧置空）", async () => {
      seedTwoDirs();
      const { warn } = spyLogs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      indexRepo.delete.mockRejectedValue(new Error("db down"));
      const service = build({ execRepo, indexRepo });

      await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
      expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
      // 不推进该 chunk：另一侧不写，留给下一轮
      expect(execRepo.update).not.toHaveBeenCalled();
      const msg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(msg).toContain("chunk=1");
      expect(msg).toContain("下轮重试");
    });
  });

  // DL-2: 目录名即 execId，直接进 In() 与 uuid 列比较；出现任何非 UUID 子目录
  // ⇒ PG 22P02 ⇒ 整 chunk（最多 1000 行）每晚永久失败（磁盘已删）。
  describe("DL-2 IN 列表 uuid 形状校验", () => {
    const seedNonUuidDir = () => {
      (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        if (p === ROOT) return ["not-a-uuid", OLD_ID];
        return [];
      });
      (mockFs.statSync as jest.Mock).mockImplementation(() => ({
        isDirectory: () => true,
        mtimeMs: 1_000, // 两个目录都已过期
      }));
    };

    it("非 UUID 子目录不进 IN()：update 收到的 id 全部合法，合法行仍被置空", async () => {
      seedNonUuidDir();
      const { warn } = spyLogs();
      const execRepo = makeExecRepo();
      const indexRepo = makeIndexRepo();
      const service = build({ execRepo, indexRepo });

      const removed = await service.cleanupExpiredArtifacts(NOW);

      // 磁盘层两个目录都已过期 → 都删（磁盘回收不受 DB 形状约束）
      expect(removed).toBe(2);
      expect(mockFs.promises.rm).toHaveBeenCalledTimes(2);
      const ids = (
        execRepo.update.mock.calls[0] as [{ id: { value: string[] } }]
      )[0].id.value;
      expect(ids).toEqual([OLD_ID]);
      expect(ids.every((id) => UUID_SHAPE.test(id))).toBe(true);
      // 非 UUID 只 warn 跳过（带名字）
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("not-a-uuid"))).toBe(true);
    });

    it("「本轮删目录数 vs 参与 DB 清理数」的差值出现在日志里", async () => {
      seedNonUuidDir();
      const { log } = spyLogs();
      const execRepo = makeExecRepo();
      const service = build({ execRepo });

      await service.cleanupExpiredArtifacts(NOW);

      const msgs = log.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes("差值 1"))).toBe(true);
    });
  });
});
