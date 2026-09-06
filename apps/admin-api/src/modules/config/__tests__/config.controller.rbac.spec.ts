import {
  INestApplication,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { ConfigController } from "../config.controller";
import { SystemConfigService } from "../config.service";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

/**
 * FEAT-08: POST /config/history/:id/rollback rewrites real config values —
 * it must stay ADMIN-only (same posture as the other config write endpoints).
 *
 * Matrix: unauthenticated → 401 (JwtAuthGuard), plain user → 403
 * (real global RolesGuard, service untouched), admin → 2xx happy path.
 */
describe("ConfigController — FEAT-08 rollback RBAC matrix", () => {
  it("rollback handler declares UserRole.ADMIN", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, ConfigController.prototype.rollback),
    ).toEqual([UserRole.ADMIN]);
  });

  describe("HTTP authorization matrix", () => {
    let app: INestApplication;
    const rollback = jest.fn();

    // Mock only authentication; exercise the real global role guard and Nest
    // HTTP errors (same harness as the executor W2 RBAC matrix spec).
    const jwtGuard = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const role = req.headers["x-test-role"];
        if (!role) throw new UnauthorizedException();
        req.user = { role };
        return true;
      },
    };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [ConfigController],
        providers: [
          {
            provide: SystemConfigService,
            useValue: {
              rollback,
              findAll: jest.fn().mockResolvedValue([]),
              findOne: jest.fn(),
              getByPrefix: jest.fn().mockResolvedValue([]),
              getByTag: jest.fn().mockResolvedValue([]),
              getHistory: jest.fn().mockResolvedValue({ data: [], total: 0 }),
              getSecretKeys: jest.fn().mockResolvedValue(new Set()),
            },
          },
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

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      rollback.mockReset();
    });

    it("403 to a plain user, service untouched", async () => {
      await request(app.getHttpServer())
        .post("/config/history/1/rollback")
        .set("x-test-role", UserRole.USER)
        .expect(403);
      expect(rollback).not.toHaveBeenCalled();
    });

    it("401 without authentication", async () => {
      await request(app.getHttpServer())
        .post("/config/history/1/rollback")
        .expect(401);
      expect(rollback).not.toHaveBeenCalled();
    });

    it("201 to an admin, service called with the parsed id and operator options", async () => {
      rollback.mockResolvedValueOnce({ key: "k1", value: "v1" });
      await request(app.getHttpServer())
        .post("/config/history/7/rollback")
        .set("x-test-role", UserRole.ADMIN)
        .expect(201);
      expect(rollback).toHaveBeenCalledWith(7, expect.anything());
    });
  });
});
