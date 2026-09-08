import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { validate } from "class-validator";
import { AppDeploymentController } from "../app-deployment.controller";
import { AppDeploymentService } from "../app-deployment.service";
import { ExecutorService } from "../../executor/executor.service";
import { DeploymentHeartbeatDto } from "../dto/app-deployment.dto";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

/**
 * R1: deploy / upgrade / stop are cluster-mutating routes (they restart
 * remote processes on executors). Listing/details stay open to any
 * authenticated user. The @Public() heartbeat is a machine-to-machine
 * callback with X-Executor-Token auth — it carries no @Roles metadata
 * so the global RolesGuard skips it.
 */
describe("AppDeploymentController RBAC (R1)", () => {
  const mockSvc = () => ({
    findAll: jest.fn(),
    findById: jest.fn(),
    deploy: jest.fn(),
    upgrade: jest.fn(),
    stop: jest.fn(),
    handleHeartbeat: jest.fn(),
  });
  const mockExec = () => ({ validateExecutorToken: jest.fn() });

  let svc: ReturnType<typeof mockSvc>;
  let exec: ReturnType<typeof mockExec>;

  beforeEach(() => {
    svc = mockSvc();
    exec = mockExec();
    void new AppDeploymentController(
      svc as unknown as AppDeploymentService,
      exec as unknown as ExecutorService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it("declares @Roles(ADMIN) on every mutation route", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AppDeploymentController.prototype.deploy),
    ).toEqual([UserRole.ADMIN]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AppDeploymentController.prototype.upgrade),
    ).toEqual([UserRole.ADMIN]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AppDeploymentController.prototype.stop),
    ).toEqual([UserRole.ADMIN]);
  });

  it("does NOT restrict findAll/findById (read surface open to any authenticated user)", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AppDeploymentController.prototype.findAll),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AppDeploymentController.prototype.findById,
      ),
    ).toBeUndefined();
  });

  it("does NOT restrict heartbeat (machine-to-machine @Public route)", () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AppDeploymentController.prototype.heartbeat,
      ),
    ).toBeUndefined();
  });

  describe("RolesGuard semantics", () => {
    const guard = new RolesGuard(new Reflector());
    const ctxWith = (
      handler: (...args: unknown[]) => unknown,
      role: UserRole,
    ): ExecutionContext =>
      ({
        getHandler: () => handler,
        getClass: () => AppDeploymentController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;

    it("plain user is denied on deploy/upgrade/stop (403)", () => {
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.deploy, UserRole.USER),
        ),
      ).toBe(false);
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.upgrade, UserRole.USER),
        ),
      ).toBe(false);
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.stop, UserRole.USER),
        ),
      ).toBe(false);
    });

    it("admin passes on deploy/upgrade/stop (200 path)", () => {
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.deploy, UserRole.ADMIN),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.upgrade, UserRole.ADMIN),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.stop, UserRole.ADMIN),
        ),
      ).toBe(true);
    });

    it("plain user is allowed on findAll/findById (read surface)", () => {
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.findAll, UserRole.USER),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          ctxWith(AppDeploymentController.prototype.findById, UserRole.USER),
        ),
      ).toBe(true);
    });
  });
});

/**
 * R17: DeploymentHeartbeatDto.pid is persisted/compared as a number — it
 * must be validated as an integer (the heartbeat route is @Public with only
 * a token check, so the DTO is the last line of input validation).
 */
describe("DeploymentHeartbeatDto validation (R17)", () => {
  const base = {
    deploymentId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    status: "running",
  };
  const make = (extra: Record<string, unknown>) =>
    Object.assign(new DeploymentHeartbeatDto(), base, extra);

  it("accepts an integer pid and an omitted pid", async () => {
    expect(await validate(make({ pid: 4242 }))).toHaveLength(0);
    expect(await validate(make({}))).toHaveLength(0);
  });

  it("rejects a non-integer pid (string / float)", async () => {
    expect((await validate(make({ pid: "4242" }))).length).toBeGreaterThan(0);
    expect((await validate(make({ pid: 1.5 }))).length).toBeGreaterThan(0);
  });
});

