import { Response } from "express";
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { ArtifactsController } from "../artifacts.controller";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { AuditService } from "../../audit/audit.service";

const fakeSha =
  "9d06d8cd98ef94ef4f49c7d3d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e";

const makeSvc = () =>
  ({
    assertArtifactReadable: jest.fn().mockResolvedValue(undefined),
    openArtifact: jest.fn().mockResolvedValue({
      stream: { on: jest.fn() },
      fileSize: 11,
      contentType: "text/csv",
      sha256: fakeSha,
    }),
  }) as unknown as ConstructorParameters<typeof ArtifactsController>[0] & {
    assertArtifactReadable: jest.Mock;
    openArtifact: jest.Mock;
  };

const makeRes = () => ({ setHeader: jest.fn() }) as unknown as Response;

/**
 * E-P2-P6：下载路由必须在响应头下发实际字节 sha256（X-SHA256）。
 * 这里只钉「controller 把 svc 返回的 sha256 写进 X-SHA256 响应头」这一契约，
 * 字节回环由 artifacts.service.spec 覆盖。
 */
describe("ArtifactsController.download（E-P2-P6 X-SHA256 头）", () => {
  it("把 openArtifact 返回的 sha256 写入 X-SHA256 响应头", async () => {
    const svc = makeSvc();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new ArtifactsController(
      svc as never,
      audit as unknown as AuditService,
    );

    const res = makeRes();

    await expect(
      controller.download("exec-1", "report.csv", res, {
        username: "root",
      } as never),
    ).resolves.toBeUndefined();

    expect(svc.openArtifact).toHaveBeenCalledWith("exec-1", "report.csv");
    expect(res.setHeader).toHaveBeenCalledWith("X-SHA256", fakeSha);
  });
});

/**
 * GCO §5：产物清单/下载/索引三个读端点从 ADMIN-only 改为任意登录用户可达；
 * 归属收窄由 ArtifactsService 按 viewer 执行（U1 只见自己/editor+项目、无主
 * 不可见、ADMIN 全量——见 artifacts-ownership.spec.ts 的副作用断言）。
 * 上传机器通道仍不带 @Roles，token 凭据权威不变。
 * download 成功路径仍落 artifact.download 审计（best-effort）。
 */
describe("ArtifactsController（GCO §5 归属读面 + 下载审计）", () => {
  const guard = new RolesGuard(new Reflector());
  const ctxWith = (
    handler: (...args: any[]) => unknown,
    role: UserRole,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => ArtifactsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it("三读端点不声明 @Roles —— 任意登录用户可达", () => {
    for (const name of ["listArtifactRows", "list", "download"] as const) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          ArtifactsController.prototype[
            name as keyof typeof ArtifactsController.prototype
          ] as unknown as object,
        ),
      ).toBeUndefined();
    }
  });

  it("RolesGuard 对三读端点放行普通用户与 ADMIN；归属由 service 收窄", () => {
    for (const name of ["listArtifactRows", "list", "download"] as const) {
      const handler = ArtifactsController.prototype[
        name as keyof typeof ArtifactsController.prototype
      ] as unknown as (...args: any[]) => unknown;
      expect(guard.canActivate(ctxWith(handler, UserRole.USER))).toBe(true);
      expect(guard.canActivate(ctxWith(handler, UserRole.ADMIN))).toBe(true);
    }
  });

  it("upload (executor machine channel) carries no @Roles — token credential stays authoritative", () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ArtifactsController.prototype[
          "upload" as keyof typeof ArtifactsController.prototype
        ] as unknown as object,
      ),
    ).toBeUndefined();
  });

  it("download 成功路径落 artifact.download 审计（含 execId/name 与操作人）", async () => {
    const svc = makeSvc();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new ArtifactsController(
      svc as never,
      audit as unknown as AuditService,
    );

    await controller.download("exec-1", "report.csv", makeRes(), {
      username: "root",
    } as never);

    expect(svc.assertArtifactReadable).toHaveBeenCalledWith(
      "exec-1",
      expect.objectContaining({ username: "root" }),
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "artifact.download",
        resource: "artifact",
        resourceId: "exec-1/report.csv",
        username: "root",
      }),
    );
  });

  it("audit 写失败不阻断下载（best-effort，仅 warn）", async () => {
    const svc = makeSvc();
    const audit = {
      log: jest.fn().mockRejectedValue(new Error("audit db down")),
    };
    const controller = new ArtifactsController(
      svc as never,
      audit as unknown as AuditService,
    );

    await expect(
      controller.download("exec-1", "report.csv", makeRes(), {
        username: "root",
      } as never),
    ).resolves.toBeUndefined();
    // 流照常进入下发阶段
    expect(svc.openArtifact).toHaveBeenCalledTimes(1);
  });

  it("AuditService 缺席（@Optional 存量装配）时下载不受影响", async () => {
    const svc = makeSvc();
    const controller = new ArtifactsController(svc as never, undefined);
    await expect(
      controller.download("exec-1", "report.csv", makeRes(), undefined),
    ).resolves.toBeUndefined();
    expect(svc.openArtifact).toHaveBeenCalledTimes(1);
  });
});
