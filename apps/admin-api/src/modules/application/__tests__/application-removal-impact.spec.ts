/**
 * P0（UX-AUDIT-2026-09-21 §P0-3）：删除应用前的**影响面预览**。
 *
 * ## 为什么需要这个接口
 *
 * 删除应用的确认框此前只有「删除后无法恢复」，而真实后果有三条，其中**最危险
 * 的一条用户完全不知道**：
 *
 *   引用它的任务**不会消失**——`task.entity.ts` 的外键是 `onDelete: "SET NULL"`，
 *   删除应用只把任务的 `applicationId` 置空。于是任务照旧按 cron 调度，但代码
 *   来源已断，此后每次执行都失败（并被分类为 application_missing，见 P0-4），
 *   而排查入口（应用详情页）已经不存在了。
 *
 * 本接口让确认框能如实说出「N 个任务将失去代码来源」。
 *
 * ## 断言策略
 *
 * 关键在于"预览说的就是实际会发生的"——因此断言逐条对应 remove() 的真实行为
 * （部署行 fanout 数、本地包是否会被 unlink），而不是断言接口返回了个对象。
 * 构造参数按 ApplicationService 的真实签名（repo, moduleRef, aiService,
 * deploymentRepo?, executorService?）装配。
 */
import { ApplicationService } from "../application.service";

function makeService(
  overrides: {
    app?: Record<string, unknown>;
    deployments?: unknown[];
    tasks?: unknown[];
    taskService?: unknown;
  } = {},
) {
  const app = {
    id: "app-1",
    name: "refund-sync",
    packageUrl: "https://cdn.example.com/a.zip",
    ...overrides.app,
  };
  const repo = { findOne: jest.fn().mockResolvedValue(app) };
  const deploymentRepo = {
    find: jest.fn().mockResolvedValue(overrides.deployments ?? []),
  };
  const svc = new ApplicationService(
    repo as never,
    {} as never,
    {} as never,
    deploymentRepo as never,
    {} as never,
  );
  // 直接注入私有依赖：本用例只验 describeRemovalImpact 的聚合语义
  (svc as unknown as { _taskService: unknown })._taskService =
    overrides.taskService === undefined
      ? {
          findAll: jest
            .fn()
            .mockResolvedValue({ items: overrides.tasks ?? [] }),
        }
      : overrides.taskService;
  return { svc, repo, deploymentRepo };
}

describe("P0-3: ApplicationService.describeRemovalImpact", () => {
  it("报出引用该应用的任务数（任务不会消失，只是失去代码来源）", async () => {
    const { svc } = makeService({
      tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
    });

    const impact = await svc.describeRemovalImpact("app-1");

    expect(impact.tasksLosingSource).toBe(3);
    expect(impact.applicationName).toBe("refund-sync");
  });

  it("报出部署行数（将被 CASCADE 静默删除的回滚点）", async () => {
    const { svc } = makeService({
      deployments: [
        { id: "d1", executorId: "e1" },
        { id: "d2", executorId: "e2" },
      ],
    });

    const impact = await svc.describeRemovalImpact("app-1");

    expect(impact.deploymentCount).toBe(2);
  });

  it("远程 URL 的包不会被本地 unlink（packageFileWillBeDeleted=false）", async () => {
    const { svc } = makeService({
      app: { packageUrl: "https://cdn.example.com/a.zip" },
    });

    const impact = await svc.describeRemovalImpact("app-1");

    // 远程包不归本服务管——声称"会被删除"是误报，用户会据此做出错误判断
    expect(impact.packageFileWillBeDeleted).toBe(false);
  });

  it("任务数取不到时降级为 0，绝不因预览失败阻断删除路径", async () => {
    const { svc } = makeService({
      taskService: {
        findAll: jest.fn().mockRejectedValue(new Error("db down")),
      },
    });

    const impact = await svc.describeRemovalImpact("app-1");

    // 预览是增强不是闸门——否则一次 DB 抖动会让管理员彻底删不掉应用
    expect(impact.tasksLosingSource).toBe(0);
    expect(impact.deploymentCount).toBe(0);
  });

  it("TaskService 未接线时也返回可用结果（不抛）", async () => {
    const { svc } = makeService({ taskService: null });

    await expect(svc.describeRemovalImpact("app-1")).resolves.toMatchObject({
      applicationName: "refund-sync",
      tasksLosingSource: 0,
    });
  });
});
