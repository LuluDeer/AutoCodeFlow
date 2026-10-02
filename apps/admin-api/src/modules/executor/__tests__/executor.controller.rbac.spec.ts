import {
  INestApplication,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ExecutorController } from "../executor.controller";
import { ExecutorService } from "../executor.service";
import { SystemConfigService } from "../../config/config.service";
import { ProjectAccessService } from "../../project/project-access.service";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";
// ARCH-33（ADR-016）：控制面 pull 通道的测试替身（默认 push）
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const post = jest.fn().mockResolvedValue({ data: { ok: true } });
  return {
    ...actual,
    post,
    default: { ...(actual.default ?? actual), post },
  };
});
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest.fn().mockResolvedValue(new URL("http://ok")),
  // F-3（SEC-NEW）: reloadConfig happy path 现走 assertAndPinExecutorUrl。
  assertAndPinExecutorUrl: jest
    .fn()
    .mockImplementation(async (raw: string) => ({
      url: new URL(raw),
      pinnedIp: "93.184.216.34",
      pinned: false,
    })),
}));

/**
 * N-02③（ADR-013 2026-10-02 温和下放）后的 RBAC 姿态：
 * - update / reloadConfig：**不再声明 @Roles**——判定下沉
 *   assertCanManageMetadata（ADMIN 短路，否则所属项目 editor+；projectId=null
 *   的平台级执行器仅 ADMIN）。
 * - rotateToken / setOffline / removeExecutor：仍 @Roles(ADMIN)——令牌轮换、
 *   强制下线、删除执行器是平台级敏感操作（响应含明文令牌）不下放。
 *
 * HTTP matrix per route: unauthenticated → 401 (JwtAuthGuard), 非授权 → 403
 * （update/reloadConfig 由 controller 判定抛出，其余由全局 RolesGuard），
 * admin → 2xx happy path。
 */
const N02_OWNED_ROUTES = ["update", "reloadConfig"] as const;
const ADMIN_ONLY_ROUTES = [
  "rotateToken",
  "setOffline",
  "removeExecutor",
] as const;

