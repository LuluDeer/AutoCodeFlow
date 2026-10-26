import {
  INestApplication,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  ExecutionContext,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { createHash, createHmac } from "crypto";
import * as express from "express";
import fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "node:stream";
import request from "supertest";
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
import {
  buildBenignZip,
  buildZip,
} from "../../../common/utils/__tests__/zip-samples";

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
  // on-disk temp file (file.path), not in an in-memory file.buffer. These tests
  // stage a REAL structurally-valid zip (the guard parses the central
  // directory) in a temp dir, then assert the controller consumes that path:
  // head magic + assertZipFileSafe + the ClamAV stream read it, the file is
  // renamed into uploads/packages/<appId>/<sha256>/<origName>.zip (R5a
  // 内容寻址) or reused verbatim on same-byte re-upload, and the staged temp
  // file is always cleaned up in finally.
  let svc: {
    findByName: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    recordUploadVersion: jest.Mock;
  };
  let controller: ApplicationController;
  let rename: jest.SpyInstance;
  let unlink: jest.SpyInstance;
  let existsSync: jest.SpyInstance;
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
      // R5a：packageUrl 由 create 之后的 update 统一钉进行——upsert 读面
      // 返回值来自 update，故默认实现必须回带 dto 字段。
      update: jest
        .fn()
        .mockImplementation((id: any, dto: any) =>
          Promise.resolve({ id, name: "my-app", ...dto }),
        ),
    };
    // Stub persist/landing fs calls so the repo's uploads/ dir is never
    // touched. Spied BEFORE the controller is constructed (its constructor
    // mkdirSync's the staging dir). Reads of the staged file below hit the
    // REAL file: readHeadBytes (head magic), sha256File / manifest parse
    // (R5a) and assertZipFileSafe (CD parse) all open file.path directly.
    // R5a：existsSync 缺省 false——落盘走「首传」分支（rename 被真实调用）；
    // 「同字节重复上传复用」类用例按落地路径覆写为 true。
    existsSync = jest.spyOn(fs, "existsSync").mockReturnValue(false);
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

  // R5a：期望中的内容寻址键 = 暂存字节的真实 sha256（sha256File 分块流式
  // 计算，此处整读对拍——两边必须一致）。
  const shaOfStaged = () =>
    createHash("sha256").update(fs.readFileSync(stagedPath)).digest("hex");

  const landedPathFor = (sha: string, origName = "app.zip") =>
    path.join(process.cwd(), "uploads", "packages", "app-1", sha, origName);

  // P1-11 回归：manifest 必须被真实解析并回填 entrypoint/runtime。旧实现读
  // 已不存在的 tmpPath（rename 之后）→ 恒 ENOENT → manifest 静默丢失。
  // R5a：manifest 解析提前到建行/落盘之前、直接读暂存文件——本用例用真实
  // rename 复核「解析发生在文件移动前后都拿得到内容」。
  it("P1-11: 从上传 zip 回填 manifest 的 entrypoint/runtime", async () => {
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
    // 桩 rename：把暂存文件真实移到目标 ZipPath，让 tmpPath 真正消失——
    // 精确复现「文件已被移动」的生产时序。
    // 注意：本 describe 把 fs.mkdirSync 桩成 no-op（existsSync 恒 false →
    // upload 走首传分支会调它，但 no-op 不建目录），这里必须走 mkdirSync 的
    // 原始实现把嵌套落地目录补出来：否则 renameSync 先抛 ENOENT，回退到
    // copyFile 时源文件已不在，报出的就是与被测行为无关的 fs 错误。
    rename.mockImplementation(async (from: any, to: any) => {
      realMkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    });
    // 暂存文件即将被真实移走——先取本用例字节的内容寻址键。
    const sha = shaOfStaged();

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

    // 本用例的 rename 桩是真实落盘——清掉测试产物，别污染仓库 uploads/。
    fs.rmSync(path.dirname(landedPathFor(sha)), {
      recursive: true,
      force: true,
    });
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
    // R5a：appId 在 create 之后才诞生，create 不带 packageUrl；URL 由随后
    // 的 update 统一钉进行。
    expect(svc.create).toHaveBeenCalledTimes(1);
    expect(
      (svc.create.mock.calls[0][0] as Record<string, unknown>).packageUrl,
    ).toBeUndefined();
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
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
  it("O-11: renames the staged temp file into the content-addressed path", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    await controller.upload(...uploadArgs());
    // R5a：落盘目标 = uploads/packages/<appId>/<sha256(暂存字节)>/<origName>.zip
    expect(rename).toHaveBeenCalledWith(
      stagedPath,
      landedPathFor(shaOfStaged()),
    );
    expect(unlink).toHaveBeenCalledWith(stagedPath);
  });

  // R5a：packageUrl 只换路径形态——仍是同一 apiBase 前缀下的完整 URL，
  // 形如 {API_BASE_URL}/uploads/packages/<appId>/<sha256>/<origName>.zip。
  it("R5a: packageUrl is the deterministic content-addressed URL", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    const app = await controller.upload(...uploadArgs());
    const sha = shaOfStaged();
    expect(app.packageUrl).toBe(
      `https://api.example.com/uploads/packages/app-1/${sha}/app.zip`,
    );
  });

  // R5a：同字节重复上传命中同一路径——复用既有文件（不 rename 不重写：
  // mtime 稳定、无部分覆盖窗口），URL 与首传逐字节一致；暂存临时文件由
  // finally 丢弃。
  it("R5a: same bytes re-uploaded reuse the existing file and URL", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    svc.findByName.mockResolvedValue({ id: "app-1", name: "my-app" });
    const sha = shaOfStaged();
    const landed = landedPathFor(sha);
    // 只对「已落地的内容寻址文件」报告存在——其余（targetDir 等）走首传分支
    // 的 mkdir 逻辑（mkdirSync 已桩 no-op）。
    existsSync.mockImplementation((p: any) => p === landed);

    const app = await controller.upload(...uploadArgs());

    expect(rename).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
    expect(app.packageUrl).toBe(
      `https://api.example.com/uploads/packages/app-1/${sha}/app.zip`,
    );
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ packageUrl: app.packageUrl }),
      adminUser,
    );
    // 复用分支绝不 unlink 落地文件；暂存文件仍被 finally 清掉。
    expect(unlink).not.toHaveBeenCalledWith(landed);
    expect(unlink).toHaveBeenCalledWith(stagedPath);
  });

  // R5a：DB update 失败时只有「本次真正落盘」的文件才回收——复用的内容寻址
  // 文件可能仍被其他版本快照钉住（同字节不同版本号共享同一路径），误删会
  // 破坏那些回滚目标。
  it("R5a: a REUSED content-addressed file is NOT unlinked when the DB update fails", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    svc.findByName.mockResolvedValue({ id: "app-1", name: "my-app" });
    svc.update.mockRejectedValue(new Error("db down"));
    const landed = landedPathFor(shaOfStaged());
    existsSync.mockImplementation((p: any) => p === landed);

    await expect(controller.upload(...uploadArgs())).rejects.toThrow("db down");
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalledWith(landed);
    expect(unlink).toHaveBeenCalledWith(stagedPath);
  });

  // R5a：用户提供的原始文件名收敛为单段安全文件名（剥目录分量、非法字符
  // 替换为 _），落盘路径与 URL 均用收敛后的名字——表单 name 不再进入文件名。
  it("R5a: sanitizes the user-supplied original filename into the landing path", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    const sha = shaOfStaged();
    await controller.upload(
      {
        originalname: "..\\evil\\my app.zip",
        path: stagedPath,
      } as Express.Multer.File,
      { name: "my-app", runtime: "python" },
      adminUser,
    );
    expect(rename).toHaveBeenCalledWith(
      stagedPath,
      landedPathFor(sha, "my_app.zip"),
    );
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        packageUrl: `https://api.example.com/uploads/packages/app-1/${sha}/my_app.zip`,
      }),
      adminUser,
    );
  });

  // R5a：退化文件名（全点 stem）——不得产出 dotfile（express.static 默认
  // ignore dotfiles，点文件名下载 404），后缀 .zip 必须保住。
  it("R5a: degenerate dotted filenames never land as dotfiles", async () => {
    process.env.API_BASE_URL = "https://api.example.com";
    const sha = shaOfStaged();
    await controller.upload(
      { originalname: "..zip", path: stagedPath } as Express.Multer.File,
      { name: "my-app", runtime: "python" },
      adminUser,
    );
    expect(rename).toHaveBeenCalledWith(
      stagedPath,
      landedPathFor(sha, "zip.zip"),
    );
    expect(svc.update).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        packageUrl: `https://api.example.com/uploads/packages/app-1/${sha}/zip.zip`,
      }),
      adminUser,
    );
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
    handler: (...args: any[]) => unknown,
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
      // R1（2026-10-24 部署模型评审 §4.2）：回滚拆分出的两个写面端点。
      "setCurrentVersion",
      "deployVersion",
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
    // R1 §4.2：两个新写面端点同样拒绝普通用户
    expect(
      guard.canActivate(
        ctxWith(
          ApplicationController.prototype.setCurrentVersion,
          UserRole.USER,
        ),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(
        ctxWith(ApplicationController.prototype.deployVersion, UserRole.USER),
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

// R1（2026-10-24 部署模型评审 §4.2）：回滚拆分端点的控制器映射——
// set-current-version / deploy-version / 旧 rollback alias 均透传 JWT 用户
// 上下文（operator + 属主守卫 actor，P0-1：快照恢复写 applications 表必须
// 携带身份，否则 ApplicationService.update 的属主守卫恒 403）；旧 rollback
// alias 行为不变。
describe("ApplicationController version actions (R1 §4.2)", () => {
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
    recordUploadVersion: jest.Mock;
  };
  let deploymentSvc: {
    findRunningByApp: jest.Mock;
    upgrade: jest.Mock;
    setCurrentVersion: jest.Mock;
    deployVersion: jest.Mock;
    rollbackApplication: jest.Mock;
    upgradeAllWithRollout: jest.Mock;
  };
  let controller: ApplicationController;

  beforeEach(() => {
    svc = {
      findByNameWithSecret: jest.fn(),
      update: jest.fn(),
      recordUploadVersion: jest.fn().mockResolvedValue(undefined),
    };
    deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
      setCurrentVersion: jest.fn().mockResolvedValue({
        ok: true,
        dispatched: false,
        version: "1.0.0",
        versionId: "ver-1",
        updatedApp: { id: "app-1" },
      }),
      deployVersion: jest.fn().mockResolvedValue({
        ok: true,
        dispatched: true,
        version: "1.0.0",
        versionId: "ver-1",
        upgraded: [],
        skipped: [],
        updatedApp: { id: "app-1" },
      }),
      rollbackApplication: jest.fn().mockResolvedValue({ ok: true }),
      upgradeAllWithRollout: jest.fn().mockResolvedValue({
        ok: true,
        total: 0,
        succeeded: 0,
        failed: 0,
        coverage: {
          running: 0,
          scheduled: 0,
          stopped: 0,
          failed: 0,
          inFlight: 0,
        },
        skipped: [],
      }),
    };
    controller = new ApplicationController(
      svc as any,
      deploymentSvc as any,
      stubConfig() as any,
    );
  });

  // P0-1（2026-10-25 审计）：契约修正——旧用例把「不携带用户上下文」钉成契约，
  // 但快照恢复写 applications 表经 ApplicationService.update 的属主守卫，
  // 无 actor 时守卫对 undefined user 恒 403，整条链路功能不可用。该契约本身
  // 是 bug 的固化；修复后 controller 必须把 @CurrentUser 转成 {id, role} actor
  // 透传（@Roles(ADMIN) 之下 principal 恒为 JWT AuthUser）。
  it("setCurrentVersion 透传 appId + versionId + 属主守卫 actor（P0-1）", async () => {
    const result = await controller.setCurrentVersion(
      "app-1",
      { versionId: "ver-1" },
      { id: 7, role: UserRole.ADMIN },
    );
    expect(deploymentSvc.setCurrentVersion).toHaveBeenCalledWith(
      "app-1",
      "ver-1",
      { id: 7, role: UserRole.ADMIN },
    );
    expect(result.dispatched).toBe(false);
  });

  // R2（部署模型评审 §4.4）：includeStopped 透传——缺省必须显式落 false
  // （服务层第 5 参缺省值只对 undefined 生效，控制器这里收口缺省语义）。
  // P0-1：末位 actor 透传属主守卫（快照恢复写面）。
  it("upgradeAll 缺省 includeStopped=false；=true 时透传（R2 §4.4）", async () => {
    await controller.upgradeAll(
      "app-1",
      {},
      { id: 7, username: "alice", role: UserRole.ADMIN },
    );
    expect(deploymentSvc.upgradeAllWithRollout).toHaveBeenCalledWith(
      "app-1",
      null,
      { operator: "alice", triggerType: "upgrade" },
      undefined,
      false,
      { id: 7, role: UserRole.ADMIN },
    );

    await controller.upgradeAll(
      "app-1",
      { rollout: { strategy: "canary", percentage: 30 }, includeStopped: true },
      { id: 7, username: "alice", role: UserRole.ADMIN },
    );
    expect(deploymentSvc.upgradeAllWithRollout).toHaveBeenLastCalledWith(
      "app-1",
      { strategy: "canary", percentage: 30 },
      { operator: "alice", triggerType: "upgrade" },
      undefined,
      true,
      { id: 7, role: UserRole.ADMIN },
    );
  });

  it("deployVersion 透传 executorIds 与 JWT 用户名（rollback 语义）", async () => {
    await controller.deployVersion(
      "app-1",
      { versionId: "ver-1", executorIds: ["exec-1", "exec-2"] },
      { id: 7, username: "alice", role: UserRole.ADMIN },
    );
    expect(deploymentSvc.deployVersion).toHaveBeenCalledWith(
      "app-1",
      "ver-1",
      ["exec-1", "exec-2"],
      { operator: "alice", triggerType: "rollback" },
      { id: 7, role: UserRole.ADMIN },
    );
  });

  it("deployVersion 无 executorIds 时透传 undefined（= 全部 RUNNING 的缺省语义）", async () => {
    await controller.deployVersion(
      "app-1",
      { versionId: "ver-1" },
      { id: 7, username: "alice", role: UserRole.ADMIN },
    );
    expect(deploymentSvc.deployVersion).toHaveBeenCalledWith(
      "app-1",
      "ver-1",
      undefined,
      { operator: "alice", triggerType: "rollback" },
      { id: 7, role: UserRole.ADMIN },
    );
  });

  it("旧 rollback alias 仍走 rollbackApplication（deprecated 但行为不变）", async () => {
    await controller.rollback("app-1", "ver-1", {
      id: 7,
      username: "alice",
      role: UserRole.ADMIN,
    });
    expect(deploymentSvc.rollbackApplication).toHaveBeenCalledWith(
      "app-1",
      "ver-1",
      { operator: "alice", triggerType: "rollback" },
      { id: 7, role: UserRole.ADMIN },
    );
  });
});
