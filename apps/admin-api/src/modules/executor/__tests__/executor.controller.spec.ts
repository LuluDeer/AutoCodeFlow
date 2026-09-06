import axios from "axios";
import { UnauthorizedException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import * as request from "supertest";
import { ExecutorService } from "../executor.service";
import { SystemConfigService } from "../../config/config.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutorController } from "../executor.controller";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";
import {
  INSTALL_SCRIPT,
  repoInstallScriptOrNull,
} from "../install-script.content";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";

jest.mock("axios");
// F-3: reload-config now consults the SSRF layer before posting; stub it here
// (this spec covers URL forwarding, not SSRF policy — see the security spec).
jest.mock("../../../common/utils/safe-http.util", () => ({
  ...jest.requireActual("../../../common/utils/safe-http.util"),
  assertSafeExecutorUrl: jest
    .fn()
    .mockResolvedValue(new URL("http://fixture:8001/")),
}));

describe("ExecutorController", () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("forwards all admin API URL hot-reload fields to executor", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        appName: "executor-node",
        executorStartupId: "startup-1",
        status: ExecutorStatus.ONLINE,
        type: ExecutorType.PYTHON,
      }),
      // R11: reload-config reuses the executor's CURRENT token via the
      // idempotent issueToken() — never rotateToken() (a fresh secret the
      // executor has never seen would 401 the inbound push).
      issueToken: jest
        .fn()
        .mockResolvedValue({ token: "issued-token", tokenHash: "hash-1" }),
      rotateToken: jest.fn(),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://executor.local:8001/api/config/reload"),
    };
    const controller = new ExecutorController(
      svc as any,
      {} as ConfigService,
      {} as any,
    );
    mockedAxios.post.mockResolvedValue({ data: { success: true } });

    const body = {
      maxConcurrentTasks: 4,
      taskTimeoutSeconds: 120,
      heartbeatIntervalSeconds: 15,
      adminApiUrl: "http://admin-api:3105/api",
      adminApiUrlInternal: "http://admin-api.internal:3105/api",
      adminApiUrlExternal: "https://admin.example.com/api",
    };

    await expect(controller.reloadConfig("executor-1", body)).resolves.toEqual({
      success: true,
    });
    expect(svc.findOne).toHaveBeenCalledWith("executor-1");
    expect(svc.issueToken).toHaveBeenCalledWith({
      address: "executor.local:8001",
      appName: "executor-node",
      startupId: "startup-1",
    });
    expect(svc.rotateToken).not.toHaveBeenCalled();
    expect(svc.getExecutorUrl).toHaveBeenCalledWith(
      "executor.local:8001",
      "api/config/reload",
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://executor.local:8001/api/config/reload",
      body,
      {
        headers: { Authorization: "Bearer issued-token" },
        timeout: 10_000,
      },
    );
  });

  // R11: legacy rows (no executorStartupId) / cold issuance cache can make
  // issueToken() rotate for real, so the first push still 401s. The handler
  // re-issues and retries EXACTLY ONCE.
  it("re-issues the token and retries once when the push is rejected 401", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        appName: "executor-node",
        executorStartupId: null, // legacy row
        status: ExecutorStatus.ONLINE,
      }),
      issueToken: jest
        .fn()
        .mockResolvedValueOnce({ token: "first-token", tokenHash: "h1" })
        .mockResolvedValueOnce({ token: "second-token", tokenHash: "h2" }),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://executor.local:8001/api/config/reload"),
    };
    const controller = new ExecutorController(
      svc as any,
      {} as ConfigService,
      {} as any,
    );
    const unauthorized = Object.assign(new Error("Request failed"), {
      response: {
        status: 401,
        data: { error: "Invalid or missing executor token" },
      },
    });
    mockedAxios.post
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({ data: { success: true } });

    await expect(controller.reloadConfig("executor-1", {})).resolves.toEqual({
      success: true,
    });
    expect(svc.issueToken).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenLastCalledWith(
      "http://executor.local:8001/api/config/reload",
      {},
      {
        headers: { Authorization: "Bearer second-token" },
        timeout: 10_000,
      },
    );
  });

  it("throws the fixed error when the 401 retry also fails (no error echo, no third attempt)", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        appName: "executor-node",
        executorStartupId: null,
        status: ExecutorStatus.ONLINE,
      }),
      issueToken: jest.fn().mockResolvedValue({ token: "t", tokenHash: "h" }),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://executor.local:8001/api/config/reload"),
    };
    const controller = new ExecutorController(
      svc as any,
      {} as ConfigService,
      {} as any,
    );
    const unauthorized = Object.assign(new Error("Request failed"), {
      response: {
        status: 401,
        data: { error: "Invalid or missing executor token" },
      },
    });
    mockedAxios.post.mockRejectedValue(unauthorized);

    await expect(controller.reloadConfig("executor-1", {})).rejects.toThrow(
      "Failed to reach executor",
    );
    // exactly one auth retry: two posts, two issuances — never a third
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(svc.issueToken).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-401 failures (connect/timeout stay single-shot)", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        appName: "executor-node",
        executorStartupId: "startup-1",
        status: ExecutorStatus.ONLINE,
      }),
      issueToken: jest.fn().mockResolvedValue({ token: "t", tokenHash: "h" }),
      getExecutorUrl: jest
        .fn()
        .mockReturnValue("http://executor.local:8001/api/config/reload"),
    };
    const controller = new ExecutorController(
      svc as any,
      {} as ConfigService,
      {} as any,
    );
    mockedAxios.post.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.9:8001"),
    );

    await expect(controller.reloadConfig("executor-1", {})).rejects.toThrow(
      "Failed to reach executor",
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(svc.issueToken).toHaveBeenCalledTimes(1);
  });

  it("rejects config reload for offline executor", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        status: ExecutorStatus.OFFLINE,
      }),
      issueToken: jest.fn(),
      rotateToken: jest.fn(),
      getExecutorUrl: jest.fn(),
    };
    const controller = new ExecutorController(
      svc as any,
      {} as ConfigService,
      {} as any,
    );

    await expect(
      controller.reloadConfig("executor-1", {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.issueToken).not.toHaveBeenCalled();
    expect(svc.rotateToken).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  describe("GET /executors/install.sh", () => {
    const makeRes = () => ({
      setHeader: jest.fn(),
      end: jest.fn(),
      statusCode: 200,
    });

    it("serves the install script as text/plain via raw response (bypasses ResponseInterceptor JSON wrapping)", () => {
      const controller = new ExecutorController(
        {} as any,
        {} as ConfigService,
        {} as any,
      );
      const res = makeRes();
      controller.getInstallScript(res as any);
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/plain; charset=utf-8",
      );
      expect(res.end).toHaveBeenCalledTimes(1);
      const body = res.end.mock.calls[0][0];
      expect(typeof body).toBe("string");
      expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    });

    it("backend copy is byte-identical to repo scripts/install.sh (single source of truth guard)", () => {
      const repoCopy = repoInstallScriptOrNull();
      // dist builds cannot reach the repo root — guard only applies in src.
      if (repoCopy === null) return;
      expect(INSTALL_SCRIPT).toBe(repoCopy);
    });
  });

  // R8（N24 根治）：install.sh 真 artifact 通道 —— GET
  // /executors/artifact/executor-node.tar.gz。鉴权走真实 verifyExecutorToken
  // （本 spec 未 mock 它）：DB 共享 token 查询失败时回退 env
  // executor.sharedToken，与 register/getToken 姿态一致。
  describe("GET /executors/artifact/executor-node.tar.gz (R8 N24)", () => {
    const SHARED = "test-shared-token";
    let artifactDir: string;

    const makeRes = () => ({
      setHeader: jest.fn(),
      end: jest.fn(),
      statusCode: 200,
    });
    const makeController = (dir: string) => {
      const configService = {
        get: (key: string) =>
          key === "executor.sharedToken"
            ? SHARED
            : key === "EXECUTOR_ARTIFACT_DIR"
              ? dir
              : undefined,
      } as unknown as ConfigService;
      // DB token lookup throws → verifier falls back to the env token.
      const systemConfigService = {
        findOne: jest.fn().mockRejectedValue(new Error("no db")),
      };
      return new ExecutorController(
        {} as any,
        configService,
        systemConfigService as any,
      );
    };

    beforeEach(() => {
      artifactDir = mkdtempSync(join(tmpdir(), "acf-artifact-"));
    });
    afterEach(() => {
      rmSync(artifactDir, { recursive: true, force: true });
    });

    it("serves the tar.gz via raw response when the artifact exists (Bearer auth)", async () => {
      const payload = Buffer.from("fake-tarball-bytes");
      writeFileSync(join(artifactDir, "executor-node.tar.gz"), payload);
      const controller = makeController(artifactDir);
      const res = makeRes();

      await controller.getExecutorArtifact(
        `Bearer ${SHARED}`,
        undefined,
        res as any,
      );

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/gzip",
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Disposition",
        'attachment; filename="executor-node.tar.gz"',
      );
      expect(res.end).toHaveBeenCalledTimes(1);
      expect(Buffer.compare(res.end.mock.calls[0][0] as Buffer, payload)).toBe(
        0,
      );
    });

    it("accepts the shared token via ?token= query (curl fallback)", async () => {
      writeFileSync(
        join(artifactDir, "executor-node.tar.gz"),
        Buffer.from("x"),
      );
      const controller = makeController(artifactDir);
      const res = makeRes();

      await controller.getExecutorArtifact(undefined, SHARED, res as any);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("rejects a wrong token with 401 and never touches the file", async () => {
      writeFileSync(
        join(artifactDir, "executor-node.tar.gz"),
        Buffer.from("x"),
      );
      const controller = makeController(artifactDir);
      const res = makeRes();

      await expect(
        controller.getExecutorArtifact(
          "Bearer wrong-token",
          undefined,
          res as any,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(res.end).not.toHaveBeenCalled();
    });

    it("rejects an anonymous request (no header, no query) with 401", async () => {
      const controller = makeController(artifactDir);
      await expect(
        controller.getExecutorArtifact(undefined, undefined, makeRes() as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("404s when the artifact has not been generated yet", async () => {
      const controller = makeController(artifactDir);
      await expect(
        controller.getExecutorArtifact(
          `Bearer ${SHARED}`,
          undefined,
          makeRes() as any,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("declares @Public + empty @Roles (public route gated only by shared token)", () => {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          ExecutorController.prototype.getExecutorArtifact,
        ),
      ).toBe(true);
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          ExecutorController.prototype.getExecutorArtifact,
        ),
      ).toEqual([]);
    });
  });

  // N11 复核后 GET /executors 保持"仅登录"（不设 @Roles）：任务 CRUD 对普通
  // 用户开放且 executions 侧本就暴露 executorAddress，锁列表只会打断
  // TaskFormPage 下拉。这里固化"列表无角色限制 + 机器端点无角色限制"的姿态。
  describe("install-cmd HTTP authorization DR-01", () => {
    let app: INestApplication;
    let svc: { getInstallCmd: jest.Mock };
    const response = {
      cmd: "curl -fsSL 'https://admin.example.com/api/executors/install.sh' | bash -s -- --api-url 'https://admin.example.com' --secret 'shared-token'",
      token: "shared-token",
      adminApiUrl: "https://admin.example.com",
    };

    beforeEach(async () => {
      svc = { getInstallCmd: jest.fn().mockResolvedValue(response) };
      // Mock only authentication; exercise the real global role guard and Nest HTTP errors.
      const jwtGuard = {
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          const role = req.headers["x-test-role"];
          if (!role) throw new UnauthorizedException();
          req.user = { role };
          return true;
        },
      };
      const module = await Test.createTestingModule({
        controllers: [ExecutorController],
        providers: [
          { provide: ExecutorService, useValue: svc },
          { provide: ConfigService, useValue: {} },
          { provide: SystemConfigService, useValue: {} },
          { provide: APP_GUARD, useValue: jwtGuard },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      }).overrideGuard(JwtAuthGuard).useValue(jwtGuard).compile();
      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => { await app?.close(); });

    it("returns 403 to a normal user without exposing credentials", async () => {
      const res = await request(app.getHttpServer()).get("/executors/install-cmd")
        .set("x-test-role", "user").expect(403);
      expect(svc.getInstallCmd).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain("shared-token");
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer()).get("/executors/install-cmd").expect(401);
      expect(svc.getInstallCmd).not.toHaveBeenCalled();
    });

    it("returns the unchanged command/token/URL structure to an admin", async () => {
      const res = await request(app.getHttpServer()).get("/executors/install-cmd")
        .set("x-test-role", "admin").expect(200);
      expect(res.body).toEqual(response);
      expect(res.body.cmd).toContain("/api/executors/install.sh");
      expect(res.body.cmd).toContain("--secret 'shared-token'");
      expect(svc.getInstallCmd).toHaveBeenCalledTimes(1);
    });
  });

  describe("RBAC — install command is ADMIN-only", () => {
    it("declares ADMIN role metadata", () => {
      expect(Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype.getInstallCmd)).toEqual(["admin"]);
    });
  });

  describe("RBAC — GET /executors stays authenticated-only (N11 复核)", () => {
    it("findAll declares no role restriction", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype.findAll),
      ).toBeUndefined();
    });

    it("machine endpoints carry no role restriction", () => {
      expect(
        Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype.register),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(ROLES_KEY, ExecutorController.prototype.heartbeat),
      ).toBeUndefined();
    });
  });

  // R9 (round-8 P1 closure, W2/W3): the token endpoint delegates to the
  // idempotent issueToken() (no more rotate-on-every-call), and the heartbeat
  // response echoes the current tokenHash so the executor's N26 callback
  // HMAC secret follows admin-side rotations.
  describe("POST /executors/token — R9 idempotent issuance", () => {
    // verifyExecutorToken is NOT mocked in this spec — wire a shared token
    // through ConfigService (SystemConfigService lookup misses → env value).
    const makeController = (svc: any) =>
      new ExecutorController(
        svc,
        {
          get: (key: string) =>
            key === "executor.sharedToken" ? "shared-secret" : undefined,
        } as unknown as ConfigService,
        { findOne: () => Promise.reject(new Error("not found")) } as any,
      );
    const makeSvc = () => ({
      issueToken: jest
        .fn()
        .mockResolvedValue({ token: "issued-token", tokenHash: "$2b$04$hash" }),
      register: jest.fn(),
      rotateToken: jest.fn(),
    });

    it("forwards address/appName/startupId to issueToken and returns {token,tokenHash}", async () => {
      const svc = makeSvc();
      const controller = makeController(svc);

      const result = await controller.getToken(
        {
          address: "10.0.0.9:3002",
          appName: "executor-node",
          startupId: "startup-1",
        },
        "Bearer shared-secret",
      );

      expect(svc.issueToken).toHaveBeenCalledWith({
        address: "10.0.0.9:3002",
        appName: "executor-node",
        startupId: "startup-1",
      });
      expect(result).toEqual({
        token: "issued-token",
        tokenHash: "$2b$04$hash",
      });
      // The old per-call rotation path must be gone from this endpoint.
      expect(svc.rotateToken).not.toHaveBeenCalled();
      expect(svc.register).not.toHaveBeenCalled();
    });

    it("defaults appName to 'executor' when the body omits it", async () => {
      const svc = makeSvc();
      const controller = makeController(svc);

      await controller.getToken(
        { address: "10.0.0.9:3002" },
        "Bearer shared-secret",
      );

      expect(svc.issueToken).toHaveBeenCalledWith({
        address: "10.0.0.9:3002",
        appName: "executor",
        startupId: undefined,
      });
    });

    it("rejects a wrong shared token with 401 before issuing anything", async () => {
      const svc = makeSvc();
      const controller = makeController(svc);

      await expect(
        controller.getToken(
          { address: "10.0.0.9:3002", startupId: "startup-1" },
          "Bearer wrong-secret",
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(svc.issueToken).not.toHaveBeenCalled();
    });
  });

  describe("POST /executors/heartbeat — R9 tokenHash echo", () => {
    it("echoes the current stored tokenHash alongside the heartbeat result", async () => {
      const svc = {
        validateTokenByAddress: jest.fn().mockResolvedValue(true),
        heartbeat: jest
          .fn()
          .mockResolvedValue({ address: "10.0.0.9:3002", status: "online" }),
        getCallbackSecretByAddress: jest.fn().mockResolvedValue("$2b$12$hash"),
      };
      const controller = new ExecutorController(
        svc as any,
        {} as ConfigService,
        {} as any,
      );

      const result = await controller.heartbeat(
        { address: "10.0.0.9:3002", cpuUsage: 12.5 },
        "Bearer per-executor-token",
      );

      expect(result).toMatchObject({
        address: "10.0.0.9:3002",
        status: "online",
        tokenHash: "$2b$12$hash",
      });
      expect(svc.getCallbackSecretByAddress).toHaveBeenCalledWith(
        "10.0.0.9:3002",
      );
    });

    // E9: controller 只负责白名单转发，1..10000 校验在 service 侧完成
    it("forwards maxConcurrentTasks to the heartbeat service", async () => {
      const svc = {
        validateTokenByAddress: jest.fn().mockResolvedValue(true),
        heartbeat: jest
          .fn()
          .mockResolvedValue({ address: "10.0.0.9:3002", status: "online" }),
        getCallbackSecretByAddress: jest.fn().mockResolvedValue("$2b$12$hash"),
      };
      const controller = new ExecutorController(
        svc as any,
        {} as ConfigService,
        {} as any,
      );

      await controller.heartbeat(
        { address: "10.0.0.9:3002", maxConcurrentTasks: 12 },
        "Bearer per-executor-token",
      );

      expect(svc.heartbeat).toHaveBeenCalledWith(
        "10.0.0.9:3002",
        expect.objectContaining({ maxConcurrentTasks: 12 }),
      );
    });
  });
});
