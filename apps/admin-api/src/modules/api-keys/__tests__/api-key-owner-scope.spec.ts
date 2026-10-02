import { TaskService } from "../../task/task.service";
import { ApiKeyUser } from "../../../common/interfaces/auth-user.interface";

/**
 * A-6（R3-A 审计）: API-Key 主体绕过 TASK_OPERATE_SCOPE=owner 的专项回归。
 *
 * 旧形态：task.service.assertCanOperate 的属主分支与放行兜底都读 `user?.id`，
 * 而 ApiKeyUser 只有 userId —— 两条判定被同时跳过，trigger/manage scope 的
 * key 无视 owner 收紧触发任意任务。修复：属主判定与放行兜底按
 * `user?.id ?? user?.userId` 归一主体 id。
 *
 * 归属说明：行为面在 task.service（修复清单 A-6 点名行 992/1003），spec 落在
 * api-keys 域（本文件）——构造形态对齐 task/__tests__/task-owner-guard.spec.ts
 * 的「纯守卫最小桩」先例，不触碰 task 模块的任何其他文件。
 */
describe("A-6 assertCanOperate — ApiKeyUser 按 key 属主参与 owner scope 判定", () => {
  const makeService = (
    operateScope: string,
    resolveRole: jest.Mock,
  ): TaskService =>
    new TaskService(
      {} as never, // taskRepo
      {} as never, // execRepo
      {} as never, // logLineRepo
      {} as never, // versionRepo
      { add: jest.fn() } as never, // taskQueue
      {} as never, // dataSource
      { stop: jest.fn(), scheduleOne: jest.fn() } as never, // schedulerService
      {} as never, // aiService
      {} as never, // aiAnalysisService
      { get: jest.fn().mockReturnValue(operateScope) } as never, // configService
      {} as never, // executorService
      { emit: jest.fn(), on: jest.fn(), off: jest.fn() } as never, // eventBus
      null as never, // secretsCrypto
      null as never, // tracing
      null as never, // reportRepo
      null as never, // projectRepo
      { hasProjectRole: jest.fn(), resolveRole } as never, // projectAccess
      null as never, // audit
    );

  const row = { ownerUserId: 7, projectId: "p1" };

  const apiKeyUser = (userId: number): ApiKeyUser => ({
    type: "apiKey",
    userId,
    keyPrefix: "acf_dead",
    apiKeyId: 7,
    scope: "trigger",
  });

  it("owner 档：API-Key 属主（userId === ownerUserId）→ 放行", async () => {
    const resolveRole = jest.fn();
    const svc = makeService("owner", resolveRole);
    await expect(
      svc.assertCanOperate(
        { ownerUserId: 42, projectId: "p1" },
        apiKeyUser(42),
      ),
    ).resolves.toBeUndefined();
    // 属主短路，不查项目角色
    expect(resolveRole).not.toHaveBeenCalled();
  });

  it("owner 档：API-Key 非属主且非项目成员 → 403（旧实现放行 = 绕过收紧）", async () => {
    const svc = makeService(
      "owner",
      jest.fn().mockResolvedValue(null), // 非成员
    );
    await expect(svc.assertCanOperate(row, apiKeyUser(42))).rejects.toThrow(
      /TASK_OPERATE_SCOPE=owner/,
    );
  });

  it("owner 档：API-Key 属主在项目内为 editor → 经项目角色放行", async () => {
    const resolveRole = jest.fn().mockResolvedValue("editor");
    const svc = makeService("owner", resolveRole);
    await expect(
      svc.assertCanOperate(row, apiKeyUser(42)),
    ).resolves.toBeUndefined();
    expect(resolveRole).toHaveBeenCalledWith(42, "p1");
  });

  it("owner 档：API-Key 属主在项目内为 viewer → 403（viewer 硬约束不因 key 放宽）", async () => {
    const svc = makeService("owner", jest.fn().mockResolvedValue("viewer"));
    await expect(svc.assertCanOperate(row, apiKeyUser(42))).rejects.toThrow(
      /TASK_OPERATE_SCOPE=owner/,
    );
  });

  it("any 档：API-Key 按归一 id 参与项目角色 viewer 拒绝（放行兜底不再跳过 key 主体）", async () => {
    const svc = makeService("any", jest.fn().mockResolvedValue("viewer"));
    await expect(svc.assertCanOperate(row, apiKeyUser(42))).rejects.toThrow(
      /viewer/,
    );
  });

  it("any 档：非成员 API-Key 维持放行（宽松档行为逐字节保留）", async () => {
    const svc = makeService("any", jest.fn().mockResolvedValue(null));
    await expect(
      svc.assertCanOperate(row, apiKeyUser(42)),
    ).resolves.toBeUndefined();
  });

  it("回归：JWT 用户（id 形态）行为不变 —— 属主放行 / 非成员 403 / ADMIN 短路", async () => {
    const ownerSvc = makeService("owner", jest.fn());
    await expect(
      ownerSvc.assertCanOperate({ ownerUserId: 8, projectId: "p1" }, {
        id: 8,
        role: "user",
      } as never),
    ).resolves.toBeUndefined();

    const noneSvc = makeService("owner", jest.fn().mockResolvedValue(null));
    await expect(
      noneSvc.assertCanOperate(row, { id: 8, role: "user" } as never),
    ).rejects.toThrow(/TASK_OPERATE_SCOPE=owner/);

    const adminSvc = makeService("owner", jest.fn());
    await expect(
      adminSvc.assertCanOperate(row, { id: 8, role: "admin" } as never),
    ).resolves.toBeUndefined();
  });

  it("回归：user 为 null（内部/机器调用）维持既有旁路", async () => {
    const svc = makeService("owner", jest.fn());
    await expect(svc.assertCanOperate(row, null)).resolves.toBeUndefined();
  });
});
