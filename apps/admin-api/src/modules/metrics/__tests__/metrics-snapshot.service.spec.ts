import { MetricsSnapshotCacheService } from "../metrics-snapshot.service";
import type { MetricsService } from "../metrics.service";

/**
 * rt-4：Dashboard 快照的跨连接复用（单飞 + 2s TTL）。
 *
 * 缺陷现场：`/metrics/stream` 每条连接每 3s 各自重跑 7 条 SQL（含两条 30 天
 * 聚合）。32 个 Dashboard Tab 就是 ~75 SQL/s，扩到白皮书建议的 300 连接是
 * 600 SQL/s——监控自己打满 DB 池。
 */
function makeMetrics() {
  return {
    getSummary: jest.fn(async () => ({ totalTasks: 1 })),
    getExecutorStats: jest.fn(async () => [{ id: "e1" }]),
    getSchedulerMetrics: jest.fn(async () => ({ queue: { waiting: 0 } })),
  };
}

describe("MetricsSnapshotCacheService（rt-4）", () => {
  it("并发请求只跑一次底层查询（单飞）", async () => {
    const metrics = makeMetrics();
    const svc = new MetricsSnapshotCacheService(
      metrics as unknown as MetricsService,
    );

    const [a, b, c] = await Promise.all([
      svc.getSnapshot(1_000),
      svc.getSnapshot(1_000),
      svc.getSnapshot(1_001),
    ]);

    expect(metrics.getSummary).toHaveBeenCalledTimes(1);
    expect(metrics.getExecutorStats).toHaveBeenCalledTimes(1);
    expect(metrics.getSchedulerMetrics).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("TTL 内复用、过期后重算", async () => {
    const metrics = makeMetrics();
    const svc = new MetricsSnapshotCacheService(
      metrics as unknown as MetricsService,
    );

    await svc.getSnapshot(1_000);
    await svc.getSnapshot(1_500); // TTL 内
    expect(metrics.getSummary).toHaveBeenCalledTimes(1);

    await svc.getSnapshot(3_001); // 超过 2s
    expect(metrics.getSummary).toHaveBeenCalledTimes(2);
  });

  it("单查询失败不阻断其余段，errors 记录失败项", async () => {
    const metrics = makeMetrics();
    metrics.getSummary.mockRejectedValueOnce(new Error("pg down"));
    const svc = new MetricsSnapshotCacheService(
      metrics as unknown as MetricsService,
    );

    const snap = await svc.getSnapshot(1_000);

    expect(snap.errors).toEqual(["summary"]);
    expect(snap.summary).toBeNull();
    expect(snap.executors).toEqual([{ id: "e1" }]);
    expect(snap.scheduler).toEqual({ queue: { waiting: 0 } });
  });

  it("invalidate 丢弃缓存（下一拍重算）", async () => {
    const metrics = makeMetrics();
    const svc = new MetricsSnapshotCacheService(
      metrics as unknown as MetricsService,
    );

    await svc.getSnapshot(1_000);
    svc.invalidate();
    await svc.getSnapshot(1_100);
    expect(metrics.getSummary).toHaveBeenCalledTimes(2);
  });
});
