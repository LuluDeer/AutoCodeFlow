import { MetricsService } from "../metrics.service";
import { ExecutionStatus } from "../../task/entities/task-execution.entity";
import { TaskStatus } from "../../task/entities/task.entity";

/**
 * DATAOPS 口径定向验收（单测/内存替身级）。
 *
 * QB 替身不是形状钉子：它把生产代码拼进来的谓词**真的**用于过滤执行行，
 * 因此删掉任一 `e.synthetic = false` / deleted 状态谓词，结果断言会立即变红。
 */
type Cond = { sql: string; params?: Record<string, unknown> };
type ExecRow = {
  id: string;
  status: ExecutionStatus;
  synthetic: boolean;
  createdAt: Date;
  duration: number | null;
  taskId: string;
};

const exec = (
  id: string,
  status: ExecutionStatus,
  synthetic: boolean,
  createdAt: Date,
  duration: number | null,
  taskId: string,
): ExecRow => ({ id, status, synthetic, createdAt, duration, taskId });

function makeQb(
  rows: ExecRow[],
  mode: "stats" | "avg" | "count" | "trend" | "duration",
  taskProjects: Map<string, string> = new Map(),
) {
  const conds: Cond[] = [];
  const matches = (r: ExecRow): boolean =>
    conds.every(({ sql, params }) => {
      switch (sql) {
        case "e.synthetic = false":
          return r.synthetic === false;
        case "e.createdAt >= :windowStart":
          return (
            r.createdAt.getTime() >= (params?.windowStart as Date).getTime()
          );
        case "e.createdAt >= :todayStart":
          return (
            r.createdAt.getTime() >= (params?.todayStart as Date).getTime()
          );
        case "e.createdAt >= :start":
          return r.createdAt.getTime() >= (params?.start as Date).getTime();
        case "e.createdAt <= :end":
          return r.createdAt.getTime() <= (params?.end as Date).getTime();
        case "e.status = :s":
          return r.status === (params?.s as ExecutionStatus);
        case "e.status = :status":
          return r.status === (params?.status as ExecutionStatus);
        case "e.duration IS NOT NULL":
          return r.duration !== null;
        case "t.projectId = :projectId":
          return taskProjects.get(r.taskId) === (params?.projectId as string);
        case "(t.projectId IS NULL OR t.projectId = :defaultPid)": {
          const pid = taskProjects.get(r.taskId);
          return pid == null || pid === (params?.defaultPid as string);
        }
        // 趋势的 `NOW() - interval` 只做形状断言：测试行都在 7 天窗口内。
        case "e.createdAt >= NOW() - CAST(:days || ' days' AS INTERVAL)":
          return true;
        default:
          return true;
      }
    });

  const filtered = () => rows.filter(matches);

  const rawMany = () => {
    const grouped = new Map<
      string,
      { date: string; status: ExecutionStatus; count: number }
    >();
    for (const r of filtered()) {
      const date = r.createdAt.toISOString().slice(0, 10);
      const key = mode === "trend" ? `${date}|${r.status}` : r.status;
      const hit = grouped.get(key) ?? { date, status: r.status, count: 0 };
      hit.count += 1;
      grouped.set(key, hit);
    }
    return [...grouped.values()].map((g) =>
      mode === "trend"
        ? {
            day: new Date(`${g.date}T00:00:00.000Z`),
            status: g.status,
            count: String(g.count),
          }
        : { status: g.status, count: String(g.count) },
    );
  };

  const rawOne = () => {
    const durations = filtered()
      .map((r) => r.duration)
      .filter((d): d is number => d !== null);
    if (durations.length === 0) return { avg: null, max: null, min: null };
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    return {
      avg: String(avg),
      max: String(Math.max(...durations)),
      min: String(Math.min(...durations)),
    };
  };

  const qb: Record<string, unknown> = {
    conds,
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    leftJoin: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      conds.push({ sql, params });
      return qb;
    }),
    getCount: jest.fn(async () => filtered().length),
    getRawMany: jest.fn(async () => rawMany()),
    getRawOne: jest.fn(async () => rawOne()),
  };
  return qb;
}

function makeService(
  taskRepo: unknown,
  execRepo: unknown,
  reportRepo: unknown,
) {
  return new MetricsService(
    taskRepo as never,
    execRepo as never,
    { count: jest.fn().mockResolvedValue(0) } as never,
    reportRepo as never,
    {} as never,
    { getSnapshot: jest.fn() } as never,
    { get: jest.fn() } as never,
  );
}

const sqlOf = (qb: unknown) =>
  (qb as { conds: Cond[] }).conds.map((c) => c.sql);

