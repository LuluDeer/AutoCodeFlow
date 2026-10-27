import { ServiceUnavailableException } from "@nestjs/common";
import { ProjectAccessService } from "../../project/project-access.service";
import { TaskService } from "../task.service";
import { TaskStatus } from "../entities/task.entity";
import { UserRole } from "../../users/entities/user.entity";

/**
 * R32-B1：把「权限判定失败」从 fail-open 改为 fail-closed（只针对执行类写面）。
 *
 * ## 缺陷现场（改动前的完整链路）
 * 1. `ProjectAccessService.resolveRole` 在 `project_members` 查询抛错时
 *    `logger.warn` 后 **`return null`**（project-access.service.ts:64-71）；
 * 2. `TaskService.assertCanOperate` 把它当角色用（task.service.ts:1091）；
 * 3. `if (role === "viewer")` 不成立（null ≠ "viewer"）→ 函数自然返回 = **放行**
 *    （task.service.ts:1095-1098）。
 * ⇒ 数据库抖动的那十几秒里，viewer 拒绝不触发，trigger/pause/resume/rollback
 *   按既有宽松语义对任何人放行——权限检查在故障窗口里根本不存在。
 *
 * ## 本文件钉住的契约
 * - **执行类写面**：判定不可用（三态里的 `unavailable`）→ 503
 *   `PROJECT_ROLE_UNAVAILABLE`，且**不产生任何写副作用**（不落库、不 stop 调度器）；
 * - **读面**：同一故障下 `hasProjectRole` / `resolveRole` 仍按非成员处理（false/null），
 *   不得把列表接口打成 503；
 * - **正常路径**：viewer → 403、非成员 → 既有宽松语义、editor → 放行，逐字节不变；
 * - **装配**：真实 `ProjectAccessService` 必须暴露 `resolveRoleState`，
 *   否则三态会静默退化成"永远不可用=不可能发生"的二态垫片。
 */
describe("R32-B1 执行类写面角色判定不可用 → fail-closed", () => {
  const row = { ownerUserId: 7, projectId: "p1" };
  const plainUser = { id: 8, role: UserRole.USER };

  /** 真实 ProjectAccessService（仓储可注入失败）——不是替身，链路才完整。 */
  const makeRealAccess = (findOne: jest.Mock) =>
    new ProjectAccessService({ findOne } as never, null as never);

  const failingRepo = () =>
    makeRealAccess(jest.fn().mockRejectedValue(new Error("connection reset")));

  const build = (opts: {
    access: unknown;
    scope?: "owner" | "any";
    taskRepo?: unknown;
    scheduler?: unknown;
  }) =>
    new TaskService(
      (opts.taskRepo ?? {}) as never, // 0 taskRepo
      {} as never, // 1 execRepo
      {} as never, // 2 logLineRepo
      {} as never, // 3 versionRepo
      {} as never, // 4 taskQueue
      {} as never, // 5 dataSource
      (opts.scheduler ?? {}) as never, // 6 schedulerService
      {} as never, // 7 aiService
      {} as never, // 8 aiAnalysisService
      { get: () => opts.scope ?? "owner" } as never, // 9 configService
      {} as never, // 10 executorService
      null as never, // 11 eventBus
      {} as never, // 12 secretsCrypto
      null as never, // 13 tracing
      null as never, // 14 reportRepo
      null as never, // 15 projectRepo
      opts.access as never, // 16 projectAccess
      null as never, // 17 audit
    );

  const catchError = async (fn: () => Promise<unknown>): Promise<any> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection, but the call resolved");
  };

  it("any 档（显式 TASK_OPERATE_SCOPE=any）：DB 抖动 → 503，而不是放行", async () => {
    const svc = build({ access: failingRepo(), scope: "any" });

    const err = await catchError(() => svc.assertCanOperate(row, plainUser));

    // 状态码即契约：503 让客户端「稍后重试」，403 会把它误导成「找管理员申请」。
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.errorCode).toBe("PROJECT_ROLE_UNAVAILABLE");
    expect(err.getStatus()).toBe(503);
  });

  it("默认 owner 档：DB 抖动 → 503（不是 403「你不是属主」）", async () => {
    const svc = build({ access: failingRepo(), scope: "owner" });

    const err = await catchError(() => svc.assertCanOperate(row, plainUser));

    expect(err.errorCode).toBe("PROJECT_ROLE_UNAVAILABLE");
    expect(err.getStatus()).toBe(503);
    // 方向未变（仍然拒绝），变的是"为什么"：旧代码在这里给的是属主文案。
    expect(String(err.message)).not.toContain("TASK_OPERATE_SCOPE=owner");
  });

  it("pause() 全链路：判定不可用 → 503，且不落库、不停调度器（无写副作用）", async () => {
    const taskRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: "t1",
        status: TaskStatus.ACTIVE,
        ownerUserId: 7,
        projectId: "p1",
      }),
      save: jest.fn(),
    };
    const scheduler = { stop: jest.fn() };
    const svc = build({
      access: failingRepo(),
      scope: "any",
      taskRepo,
      scheduler,
    });

    const err = await catchError(() => svc.pause("t1", plainUser));

    expect(err.errorCode).toBe("PROJECT_ROLE_UNAVAILABLE");
    expect(err.getStatus()).toBe(503);
    // 关键：门在内核之前就关上了，业务写面一步都没走。
    expect(scheduler.stop).not.toHaveBeenCalled();
    expect(taskRepo.save).not.toHaveBeenCalled();
  });

  it("ADMIN / 无主体（机器面）不参与项目角色判定 → 不因该故障 503", async () => {
    const svc = build({ access: failingRepo(), scope: "any" });
    const admin = { id: 1, role: UserRole.ADMIN };
    await expect(svc.assertCanOperate(row, admin)).resolves.toBeUndefined();
    await expect(svc.assertCanOperate(row, null)).resolves.toBeUndefined();
  });
});

