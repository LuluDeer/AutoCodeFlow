import { areDependenciesSatisfied } from "../dependency-gate.util";
import { ExecutionStatus } from "../entities/task-execution.entity";

/**
 * dagRunId 选项：传入时优先匹配同批次执行（params._dagRunId 相同）；
 * 同批次无标记执行时回落旧逻辑（最新执行），不传时逐字节走旧路径。
 */
describe("areDependenciesSatisfied · dagRunId", () => {
  const repoOf = (rows: Array<Record<string, unknown>>) => ({
    find: jest.fn(async () => rows),
    findOne: jest.fn(async () => null),
  }) as any; // 聚焦依赖 gate 的值语义，行对象只需 taskId/status/params/createdAt

  it("同批次 SUCCESS 执行命中，即使最新执行是别的批次的 FAILED", async () => {
    const repo = repoOf([
      { taskId: "up-1", status: ExecutionStatus.FAILED, params: { _dagRunId: "other" }, createdAt: new Date("2026-01-02") },
      { taskId: "up-1", status: ExecutionStatus.SUCCESS, params: { _dagRunId: "run-A" }, createdAt: new Date("2026-01-01") },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { dep: "up-1" }, { dagRunId: "run-A" }),
    ).resolves.toBe(true);
  });

  it("同批次执行是 FAILED 时判不满足（不被别的批次 SUCCESS 掩盖）", async () => {
    const repo = repoOf([
      { taskId: "up-1", status: ExecutionStatus.SUCCESS, params: { _dagRunId: "other" }, createdAt: new Date("2026-01-02") },
      { taskId: "up-1", status: ExecutionStatus.FAILED, params: { _dagRunId: "run-A" }, createdAt: new Date("2026-01-01") },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { dep: "up-1" }, { dagRunId: "run-A" }),
    ).resolves.toBe(false);
  });

  it("同批次没有任何标记执行时回落旧逻辑：最新 SUCCESS 算满足", async () => {
    const repo = repoOf([
      { taskId: "up-1", status: ExecutionStatus.SUCCESS, params: {}, createdAt: new Date("2026-01-01") },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { dep: "up-1" }, { dagRunId: "run-A" }),
    ).resolves.toBe(true);
  });

  it("不传 dagRunId 时按最新执行判定（兼容旧行为：最新 FAILED 即不满足）", async () => {
    const repo = repoOf([
      { taskId: "up-1", status: ExecutionStatus.FAILED, params: { _dagRunId: "run-A" } },
      { taskId: "up-1", status: ExecutionStatus.SUCCESS, params: {} },
    ]);
    await expect(
      areDependenciesSatisfied(repo, { dep: "up-1" }),
    ).resolves.toBe(false);
  });
});
