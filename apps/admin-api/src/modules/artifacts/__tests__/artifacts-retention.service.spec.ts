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
import { ConfigService } from "@nestjs/config";
import { ArtifactsRetentionService } from "../artifacts-retention.service";
import { TaskExecution } from "../../task/entities/task-execution.entity";

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

const makeExecRepo = () => ({
  update: jest.fn().mockResolvedValue({ affected: 1 }),
});

const makeConfig = () =>
  ({ get: jest.fn().mockReturnValue(30) }) as unknown as ConfigService;

describe("ArtifactsRetentionService (NETOPT-8⑦)", () => {
  beforeEach(() => {
    // 清掉上一用例的调用记录（工厂默认实现经 jest.fn(impl) 提供，clear 后仍在）
    jest.clearAllMocks();
  });

  const seedTwoDirs = () => {
    (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
      if (p === ROOT) return ["exec-old", "exec-fresh"];
      return []; // 产物子目录内无文件 → oldestMtimeMs 回退目录自身 mtime
    });
    (mockFs.statSync as jest.Mock).mockImplementation((p: string) => {
      if (String(p).endsWith("exec-old")) {
        return { isDirectory: () => true, mtimeMs: 1_000 };
      }
      return { isDirectory: () => true, mtimeMs: NOW_MS };
    });
  };

  it("清盘后被清 execId 的 artifacts 清单同步置 NULL（分批 IN）", async () => {
    seedTwoDirs();
    const execRepo = makeExecRepo();
    const service = new ArtifactsRetentionService(
      makeConfig(),
      null,
      execRepo as unknown as import("typeorm").Repository<TaskExecution>,
    );

    const removed = await service.cleanupExpiredArtifacts(NOW);

    expect(removed).toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
    expect(String(mockFs.promises.rm.mock.calls[0][0])).toContain("exec-old");
    // UPDATE task_executions SET artifacts = NULL WHERE id IN (清盘 execId)
    expect(execRepo.update).toHaveBeenCalledTimes(1);
    const [where, patch] = execRepo.update.mock.calls[0] as [
      { id: { value: string[] } },
      { artifacts: null },
    ];
    expect(where.id.value).toEqual(["exec-old"]);
    expect(patch).toEqual({ artifacts: null });
  });

  it("未清目录的清单不动（fresh 目录不进 UPDATE 集合）", async () => {
    seedTwoDirs();
    const execRepo = makeExecRepo();
    const service = new ArtifactsRetentionService(
      makeConfig(),
      null,
      execRepo as unknown as import("typeorm").Repository<TaskExecution>,
    );

    await service.cleanupExpiredArtifacts(NOW);

    const [where] = execRepo.update.mock.calls[0] as [
      { id: { value: string[] } },
    ];
    expect(where.id.value).not.toContain("exec-fresh");
  });

  it("UPDATE 失败不阻断磁盘清理（best-effort，warn，返回已删目录数）", async () => {
    seedTwoDirs();
    const execRepo = makeExecRepo();
    execRepo.update.mockRejectedValue(new Error("db down"));
    const service = new ArtifactsRetentionService(
      makeConfig(),
      null,
      execRepo as unknown as import("typeorm").Repository<TaskExecution>,
    );

    await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
  });

  it("execRepo 缺席（@Optional 既有装配）仅磁盘清理照旧", async () => {
    seedTwoDirs();
    const service = new ArtifactsRetentionService(makeConfig(), null, null);

    await expect(service.cleanupExpiredArtifacts(NOW)).resolves.toBe(1);
    expect(mockFs.promises.rm).toHaveBeenCalledTimes(1);
  });

  it("大清单分批 IN（>1000 个 execId 时切多批 UPDATE）", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => `exec-${i}`);
    (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) =>
      p === ROOT ? many : [],
    );
    (mockFs.statSync as jest.Mock).mockImplementation(() => ({
      isDirectory: () => true,
      mtimeMs: 1_000,
    }));
    const execRepo = makeExecRepo();
    const service = new ArtifactsRetentionService(
      makeConfig(),
      null,
      execRepo as unknown as import("typeorm").Repository<TaskExecution>,
    );

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
    const seedMixedDir = () => {
      (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        if (p === ROOT) return ["exec-mixed"];
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
      const service = new ArtifactsRetentionService(makeConfig(), null, null);

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
          return { isDirectory: () => false, mtimeMs: NOW_MS - 40 * 86_400_000 };
        }
        return { isDirectory: () => true, mtimeMs: 1_000 };
      });
      const service = new ArtifactsRetentionService(makeConfig(), null, null);

      const removed = await service.cleanupExpiredArtifacts(NOW);
      expect(removed).toBe(1);
      expect(String(mockFs.promises.rm.mock.calls[0][0])).toContain(
        "exec-mixed",
      );
    });
  });
});
