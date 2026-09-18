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

  /**
   * SEC-CFG-01（本轮审计）：配置控制器此前只有写路由带 @Roles(ADMIN)，
   * 通用读路由（GET /config、/config/:key、/config/history、
   * /config/history/:key）裸奔——任何已认证用户都能拉取整个配置存储，
   * 唯一屏障是逐键 opt-in 的 isSecret 掩码，而 ai.openaiBaseUrl /
   * ai.ollamaHost 这类记录内网拓扑的键并未标记 secret。
   *
   * 这里做**结构性**断言（遍历原型链上的所有路由处理器），而不是逐个点名：
   * 将来任何人新增一条配置路由而忘了 @Roles，本用例会直接变红。
   */
  it("SEC-CFG-01: every route handler on the controller is ADMIN-gated", () => {
    const proto = ConfigController.prototype as unknown as Record<
      string,
      unknown
    >;
    const paths = Reflect.getMetadata("path", ConfigController) as
      string | undefined;
    expect(paths).toBeDefined();

    const handlers = Object.getOwnPropertyNames(proto).filter((name) => {
      if (name === "constructor") return false;
      const fn = proto[name];
      if (typeof fn !== "function") return false;
      // 只取真正的路由处理器：@Get/@Post/@Put/@Patch/@Delete 会写入
      // PATH_METADATA 与 METHOD_METADATA
      return (
        Reflect.getMetadata("path", fn) !== undefined &&
        Reflect.getMetadata("method", fn) !== undefined
      );
    });

    // 防御：确保真的扫到了路由（否则断言会因 0 个处理器而空过）
    expect(handlers.length).toBeGreaterThanOrEqual(8);

    /**
     * G-1 具名豁免：`getRuntimeVersion`（GET /config/runtime-version）。
     *
     * 该端点返回的是**契约常量**（runtime-version.util 的 getSupportedRange() 与
     * interpreter-match.util 的 LEGACY_DEFAULT_INTERPRETERS），不读系统配置存储，
     * 没有 secret 可泄——SEC-CFG-01 要防的是"任何已认证用户拉取整个配置存储"，
     * 与此端点无关。反过来，任何能建任务的用户都需要在表单里读到正确的版本
     * 区间，加 ADMIN 会让非管理员的区间提示退回前端硬编码（正是 G-1 要消灭的
     * 漂移）。故刻意不加 @Roles。
     *
     * 守门效力不变：**除本名外**的任何新增路由仍须 ADMIN-gated，否则本用例红。
     * 下面一行断言豁免名真实存在，防止方法重命名后留下一个空豁免。
     */
    const RUNTIME_VERSION_UNGATED = "getRuntimeVersion";
    expect(handlers).toContain(RUNTIME_VERSION_UNGATED);

    const ungated = handlers.filter((name) => {
      if (name === RUNTIME_VERSION_UNGATED) return false;
      const roles = Reflect.getMetadata(ROLES_KEY, proto[name]) as
        UserRole[] | undefined;
      return !roles || !roles.includes(UserRole.ADMIN);
    });
    expect(ungated).toEqual([]);
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
