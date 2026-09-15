import {
  INestApplication,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import { RegistryController } from "../registry.controller";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { AuditService } from "../../audit/audit.service";
import { ConfigService } from "@nestjs/config";

/**
 * A7（DEEP_REVIEW §七「registry 面收敛」）：私有 PyPI 上传面的 RBAC + 审计矩阵。
 *
 * 背景：上传端点此前是 `scope: "authenticated"`——**任意已登录用户都能往私有
 * PyPI 传包**，而任务的 `requirements` 正是从这个私服 `uv pip install`。任何
 * 账号抢注/覆盖一个内部包名，就能让下游所有引用它的任务装到攻击者的代码
 * （评审点名的「任务依赖投毒面」，A2 审计再次确认并如实登记）。
 *
 * 本 spec 钉住三件事：角色门控真的在 HTTP 层生效、包名字段有字符级白名单、
 * 每次上传（成功与失败）都留下可追溯的审计。
 */

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

const trackSockets = (server: http.Server) => {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return () => sockets.forEach((s) => s.destroy());
};

describe("RegistryController — A7 PyPI 上传面收敛", () => {
  it("上传处理器声明 UserRole.ADMIN（去掉 @Roles 本例即红）", () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        RegistryController.prototype.uploadPypiPackage,
      ),
    ).toEqual([UserRole.ADMIN]);
  });

  describe("HTTP 授权矩阵 + 审计", () => {
    let app: INestApplication;
    let upstream: http.Server;
    let destroyAll: () => void;
    let port: number;
    let statusCode = 200;
    const auditLog = jest.fn().mockResolvedValue(undefined);

    // 只 mock 认证，走**真实的**全局 RolesGuard（与 config.controller.rbac 同款）。
    const jwtGuard = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const role = req.headers["x-test-role"];
        if (!role) throw new UnauthorizedException();
        req.user = {
          id: 42,
          username: "tester",
          email: "tester@example.com",
          role,
          isActive: true,
        };
        return true;
      },
    };

    beforeAll(async () => {
      upstream = http.createServer((_req, res) => {
        res.writeHead(statusCode, { "Content-Type": "text/plain" });
        res.end(statusCode < 400 ? "ok" : "rejected");
      });
      destroyAll = trackSockets(upstream);
      port = await listen(upstream);

      const module = await Test.createTestingModule({
        controllers: [RegistryController],
        providers: [
          {
            provide: ConfigService,
            useValue: new ConfigService({
              PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
              REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
            }),
          },
          { provide: AuditService, useValue: { log: auditLog } },
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
      await app.close();
      destroyAll();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    beforeEach(() => {
      auditLog.mockClear();
      statusCode = 200;
    });

    const upload = (role?: string, name = "pkg", version = "1.0.0") => {
      const req = request(app.getHttpServer())
        .post("/registry/pypi/upload")
        .field("name", name)
        .field("version", version)
        .attach("content", Buffer.from("fake-wheel-bytes"), "pkg-1.0.0.whl");
      if (role) req.set("x-test-role", role);
      return req;
    };

    it("未认证 → 401（JwtAuthGuard）", async () => {
      const res = await upload(undefined);
      expect(res.status).toBe(401);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("普通 user → 403（真实 RolesGuard），且**不**落审计（没发生上传）", async () => {
      const res = await upload(UserRole.USER);
      expect(res.status).toBe(403);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("admin → 放行，并落一条 success 审计（记下是谁、传了哪个包）", async () => {
      const res = await upload(UserRole.ADMIN);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ success: true });

      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 42,
          username: "tester",
          action: "registry.pypi.upload",
          resource: "registry-package",
          resourceId: "pkg==1.0.0",
          result: "success",
        }),
      );
      expect(auditLog.mock.calls[0][0].detail).toMatchObject({
        filename: "pkg-1.0.0.whl",
      });
    });

    it("admin + 上游失败 → 落一条 failure 审计（失败同样要可追溯）", async () => {
      statusCode = 500;
      const res = await upload(UserRole.ADMIN);
      expect(res.status).toBe(502);

      expect(auditLog).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "registry.pypi.upload",
          result: "failure",
        }),
      );
      expect(auditLog.mock.calls[0][0].detail.error).toBeTruthy();
    });

    it("admin 但包名非法 → 400，且**不**落审计（请求在触碰上游前就被拒）", async () => {
      const res = await upload(UserRole.ADMIN, "../../etc/passwd");
      expect(res.status).toBe(400);
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("admin 但版本号非法 → 400（PEP 440 字符白名单）", async () => {
      const res = await upload(UserRole.ADMIN, "pkg", "1.0.0; rm -rf /");
      expect(res.status).toBe(400);
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  describe("审计写入失败的行为（取舍）", () => {
    it("审计抛错**不**阻断上传，但必须 error 级留痕（静默吞掉 = 审计形同虚设）", async () => {
      const upstream = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      const destroyAll = trackSockets(upstream);
      const port = await listen(upstream);

      const auditLog = jest.fn().mockRejectedValue(new Error("audit db down"));
      const jwtGuard = {
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          req.user = {
            id: 7,
            username: "ops",
            role: UserRole.ADMIN,
            isActive: true,
          };
          return true;
        },
      };

      const module = await Test.createTestingModule({
        controllers: [RegistryController],
        providers: [
          {
            provide: ConfigService,
            useValue: new ConfigService({
              PYPI_REGISTRY_URL: `http://127.0.0.1:${port}`,
              REGISTRY_UPLOAD_TIMEOUT_MS: "3000",
            }),
          },
          { provide: AuditService, useValue: { log: auditLog } },
          { provide: APP_GUARD, useValue: jwtGuard },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue(jwtGuard)
        .compile();

      const app = module.createNestApplication();
      await app.init();

      const errorSpy = jest
        .spyOn(
          (
            app.get(RegistryController) as unknown as {
              logger: { error: (...a: unknown[]) => void };
            }
          ).logger,
          "error",
        )
        .mockImplementation(() => undefined);

      const res = await request(app.getHttpServer())
        .post("/registry/pypi/upload")
        .set("x-test-role", UserRole.ADMIN)
        .field("name", "pkg")
        .field("version", "2.0.0")
        .attach("content", Buffer.from("bytes"), "pkg-2.0.0.whl");

      // 上传本身照常成功（DB 抖动不该让运维传不了包）
      expect(res.status).toBe(201);
      expect(auditLog).toHaveBeenCalledTimes(1);
      // 但审计失败必须被看见
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/audit/i);

      await app.close();
      destroyAll();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
  });
});
