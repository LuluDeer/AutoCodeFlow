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
import * as os from "os";
import * as path from "path";
import { Readable } from "node:stream";
import * as request from "supertest";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import { ApplicationController } from "../application.controller";
import { ApplicationService } from "../application.service";
import { UserRole } from "../../users/entities/user.entity";
// SEC-05: uploads are now vetted by the zip-bomb guard — tests need a real,
// structurally-valid zip (the old 4-byte magic stub fails CD parsing).
import { buildBenignZip, buildZip } from "../../../common/utils/__tests__/zip-samples";

function sign(secret: string, timestamp: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

// ARCH-27: apiBase 改经 ConfigService（app.apiBaseUrl）读取 —— spec 注入
// 桩 ConfigService；读取在调用时发生，与原 process.env 操纵的用例流兼容。
const stubConfig = (apiBase?: string) => ({
  get: (key: string) => (key === "app.apiBaseUrl" ? apiBase : undefined),
});

describe("ApplicationController webhook", () => {
  const fixedNow = 1_700_000_000_000;
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
    recordUploadVersion: jest.Mock;
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
      recordUploadVersion: jest.fn().mockResolvedValue(undefined),
    };
    deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
    };
    controller = new ApplicationController(
      svc as any,
      deploymentSvc as any,
      stubConfig() as any,
    );
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
    // NF-03: webhook 机器面带 systemBypass（HMAC 已鉴权，无 AuthUser）
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
      { version: "1.2.0" },
      undefined,
      { systemBypass: true },
    );
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
    recordUploadVersion: jest.Mock;
  };

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    svc = {
      recordUploadVersion: jest.fn().mockResolvedValue(undefined),
      findByNameWithSecret: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        // 必须是真实共享密钥：本用例用同一字面量 sign("secret", ...) 计算
        // HMAC。此处若改成占位符（如曾出现的 "[FUNC]"），签名校验必然失败，
        // 用例会在 .expect(201) 处拿到 401。
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
        // ARCH-27: webhook 路由不消费配置，注入空桩即可满足 DI。
        { provide: ConfigService, useValue: stubConfig() },
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

    // NF-03: webhook 机器面带 systemBypass（HMAC 已鉴权，无 AuthUser）
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
      { version: "1.2.0" },
      undefined,
      { systemBypass: true },
    );
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
  // O-11: the upload now uses multer diskStorage — the package arrives as an
  // on-disk temp file (file.path), not an in-memory file.buffer. These tests
  // stage a REAL structurally-valid zip (the guard parses the central
  // directory) in a temp dir, then assert the controller consumes that path:
  // head magic + assertZipFileSafe + the ClamAV stream read it, the file is
  // renamed into uploads/packages, and the staged temp file is always cleaned
  // up in finally.
  let svc: {
    findByName: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    recordUploadVersion: jest.Mock;
  };
  let controller: ApplicationController;
  let rename: jest.SpyInstance;
  let unlink: jest.SpyInstance;
  // fs.mkdirSync 在本 describe 被桩成 no-op；真实实现单独留一份引用，供
  // P1-11 用例补建落地目录（见该用例内 rename 桩的注释）。
  const realMkdirSync = fs.mkdirSync;
  let stagingDir: string;
  let stagedPath: string;

  beforeEach(() => {
    svc = {
      recordUploadVersion: jest.fn().mockResolvedValue(undefined),
      findByName: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((dto: any) =>
          Promise.resolve({ id: "app-1", name: "my-app", ...dto }),
        ),
      update: jest.fn(),
    };
    // Stub persist/landing fs calls so the repo's uploads/ dir is never
    // touched. Spied BEFORE the controller is constructed (its constructor
    // mkdirSync's the staging dir). Reads of the staged file below hit the
    // REAL file: readHeadBytes (head magic), assertZipFileSafe (CD parse) and
    // the ClamAV stream all open file.path directly.
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as any);
    rename = jest
      .spyOn(fs.promises, "rename")
      .mockResolvedValue(undefined as never);
    unlink = jest.spyOn(fs.promises, "unlink").mockResolvedValue(undefined);
    // ClamAV is disabled in these tests (CLAMD_ENABLED unset), so
    // scanStreamWithClamd returns immediately and never consumes the stream.
    // Stub the factory to a touch-less dummy stream so no real file handle is
    // opened/leaked on the staged path.
    jest
      .spyOn(fs, "createReadStream")
      .mockReturnValue(
        new Readable() as unknown as ReturnType<typeof fs.createReadStream>,
      );

    // ARCH-27: 桩在调用时读取 process.env.API_BASE_URL，保持原用例的
    // 逐用例 env 操纵方式；生产路径由 Joi 注册 + configuration.ts 提供。
    controller = new ApplicationController(
      svc as any,
      {} as any,
      { get: () => process.env.API_BASE_URL } as any,
    );

    // Stage a real temp zip on disk (mirrors multer diskStorage).
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "acf-upload-"));
    stagedPath = path.join(stagingDir, "app.zip");
    fs.writeFileSync(stagedPath, buildBenignZip());
  });

  afterEach(() => {
    delete process.env.API_BASE_URL;
    jest.restoreAllMocks();
    // The controller's unlink is mocked, so it never deletes our real staged
    // file — clean it up best-effort here.
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // NF-03: upload 现为 ADMIN-only 有主操作，需注入 AuthUser，service 才能过属主守卫。
  const adminUser = {
    id: 1,
    username: "admin",
    email: "admin@example.com",
    role: UserRole.ADMIN,
    isActive: true,
  };

  const uploadArgs = () =>
    [
      { originalname: "app.zip", path: stagedPath } as Express.Multer.File,
      { name: "my-app", runtime: "python" },
      adminUser,
    ] as const;

  // P1-11 回归：upload 必须在 rename(copy) 之后从落地后的 zipPath 读 manifest。
  // 旧实现读已不存在的 tmpPath → 恒 ENOENT → manifest 静默丢失，entrypoint/
  // runtime 永不回填。此用例会先于修复失败（entrypoint 为 undefined）。
  it("P1-11: 从落地后的 zip 回填 manifest 的 entrypoint/runtime", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    // 用真实含 manifest.json 的结构化 zip 覆盖 staging 文件。
    const manifest = JSON.stringify({
      runtime: "node",
      entrypoint: "dist/main.js",
    });
    fs.writeFileSync(
      stagedPath,
      buildZip([
        { name: "manifest.json", data: Buffer.from(manifest) },
        { name: "main.js", data: Buffer.from("console.log(1)") },
      ]),
    );
    // 桩 rename：把暂存文件真实移到目标 ZipPath，让 tmpPath 真正消失，
    // 从而精确复现“rename 后读 tmpPath = ENOENT”的生产时序。
    // 注意：本 describe 把 fs.mkdirSync 桩成 no-op，且 upload 只在
    // `fs.existsSync(uploadsDir) === false` 时才调用它（existsSync 也被桩成恒
    // true）——uploads/packages 因此不会被真正创建。这里必须走 mkdirSync 的
    // 原始实现把落地目录补出来：否则 renameSync 先抛 ENOENT，回退到 copyFile
    // 时源文件已不在，报出的就是与被测行为无关的 fs 错误。
    rename.mockImplementation(async (from: any, to: any) => {
      realMkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    });

    const app = await controller.upload(
      { originalname: "app.zip", path: stagedPath } as Express.Multer.File,
      // 表单未显式传 runtime/entrypoint —— 完全依赖 manifest 回填。
      { name: "my-app" } as any,
      adminUser,
    );

    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "node",
        entrypoint: "dist/main.js",
      }),
      adminUser,
    );
    expect(app.runtime).toBe("node");
    expect(app.entrypoint).toBe("dist/main.js");
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
    // Fail-fast runs BEFORE landing: the staged temp file must not be renamed,
    // but the finally block must still clean the staged temp path.
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(stagedPath);
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
      adminUser,
    );
    // O-11: the staged temp file is consumed and renamed into uploads/packages.
    expect(rename).toHaveBeenCalledTimes(1);
  });

  // O-11: the staged disk file is moved (rename) into the persistent uploads
  // dir; after a successful landing the finally still best-effort-unlinks the
  // staged path.
  it("O-11: renames the staged temp file into uploads/packages", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    await controller.upload(...uploadArgs());
    expect(rename).toHaveBeenCalledWith(
      stagedPath,
      expect.stringContaining(path.join(process.cwd(), "uploads", "packages")),
    );
    expect(unlink).toHaveBeenCalledWith(stagedPath);
  });

  // R9b: a DB failure after the file landed must unlink the landed package
  // (upsert catch) AND the staged temp path (finally) — no orphan on either
  // side.
  it("R9b: unlinks the landed package when the DB upsert fails", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    svc.findByName.mockResolvedValue({ id: "app-1", name: "my-app" });
    svc.update.mockRejectedValue(new Error("db down"));

    await expect(controller.upload(...uploadArgs())).rejects.toThrow("db down");
    expect(rename).toHaveBeenCalledTimes(1);
    // Landed target path cleaned by the upsert catch.
    expect(unlink).toHaveBeenCalledWith(rename.mock.calls[0][1]);
    // Staged temp path cleaned by finally.
    expect(unlink).toHaveBeenCalledWith(stagedPath);
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
        Reflect.getMetadata(ROLES_KEY, ApplicationController.prototype[name]),
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