describe("ExecutorController — W2 RBAC matrix for management write endpoints", () => {
  describe("RBAC metadata — N-02③ split", () => {
    it.each(ADMIN_ONLY_ROUTES)(
      "%s is restricted to UserRole.ADMIN (not delegated)",
      (handler) => {
        expect(
          Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype[handler]),
        ).toEqual([UserRole.ADMIN]);
      },
    );

    it.each(N02_OWNED_ROUTES)(
      "%s declares no @Roles — judgement lives in assertCanManageMetadata (N-02③)",
      (handler) => {
        expect(
          Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype[handler]),
        ).toBeUndefined();
      },
    );
  });

  describe("HTTP authorization matrix (user 403 / anonymous 401 / admin 200)", () => {
    let app: INestApplication;

    const makeSvc = () => ({
      update: jest.fn().mockResolvedValue({ id: "e1", groupName: "prod" }),
      findOne: jest.fn().mockResolvedValue({
        id: "e1",
        address: "10.0.0.9:8001",
        appName: "executor-node",
        executorStartupId: "startup-1",
        status: ExecutorStatus.ONLINE,
        type: ExecutorType.PYTHON,
        // N-02③：null=平台级执行器（非 ADMIN 恒 403，且不得触发项目判定）。
        projectId: null as string | null,
      }),
      issueToken: jest
        .fn()
        .mockResolvedValue({ token: "issued-token", tokenHash: "$2b$12$hash" }),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://10.0.0.9:8001/api/config/reload"),
      // ARCH-33（ADR-016）：默认 push——本 spec 验证的是 RBAC 矩阵（谁被拒），
      // 与传输方式无关；保持 push 让 reload-config happy path 照旧打真实 HTTP 桩。
      ...controlPlaneMocks(),
      rotateToken: jest.fn().mockResolvedValue({
        token: "fresh-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
      setOfflineById: jest
        .fn()
        .mockResolvedValue({ id: "e1", status: "offline" }),
      removeById: jest.fn().mockResolvedValue(undefined),
      getRuntimeConfig: jest.fn().mockResolvedValue({
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMultiplier: 3,
        heartbeatTimeoutMs: 90000,
        listLimit: 500,
        executorTotal: 1,
      }),
    });

    // Mock only authentication; exercise the real global role guard and Nest
    // HTTP errors (same harness as the install-cmd DR-01 matrix spec).
    // N-02③：user 带真实 id（controller 判定用它查项目角色）。
    const jwtGuard = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const role = req.headers["x-test-role"];
        if (!role) throw new UnauthorizedException();
        req.user = { id: 7, role };
        return true;
      },
    };

    const projectAccess = {
      hasProjectRole: jest.fn().mockResolvedValue(false),
    };

    beforeEach(async () => {
      projectAccess.hasProjectRole.mockReset().mockResolvedValue(false);
      const module = await Test.createTestingModule({
        controllers: [ExecutorController],
        providers: [
          { provide: ExecutorService, useValue: makeSvc() },
          { provide: ConfigService, useValue: {} },
          { provide: SystemConfigService, useValue: {} },
          { provide: ProjectAccessService, useValue: projectAccess },
          { provide: APP_GUARD, useValue: jwtGuard },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue(jwtGuard)
        .compile();
      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
    });

    const svcOf = () =>
      app.get(ExecutorService) as unknown as ReturnType<typeof makeSvc>;

    describe("PATCH /executors/:id", () => {
      it("403 to a plain user, service untouched", async () => {
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.USER)
          .send({ groupName: "prod" })
          .expect(403);
        expect(svcOf().update).not.toHaveBeenCalled();
      });

      it("401 without authentication", async () => {
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .send({ groupName: "prod" })
          .expect(401);
        expect(svcOf().update).not.toHaveBeenCalled();
      });

      it("200 to an admin", async () => {
        const res = await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.ADMIN)
          .send({ groupName: "prod" })
          .expect(200);
        expect(res.body).toMatchObject({ id: "e1", groupName: "prod" });
        expect(svcOf().update).toHaveBeenCalledWith("e1", {
          groupName: "prod",
        });
      });
    });

    // N-02③（ADR-013 2026-10-02 温和下放）：update / reloadConfig 对所属项目
    // editor+ 放行。viewer 与非成员在判定路径同构（hasProjectRole=false，
    // viewer rank < editor）——用一个 false 桩同时覆盖两态，PROJECT_ROLE_RANK
    // 的档位语义由 project-access.service.spec 自身背书。
    describe("N-02③ delegation matrix — project editor+ on executor's own project", () => {
      const attachProject = async (projectId: string | null) => {
        const svc = svcOf() as ReturnType<typeof makeSvc>;
        svc.findOne.mockResolvedValue({
          id: "e1",
          address: "10.0.0.9:8001",
          appName: "executor-node",
          executorStartupId: "startup-1",
          status: ExecutorStatus.ONLINE,
          type: ExecutorType.PYTHON,
          projectId,
        });
      };

      it("PATCH: project editor → 200, judged with (projectId, editor)", async () => {
        await attachProject("p1");
        projectAccess.hasProjectRole.mockResolvedValue(true);
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.USER)
          .send({ groupName: "prod" })
          .expect(200);
        expect(projectAccess.hasProjectRole).toHaveBeenCalledWith(
          7,
          "p1",
          "editor",
        );
        expect(svcOf().update).toHaveBeenCalledWith("e1", {
          groupName: "prod",
        });
      });

      it("PATCH: project member below editor (viewer) / non-member → 403, service untouched", async () => {
        await attachProject("p1");
        projectAccess.hasProjectRole.mockResolvedValue(false);
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.USER)
          .send({ groupName: "prod" })
          .expect(403);
        expect(svcOf().update).not.toHaveBeenCalled();
      });

      it("PATCH: projectId=null (platform-level) → 403 without consulting project roles (no DEFAULT_PROJECT_ID fallback)", async () => {
        await attachProject(null);
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.USER)
          .send({ groupName: "prod" })
          .expect(403);
        expect(projectAccess.hasProjectRole).not.toHaveBeenCalled();
        expect(svcOf().update).not.toHaveBeenCalled();
      });

      it("PATCH: admin short-circuits without project-role lookup", async () => {
        await attachProject("p1");
        await request(app.getHttpServer())
          .patch("/executors/e1")
          .set("x-test-role", UserRole.ADMIN)
          .send({ groupName: "prod" })
          .expect(200);
        expect(projectAccess.hasProjectRole).not.toHaveBeenCalled();
      });

      it("reload-config: project editor → 201 with token issuance", async () => {
        await attachProject("p1");
        projectAccess.hasProjectRole.mockResolvedValue(true);
        await request(app.getHttpServer())
          .post("/executors/e1/reload-config")
          .set("x-test-role", UserRole.USER)
          .send({})
          .expect(201);
        expect(svcOf().issueToken).toHaveBeenCalled();
      });

      it("reload-config: non-member → 403, no token issuance / outbound push", async () => {
        await attachProject("p1");
        projectAccess.hasProjectRole.mockResolvedValue(false);
        await request(app.getHttpServer())
          .post("/executors/e1/reload-config")
          .set("x-test-role", UserRole.USER)
          .send({})
          .expect(403);
        expect(svcOf().issueToken).not.toHaveBeenCalled();
      });
    });

    describe("POST /executors/:id/reload-config", () => {
      it("403 to a plain user, no token issuance / outbound push", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/reload-config")
          .set("x-test-role", UserRole.USER)
          .send({})
          .expect(403);
        expect(svcOf().issueToken).not.toHaveBeenCalled();
      });

      it("401 without authentication", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/reload-config")
          .send({})
          .expect(401);
        expect(svcOf().issueToken).not.toHaveBeenCalled();
      });

      it("200 to an admin", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/reload-config")
          .set("x-test-role", UserRole.ADMIN)
          .send({})
          // POST without @HttpCode defaults to 201 in Nest.
          .expect(201);
        expect(svcOf().issueToken).toHaveBeenCalled();
      });
    });

    describe("POST /executors/:id/rotate-token (response carries the plaintext token)", () => {
      it("403 to a plain user, token never rotated or exposed", async () => {
        const res = await request(app.getHttpServer())
          .post("/executors/e1/rotate-token")
          .set("x-test-role", UserRole.USER)
          .expect(403);
        expect(svcOf().rotateToken).not.toHaveBeenCalled();
        expect(JSON.stringify(res.body)).not.toContain("fresh-token");
      });

      it("401 without authentication", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/rotate-token")
          .expect(401);
        expect(svcOf().rotateToken).not.toHaveBeenCalled();
      });

      it("200 (token payload) to an admin", async () => {
        const res = await request(app.getHttpServer())
          .post("/executors/e1/rotate-token")
          .set("x-test-role", UserRole.ADMIN)
          // POST without @HttpCode defaults to 201 in Nest.
          .expect(201);
        expect(res.body).toMatchObject({ token: "fresh-token" });
      });
    });

    describe("POST /executors/:id/set-offline", () => {
      it("403 to a plain user, service untouched", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/set-offline")
          .set("x-test-role", UserRole.USER)
          .expect(403);
        expect(svcOf().setOfflineById).not.toHaveBeenCalled();
      });

      it("401 without authentication", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/set-offline")
          .expect(401);
        expect(svcOf().setOfflineById).not.toHaveBeenCalled();
      });

      it("200 to an admin", async () => {
        await request(app.getHttpServer())
          .post("/executors/e1/set-offline")
          .set("x-test-role", UserRole.ADMIN)
          // POST without @HttpCode defaults to 201 in Nest.
          .expect(201);
        expect(svcOf().setOfflineById).toHaveBeenCalledWith("e1");
      });
    });

    describe("GET /executors/runtime-config (fixed segment before :id)", () => {
      // P2-5/P3-9：前端判死阈值/截断提示的事实源；同时守路由声明顺序——
      // 若该固定段被放到 @Get(":id") 之后，请求会落入 findOne("runtime-config")。
      it("401 without authentication", async () => {
        await request(app.getHttpServer())
          .get("/executors/runtime-config")
          .expect(401);
        expect(svcOf().getRuntimeConfig).not.toHaveBeenCalled();
      });

      it("200 to any logged-in user (same posture as the list endpoint)", async () => {
        const res = await request(app.getHttpServer())
          .get("/executors/runtime-config")
          .set("x-test-role", UserRole.USER)
          .expect(200);
        expect(res.body).toMatchObject({ heartbeatTimeoutMs: 90000 });
        expect(svcOf().getRuntimeConfig).toHaveBeenCalledTimes(1);
        // Route-ordering guard: the :id param route must not swallow it.
        expect(svcOf().findOne).not.toHaveBeenCalled();
      });
    });

    describe("DELETE /executors/:id", () => {
      it("403 to a plain user, service untouched", async () => {
        await request(app.getHttpServer())
          .delete("/executors/e1")
          .set("x-test-role", UserRole.USER)
          .expect(403);
        expect(svcOf().removeById).not.toHaveBeenCalled();
      });

      it("401 without authentication", async () => {
        await request(app.getHttpServer()).delete("/executors/e1").expect(401);
        expect(svcOf().removeById).not.toHaveBeenCalled();
      });

      it("204 to an admin", async () => {
        await request(app.getHttpServer())
          .delete("/executors/e1")
          .set("x-test-role", UserRole.ADMIN)
          .expect(204);
        // AUTH-05: the endpoint now forwards the (absent) optional reason —
        // a no-body DELETE calls removeById("e1", undefined).
        expect(svcOf().removeById).toHaveBeenCalledWith("e1", undefined);
      });
    });
  });

  // Machine endpoints keep the no-@Roles posture (Reflector undefined) — the
  // shared-token verifier, not RolesGuard, is their gate.
  describe("machine endpoints stay role-free", () => {
    it.each(["register", "heartbeat", "getToken", "offline"] as const)(
      "%s declares no role restriction",
      (handler) => {
        const guard = new RolesGuard(new Reflector());
        expect(
          Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype[handler]),
        ).toBeUndefined();
        const ctx = {
          getHandler: () => ExecutorController.prototype[handler],
          getClass: () => ExecutorController,
          switchToHttp: () => ({
            getRequest: () => ({ user: { role: UserRole.USER } }),
          }),
        } as any;
        expect(guard.canActivate(ctx)).toBe(true);
      },
    );
  });
});
