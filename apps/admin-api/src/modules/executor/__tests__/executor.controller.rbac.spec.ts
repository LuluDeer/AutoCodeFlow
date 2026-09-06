import {
  INestApplication,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { ExecutorController } from "../executor.controller";
import { ExecutorService } from "../executor.service";
import { SystemConfigService } from "../../config/config.service";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";

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
  assertSafeExecutorUrl: jest.fn().mockResolvedValue(new URL("http://ok")),
}));

/**
 * W2: executor management WRITE endpoints are ADMIN-only (same posture as
 * install-cmd DR-01). A plain logged-in user must never be able to rotate an
 * executor token (the response carries the plaintext token), force-offline or
 * delete an executor, or push a config hot-update.
 *
 * Matrix per route: unauthenticated → 401 (JwtAuthGuard), user → 403
 * (global RolesGuard, service untouched), admin → 2xx happy path.
 */
describe("ExecutorController — W2 RBAC matrix for management write endpoints", () => {
  const WRITE_ROUTES = [
    "update",
    "reloadConfig",
    "rotateToken",
    "setOffline",
    "removeExecutor",
  ] as const;

  describe("RBAC metadata — every write handler declares ADMIN", () => {
    it.each(WRITE_ROUTES)("%s is restricted to UserRole.ADMIN", (handler) => {
      expect(
        Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype[handler]),
      ).toEqual([UserRole.ADMIN]);
    });
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
      }),
      issueToken: jest
        .fn()
        .mockResolvedValue({ token: "issued-token", tokenHash: "$2b$12$hash" }),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://10.0.0.9:8001/api/config/reload"),
      rotateToken: jest.fn().mockResolvedValue({
        token: "fresh-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
      setOfflineById: jest
        .fn()
        .mockResolvedValue({ id: "e1", status: "offline" }),
      removeById: jest.fn().mockResolvedValue(undefined),
    });

    // Mock only authentication; exercise the real global role guard and Nest
    // HTTP errors (same harness as the install-cmd DR-01 matrix spec).
    const jwtGuard = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const role = req.headers["x-test-role"];
        if (!role) throw new UnauthorizedException();
        req.user = { role };
        return true;
      },
    };

    beforeEach(async () => {
      const module = await Test.createTestingModule({
        controllers: [ExecutorController],
        providers: [
          { provide: ExecutorService, useValue: makeSvc() },
          { provide: ConfigService, useValue: {} },
          { provide: SystemConfigService, useValue: {} },
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
        expect(svcOf().removeById).toHaveBeenCalledWith("e1");
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
