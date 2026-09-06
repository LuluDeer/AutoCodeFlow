import {
  INestApplication,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  ExecutionContext,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { createHmac } from "crypto";
import * as express from "express";
import * as fs from "fs";
import * as request from "supertest";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { AppDeploymentService } from "../app-deployment.service";
import { ApplicationController } from "../application.controller";
import { ApplicationService } from "../application.service";
import { UserRole } from "../../users/entities/user.entity";

function sign(secret: string, timestamp: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

describe("ApplicationController webhook", () => {
  const fixedNow = 1_700_000_000_000;
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
  };
  let deploymentSvc: {
    findRunningByApp: jest.Mock;
    upgrade: jest.Mock;
  };
  let controller: ApplicationController;

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    svc = {
      findByNameWithSecret: jest.fn(),
      update: jest.fn(),
    };
    deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
    };
    controller = new ApplicationController(svc as any, deploymentSvc as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("marks webhook public so CI does not need a user JWT", () => {
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        ApplicationController.prototype.webhook,
      ),
    ).toBe(true);
  });

  it("accepts a valid timestamped raw-body signature", async () => {
    const dto = {
      appName: "my-app",
      version: "1.2.0",
      triggerDeploy: false,
    };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });
    svc.update.mockResolvedValue({ id: "app-1", ...dto });

    const result = await controller.webhook(
      dto,
      sign("secret", timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );

    expect(result.ok).toBe(true);
    expect(svc.update).toHaveBeenCalledWith("app-1", {
      version: "1.2.0",
    });
  });

  it("rejects matching apps that do not have a webhook secret", async () => {
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: null,
    });

    await expect(
      controller.webhook(
        { appName: "my-app", version: "1.2.0" },
        "sha256=ignored",
        String(fixedNow),
        {
          rawBody: Buffer.from('{"appName":"my-app","version":"1.2.0"}'),
        } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when the signature header is missing", async () => {
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(
        { appName: "my-app", version: "1.2.0" },
        undefined,
        String(fixedNow),
        {
          rawBody: Buffer.from('{"appName":"my-app","version":"1.2.0"}'),
        } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when the timestamp is stale", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow - 10 * 60 * 1000);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(dto, sign("secret", timestamp, rawBody), timestamp, {
        rawBody,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when raw body capture is unavailable", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(
        dto,
        sign("secret", timestamp, rawBody),
        timestamp,
        {} as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signatures computed from a different raw body", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from('{"version":"1.2.0","appName":"my-app"}');
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(
        dto,
        sign("secret", timestamp, Buffer.from(JSON.stringify(dto))),
        timestamp,
        { rawBody } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("responds identically for unknown apps and invalid secrets (APP-001)", async () => {
    // 场景一：应用不存在（旧行为返回 200，可被用于枚举应用名）
    svc.findByNameWithSecret.mockResolvedValueOnce(null);
    const unknownError = await controller
      .webhook(
        { appName: "no-such-app", version: "1.0.0" } as any,
        "sha256=" + "0".repeat(64),
        String(fixedNow),
        {
          rawBody: Buffer.from('{"appName":"no-such-app","version":"1.0.0"}'),
        } as any,
      )
      .catch((e) => e);

    // 场景二：应用存在但签名错误
    const dto = { appName: "my-app", version: "1.2.0" };
    const signedBody = Buffer.from(JSON.stringify(dto));
    svc.findByNameWithSecret.mockResolvedValueOnce({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });
    const badSigError = await controller
      .webhook(
        dto as any,
        sign("wrong-secret", String(fixedNow), signedBody),
        String(fixedNow),
        { rawBody: signedBody } as any,
      )
      .catch((e) => e);

    expect(unknownError).toBeInstanceOf(UnauthorizedException);
    expect(badSigError).toBeInstanceOf(UnauthorizedException);
    // 状态码与响应体完全一致——“不存在应用”与“secret 错误”不可区分，防枚举
    expect(unknownError.getStatus()).toBe(badSigError.getStatus());
    expect(unknownError.getResponse()).toEqual(badSigError.getResponse());
  });

  it("returns 200 ok:false for no reason — unknown apps must never return ok (APP-001)", async () => {
    svc.findByNameWithSecret.mockResolvedValue(null);
    const result = await controller
      .webhook(
        { appName: "no-such-app", version: "1.0.0" } as any,
        undefined,
        undefined,
        { rawBody: Buffer.from("{}") } as any,
      )
      .catch((e) => e);
    // 不再出现 { ok: true, message: "No matching application" }
    expect(result).toBeInstanceOf(UnauthorizedException);
    expect(result?.ok).toBeUndefined();
  });
});

describe("ApplicationController webhook HTTP raw body", () => {
  const fixedNow = 1_700_000_000_000;
  let app: INestApplication;
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    svc = {
      findByNameWithSecret: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        webhookSecret: "secret",
      }),
      update: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        version: "1.2.0",
      }),
    };
    const deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [ApplicationController],
      providers: [
        { provide: ApplicationService, useValue: svc },
        { provide: AppDeploymentService, useValue: deploymentSvc },
      ],
    }).compile();

    app = module.createNestApplication();
    app.use(
      express.json({
        limit: "1mb",
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = Buffer.from(buf);
        },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it("verifies the exact HTTP raw JSON body, not JSON.stringify(dto)", async () => {
    const rawBody = Buffer.from('{"version":"1.2.0","appName":"my-app"}');
    const timestamp = String(fixedNow);

    await request(app.getHttpServer())
      .post("/applications/webhook")
      .set("Content-Type", "application/json")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", sign("secret", timestamp, rawBody))
      .send(rawBody.toString())
      .expect(201);

    expect(svc.update).toHaveBeenCalledWith("app-1", {
      version: "1.2.0",
    });
  });

  it("returns the same HTTP 401 body for unknown apps and bad signatures (APP-001)", async () => {
    const timestamp = String(fixedNow);
    const bogusSignature = sign("secret", timestamp, Buffer.from("other body"));

    // 应用存在但签名错误
    const badSig = await request(app.getHttpServer())
      .post("/applications/webhook")
      .set("Content-Type", "application/json")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", bogusSignature)
      .send('{"appName":"my-app","version":"1.2.0"}');
    expect(badSig.status).toBe(401);

    // 应用不存在
    svc.findByNameWithSecret.mockResolvedValueOnce(null);
    const unknown = await request(app.getHttpServer())
      .post("/applications/webhook")
      .set("Content-Type", "application/json")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", bogusSignature)
      .send('{"appName":"no-such-app","version":"1.2.0"}');
    expect(unknown.status).toBe(401);

    // 两者对外响应完全一致，无法用于枚举应用名
    expect(unknown.body).toEqual(badSig.body);
  });
});