/**
 * QA-02（coverage 第一阶段）：部署控制器的端点委托与心跳鉴权链行为。
 * RBAC 元数据与 DTO 校验已有专项 spec；本段补「调用参数进入服务 +
 * X-Executor-Token 三段校验（缺头/无执行器/错 token）+ 部署面委托」。
 */
describe("AppDeploymentController — endpoint delegation & heartbeat auth (QA-02)", () => {
  const base = {
    deploymentId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    status: "running",
  };

  const make = () => {
    const svc = {
      findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      findById: jest
        .fn()
        .mockResolvedValue({ id: "deploy-1", executorId: "exec-1" }),
      deploy: jest.fn().mockResolvedValue({ id: "deploy-1" }),
      upgrade: jest
        .fn()
        .mockResolvedValue({ id: "deploy-1", status: "upgrading" }),
      stop: jest.fn().mockResolvedValue({ id: "deploy-1", status: "stopped" }),
      handleHeartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const exec = { validateExecutorToken: jest.fn().mockResolvedValue(true) };
    const controller = new AppDeploymentController(
      svc as unknown as AppDeploymentService,
      exec as unknown as ExecutorService,
    );
    return { controller, svc, exec };
  };

  it("findAll forwards applicationId with default paging when omitted", () => {
    const { controller, svc } = make();
    controller.findAll({ applicationId: "app-1" } as any);
    expect(svc.findAll).toHaveBeenCalledWith("app-1", 1, 20, undefined);

    controller.findAll({ page: 3, pageSize: 50 } as any);
    expect(svc.findAll).toHaveBeenLastCalledWith(undefined, 3, 50, undefined);
  });

  it("findById and deploy/upgrade/stop delegate one-to-one", () => {
    const { controller, svc } = make();

    controller.findById("deploy-1");
    expect(svc.findById).toHaveBeenCalledWith("deploy-1");

    controller.deploy("app-1", { executorId: "exec-1" } as any, {
      id: 1,
      username: "alice",
    });
    expect(svc.deploy).toHaveBeenCalledWith("app-1", { executorId: "exec-1" }, {
      id: 1,
      name: "alice",
    }, { operator: "alice", triggerType: "manual" });

    // FEAT-20: upgrade 落触发来源（upgrade 语义 + JWT 用户名）
    controller.upgrade("deploy-1", { id: 1, username: "alice" });
    expect(svc.upgrade).toHaveBeenCalledWith("deploy-1", {
      operator: "alice",
      triggerType: "upgrade",
    });

    controller.stop("deploy-1");
    expect(svc.stop).toHaveBeenCalledWith("deploy-1");
  });

  it("heartbeat rejects a missing X-Executor-Token before any lookup", async () => {
    const { controller, svc, exec } = make();
    await expect(
      controller.heartbeat({ ...base } as any, undefined),
    ).rejects.toThrow("Missing X-Executor-Token header");
    expect(svc.findById).not.toHaveBeenCalled();
    expect(exec.validateExecutorToken).not.toHaveBeenCalled();
  });

  it("heartbeat rejects when the deployment has no associated executor", async () => {
    const { controller, svc, exec } = make();
    svc.findById.mockResolvedValueOnce({ id: "deploy-1", executorId: null });
    await expect(
      controller.heartbeat({ ...base } as any, "tok"),
    ).rejects.toThrow("deployment has no associated executor");
    expect(exec.validateExecutorToken).not.toHaveBeenCalled();
    expect(svc.handleHeartbeat).not.toHaveBeenCalled();
  });

  it("heartbeat rejects an invalid executor token", async () => {
    const { controller, exec, svc } = make();
    exec.validateExecutorToken.mockResolvedValueOnce(false);
    await expect(
      controller.heartbeat({ ...base } as any, "wrong-token"),
    ).rejects.toThrow("Invalid executor token");
    expect(svc.handleHeartbeat).not.toHaveBeenCalled();
  });

  it("heartbeat validates the token against the deployment's own executor then forwards", async () => {
    const { controller, exec, svc } = make();

    await controller.heartbeat({ ...base, pid: 42 } as any, "good-token");

    expect(exec.validateExecutorToken).toHaveBeenCalledWith(
      "exec-1",
      "good-token",
    );
    expect(svc.handleHeartbeat).toHaveBeenCalledWith({
      ...base,
      pid: 42,
    });
  });
});