describe("R32-B1 正常路径（DB 正常时 100% 行为不变）", () => {
  const row = { ownerUserId: 7, projectId: "p1" };
  const plainUser = { id: 8, role: UserRole.USER };

  const build = (role: string | null, scope: "owner" | "any"): TaskService =>
    new TaskService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => scope } as never,
      {} as never,
      null as never,
      {} as never,
      null as never,
      null as never,
      null as never,
      new ProjectAccessService(
        {
          findOne: jest.fn().mockResolvedValue(role ? { role } : null),
        } as never,
        null as never,
      ) as never,
      null as never,
    );

  it("any 档 + viewer → 仍 403 TASK_OPERATE_VIEWER_READONLY", async () => {
    const err = await build("viewer", "any")
      .assertCanOperate(row, plainUser)
      .then(() => {
        throw new Error("expected rejection");
      })
      .catch((e: any) => e);
    expect(err.errorCode).toBe("TASK_OPERATE_VIEWER_READONLY");
    expect(err.getStatus()).toBe(403);
  });

  it("any 档 + 非成员 → 仍按既有宽松语义放行", async () => {
    await expect(
      build(null, "any").assertCanOperate(row, plainUser),
    ).resolves.toBeUndefined();
  });

  it("owner 档 + editor → 放行；owner 档 + 非成员 → 仍 403 属主文案", async () => {
    await expect(
      build("editor", "owner").assertCanOperate(row, plainUser),
    ).resolves.toBeUndefined();
    await expect(
      build(null, "owner").assertCanOperate(row, plainUser),
    ).rejects.toThrow(/TASK_OPERATE_SCOPE=owner/);
  });
});