describe("ApplicationController upload — APP-002", () => {
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let svc: {
    findByName: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let controller: ApplicationController;

  const uploadArgs = () =>
    [
      { originalname: "app.zip", buffer: ZIP_MAGIC } as Express.Multer.File,
      { name: "my-app", runtime: "python" },
    ] as const;

  beforeEach(() => {
    svc = {
      findByName: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((dto: any) =>
          Promise.resolve({ id: "app-1", name: "my-app", ...dto }),
        ),
      update: jest.fn(),
    };
    controller = new ApplicationController(svc as any, {} as any);
    // 不真实写盘
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as any);
    jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    delete process.env.API_BASE_URL;
    jest.restoreAllMocks();
  });

  it("fails fast with an explicit error when API_BASE_URL is not configured", async () => {
    delete process.env.API_BASE_URL;
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});

    await expect(controller.upload(...uploadArgs())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    // 不允许静默回退 localhost 后照常入库
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.update).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("API_BASE_URL"),
    );
  });

  it("builds packageUrl from API_BASE_URL and never from localhost", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    const app = await controller.upload(...uploadArgs());
    expect(app.packageUrl).toMatch(
      /^https:\/\/api\.example\.com\/uploads\/packages\//,
    );
    expect(app.packageUrl).not.toContain("localhost");
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        packageUrl: expect.stringContaining("https://api.example.com/"),
      }),
    );
  });
});

// R1: application lifecycle routes are admin-only. The global RolesGuard
// reads the @Roles metadata and rejects USER callers (403); ADMIN callers
// pass. The @Public() webhook carries no metadata, so it is unaffected.
describe("ApplicationController RBAC (R1)", () => {
  const guard = new RolesGuard(new Reflector());
  const ctxWith = (
    handler: (...args: unknown[]) => unknown,
    role: UserRole,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => ApplicationController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it("declares @Roles(ADMIN) on every mutation route", () => {
    const adminRoutes = [
      "create",
      "update",
      "remove",
      "upload",
      "upgradeAll",
      "syncTasks",
      "analyzeHealth",
      "rollback",
    ];
    for (const name of adminRoutes) {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          ApplicationController.prototype[name],
        ),
      ).toEqual([UserRole.ADMIN]);
    }
  });

  it("does NOT restrict findAll/findById/getVersionHistory (read surface open to any authenticated user)", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, ApplicationController.prototype.findAll),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(ROLES_KEY, ApplicationController.prototype.findById),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        ApplicationController.prototype.getVersionHistory,
      ),
    ).toBeUndefined();
  });

  it("plain user is denied (RolesGuard → 403) on every mutation route", () => {
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.create, UserRole.USER),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.update, UserRole.USER),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.remove, UserRole.USER),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.upload, UserRole.USER),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.upgradeAll, UserRole.USER),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.rollback, UserRole.USER),
      ),
    ).toBe(false);
  });

  it("admin passes on every mutation route (200 path)", () => {
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.create, UserRole.ADMIN),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.update, UserRole.ADMIN),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.remove, UserRole.ADMIN),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.upload, UserRole.ADMIN),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.rollback, UserRole.ADMIN),
      ),
    ).toBe(true);
  });
});
