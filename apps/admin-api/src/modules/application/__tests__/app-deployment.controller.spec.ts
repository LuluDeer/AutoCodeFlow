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
      Reflect.getMetadata(
        ROLES_KEY,
        AppDeploymentController.prototype.findAll,
      ),
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