describe("R32-B1 读面保持宽容（不因权限表抖动 500/503）", () => {
  it("查询失败：hasProjectRole → false、resolveRole → null，且都不抛", async () => {
    const access = new ProjectAccessService(
      { findOne: jest.fn().mockRejectedValue(new Error("boom")) } as never,
      null as never,
    );
    const warnSpy = jest
      .spyOn(
        (access as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      )
      .mockImplementation(() => {});

    await expect(access.hasProjectRole(8, "p1", "viewer")).resolves.toBe(false);
    await expect(access.resolveRole(8, "p1")).resolves.toBeNull();
    warnSpy.mockRestore();
  });
});

describe("R32-B1 装配钉子（防三态被静默降级成二态）", () => {
  it("真实 ProjectAccessService 暴露 resolveRoleState", () => {
    const access = new ProjectAccessService(
      { findOne: jest.fn() } as never,
      null as never,
    );
    expect(typeof access.resolveRoleState).toBe("function");
  });

  it("只有二态 resolveRole 的既有替身仍可用（垫片不退化成崩溃）", async () => {
    const resolveRole = jest.fn().mockResolvedValue(null);
    const legacyAccess = { hasProjectRole: jest.fn(), resolveRole };
    const svc = new TaskService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => "any" } as never,
      {} as never,
      null as never,
      {} as never,
      null as never,
      null as never,
      null as never,
      legacyAccess as never,
      null as never,
    );

    await expect(
      svc.assertCanOperate(
        { ownerUserId: 7, projectId: "p1" },
        { id: 8, role: UserRole.USER },
      ),
    ).resolves.toBeUndefined();
    expect(resolveRole).toHaveBeenCalledWith(8, "p1");
  });
});

describe("R32-B1 残余点：任务项目归属写面（assertCanAssignProject）同样三态", () => {
  /**
   * 反证（本组的理由）：`assertCanAssignProject` 是 R32-B1 之后**唯一**还在用二态
   * `resolveRole` 的写面。DB 抖动 ⇒ null ⇒ 与「非成员」同形 ⇒ 403
   * `TASK_PROJECT_ASSIGN_FORBIDDEN`（「你没有权限」）；而真实原因是这一秒查不到，
   * 用户的 editor 权限一直都在。方向 fail-closed 没错，结论错了。
   */
  const user = { id: 8, role: UserRole.USER };

  const build = (findOneMembership: jest.Mock): TaskService =>
    new TaskService(
      {} as never, // 0 taskRepo
      {} as never, // 1 execRepo
      {} as never, // 2 logLineRepo
      {} as never, // 3 versionRepo
      {} as never, // 4 taskQueue
      {} as never, // 5 dataSource
      {} as never, // 6 schedulerService
      {} as never, // 7 aiService
      {} as never, // 8 aiAnalysisService
      { get: () => "owner" } as never, // 9 configService
      {} as never, // 10 executorService
      null as never, // 11 eventBus
      {} as never, // 12 secretsCrypto
      null as never, // 13 tracing
      null as never, // 14 reportRepo
      { findOne: jest.fn().mockResolvedValue({ id: "p1" }) } as never, // 15 projectRepo
      new ProjectAccessService(
        { findOne: findOneMembership } as never,
        null as never,
      ) as never, // 16 projectAccess
      null as never, // 17 audit
    );

  const call = (svc: TaskService): Promise<void> =>
    (
      svc as unknown as {
        assertCanAssignProject: (
          p: string,
          u: { id: number; role?: UserRole },
        ) => Promise<void>;
      }
    ).assertCanAssignProject("p1", user);

  it("DB 抖动 → 503 PROJECT_ROLE_UNAVAILABLE（不是 403「你没有权限」）", async () => {
    const svc = build(jest.fn().mockRejectedValue(new Error("connection reset")));

    const err = await call(svc).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: any) => e,
    );

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.errorCode).toBe("PROJECT_ROLE_UNAVAILABLE");
    expect(err.getStatus()).toBe(503);
  });

  it("非成员 / viewer → 仍 403 TASK_PROJECT_ASSIGN_FORBIDDEN（语义未变）", async () => {
    const none = build(jest.fn().mockResolvedValue(null));
    await expect(call(none)).rejects.toMatchObject({
      errorCode: "TASK_PROJECT_ASSIGN_FORBIDDEN",
    });

    const viewer = build(jest.fn().mockResolvedValue({ role: "viewer" }));
    await expect(call(viewer)).rejects.toMatchObject({
      errorCode: "TASK_PROJECT_ASSIGN_FORBIDDEN",
    });
  });

  it("editor / admin → 放行（正常路径逐字节不变）", async () => {
    await expect(
      call(build(jest.fn().mockResolvedValue({ role: "editor" }))),
    ).resolves.toBeUndefined();
    await expect(
      call(build(jest.fn().mockResolvedValue({ role: "admin" }))),
    ).resolves.toBeUndefined();
  });
});