describe("DATAOPS：Dashboard / 日报统计口径统一（synthetic + deleted 任务）", () => {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const today = new Date(todayStart.getTime() + 1_000);
  const old = new Date(now.getTime() - 40 * 86_400_000);

  it("getSummary：synthetic 行不进今日次数/total/successRate/avg，deleted 任务不进 totalTasks", async () => {
    const rows = [
      exec("real-success", ExecutionStatus.SUCCESS, false, today, 100, "t1"),
      exec("real-failed", ExecutionStatus.FAILED, false, today, 200, "t1"),
      // scheduler 超时回收与回调超时同口径：两者都落失败桶。
      exec("real-timeout", ExecutionStatus.TIMEOUT, false, today, 300, "t1"),
      exec("synth-success", ExecutionStatus.SUCCESS, true, today, 9999, "t1"),
      exec("old-real", ExecutionStatus.SUCCESS, false, old, 300, "t1"),
    ];
    const tasks = [
      { id: "t1", status: TaskStatus.ACTIVE, deletedAt: null },
      { id: "t2", status: TaskStatus.PAUSED, deletedAt: null },
      { id: "t3", status: TaskStatus.DELETED, deletedAt: null },
      { id: "t4", status: TaskStatus.DELETED, deletedAt: new Date() },
    ];
    const taskRepo = {
      count: jest.fn(async (opts: { where: Record<string, unknown> }) => {
        const op = opts.where.status as { type?: string; value?: string };
        return tasks.filter((t) =>
          op?.type === "not" ? t.status !== op.value : true,
        ).length;
      }),
    };
    const execRepo = {
      count: jest.fn(async (opts: { where: Record<string, unknown> }) => {
        const since = (opts.where.createdAt as { value: Date }).value.getTime();
        return rows.filter(
          (r) => r.synthetic === false && r.createdAt.getTime() >= since,
        ).length;
      }),
      createQueryBuilder: jest.fn(),
    };
    const statsQb = makeQb(rows, "stats");
    const avgQb = makeQb(rows, "avg");
    execRepo.createQueryBuilder
      .mockReturnValueOnce(statsQb)
      .mockReturnValueOnce(avgQb);

    const result = await makeService(taskRepo, execRepo, {}).getSummary();

    expect(taskRepo.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: expect.objectContaining({
          type: "not",
          value: TaskStatus.DELETED,
        }),
      }),
    });
    expect(result.totalTasks).toBe(2); // 两条 DELETED（含 deletedAt 为空）都被排除
    expect(result.todayRuns).toBe(3); // 合成 success 不算一次执行
    expect(result.executions).toEqual({
      total: 3,
      success: 1,
      failed: 2, // FAILED + TIMEOUT，不单点 status='failed'
      running: 0,
    });
    expect(result.successRate).toBe(33.33);
    expect(result.avgDurationMs).toBe(100); // 合成行的 9999 不进平均
    expect(sqlOf(statsQb)).toContain("e.synthetic = false");
    expect(sqlOf(avgQb)).toContain("e.synthetic = false");
  });

  it("countTodayRuns 带项目上下文：同样排除 synthetic，且只数目标项目", async () => {
    const rows = [
      exec("p1-real", ExecutionStatus.SUCCESS, false, today, 10, "t-p1"),
      exec("p1-synth", ExecutionStatus.CANCELLED, true, today, 999, "t-p1"),
      exec("p2-real", ExecutionStatus.SUCCESS, false, today, 20, "t-p2"),
    ];
    const taskProjects = new Map([
      ["t-p1", "p1"],
      ["t-p2", "p2"],
    ]);
    const taskRepo = { count: jest.fn().mockResolvedValue(1) };
    const execRepo = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    const countQb = makeQb(rows, "count", taskProjects);
    const statsQb = makeQb(rows, "stats", taskProjects);
    const avgQb = makeQb(rows, "avg", taskProjects);
    execRepo.createQueryBuilder
      .mockReturnValueOnce(countQb)
      .mockReturnValueOnce(statsQb)
      .mockReturnValueOnce(avgQb);

    const result = await makeService(taskRepo, execRepo, {}).getSummary("p1");

    expect(result.todayRuns).toBe(1);
    expect(execRepo.count).not.toHaveBeenCalled();
    expect(sqlOf(countQb)).toContain("e.synthetic = false");
    expect(sqlOf(countQb)).toContain("t.projectId = :projectId");
  });

  it("getDailyTrend：趋势桶按真实执行聚合，合成 cancelled/success 不落桶", async () => {
    const rows = [
      exec("real-success", ExecutionStatus.SUCCESS, false, today, 10, "t1"),
      exec("synth-success", ExecutionStatus.SUCCESS, true, today, 999, "t1"),
      exec("real-failed", ExecutionStatus.FAILED, false, today, 20, "t1"),
      exec("real-timeout", ExecutionStatus.TIMEOUT, false, today, 30, "t1"),
      exec(
        "synth-cancelled",
        ExecutionStatus.CANCELLED,
        true,
        today,
        null,
        "t1",
      ),
    ];
    const qb = makeQb(rows, "trend");
    const execRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };

    const result = await makeService({}, execRepo, {}).getDailyTrend(7);

    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(1);
    expect(result[0].failed).toBe(1);
    expect(result[0].timeout).toBe(1); // failed|timeout 告警口径
    expect(sqlOf(qb)).toContain("e.synthetic = false");
  });

  it("generateReport：时长聚合与计数同口径，合成 success 不抬平均时长", async () => {
    const rows = [
      exec("real-success", ExecutionStatus.SUCCESS, false, today, 100, "t1"),
      exec("synth-success", ExecutionStatus.SUCCESS, true, today, 9999, "t1"),
    ];
    const statsQb = makeQb(rows, "stats");
    const durationQb = makeQb(rows, "duration");
    const execRepo = { createQueryBuilder: jest.fn() };
    execRepo.createQueryBuilder
      .mockReturnValueOnce(statsQb)
      .mockReturnValueOnce(durationQb);
    const reportRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (v: unknown) => v),
    };

    const report = await makeService({}, execRepo, reportRepo).generateReport(
      todayStart,
    );

    expect(report.successCount).toBe(1);
    expect(report.avgDurationMs).toBe(100);
    expect(sqlOf(statsQb)).toContain("e.synthetic = false");
    expect(sqlOf(durationQb)).toContain("e.synthetic = false");
  });
});
