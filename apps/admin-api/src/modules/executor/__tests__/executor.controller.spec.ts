import axios from "axios";
import {
  UnauthorizedException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
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
// BUG-01：401 重签重试可观测计数（模块级进程内计数表，与渲染侧同实例），
// 专项用例围绕 autoflow_push_auth_retry_total 的两条 result 标签展开。
import {
  getRuntimeCountersSnapshot,
  resetRuntimeMetrics,
} from "../../metrics/runtime-metrics-entry";

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

    // BUG-01 (b): 重签重试后仍 401 → 精确文案：执行器地址 + "重签重试后仍 401"
    // 语义 + 建议动作（等待一个心跳自愈 / rotate-token）。
    const err = await controller.reloadConfig("executor-1", {}).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toContain(
      "Executor executor.local:8001 rejected the config push with 401 even after a token re-issue retry",
    );
    expect(err.message).toContain("rotate-token");
    // F-8: 仍不回显 axios 错误文本
    expect(err.message).not.toContain("Invalid or missing executor token");
    expect(err.message).not.toContain("Request failed");
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

  // BUG-01（N51 收口）：401 重签重试的可观测性与双 401 文案区分。
  // recordRuntime 的计数表是模块级单例（与渲染侧共享同一实例），进/出本
  // describe 各显式重置一次，防跨用例/跨文件串扰；计数断言直接读快照，
  // 与 prometheus-metrics.service.spec 的渲染测试互补。
  describe("reload-config 401 retry observability (BUG-01)", () => {
    beforeEach(() => {
      resetRuntimeMetrics();
      // 静默 BUG-01 新增的 warn/fx 日志，保持测试输出干净
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      resetRuntimeMetrics();
      jest.restoreAllMocks();
    });

    const retryCount = (result: "reissued_success" | "still_unauthorized") =>
      getRuntimeCountersSnapshot()
        .get("autoflow_push_auth_retry_total")
        ?.get(JSON.stringify({ result })) ?? 0;

    const makeOnlineExecutor = (overrides: Record<string, unknown> = {}) => ({
      id: "executor-1",
      address: "executor.local:8001",
      appName: "executor-node",
      executorStartupId: null, // legacy row → 首发 401 的冷缓存形态
      status: ExecutorStatus.ONLINE,
      ...overrides,
    });

    const unauthorized = () =>
      Object.assign(new Error("Request failed"), {
        response: {
          status: 401,
          data: { error: "Invalid or missing executor token" },
        },
      });

    // a) 首发 401 → 重签成功 → 重试 2xx：响应 success，issueToken 被重签调用，
    //    计数 reissued_success +1。
    it("re-issues once after a first-attempt 401 and succeeds on the retry (a)", async () => {
      const svc = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
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
      mockedAxios.post
        .mockRejectedValueOnce(unauthorized())
        .mockResolvedValueOnce({ data: { success: true } });

      await expect(controller.reloadConfig("executor-1", {})).resolves.toEqual({
        success: true,
      });
      // 首发 + 重签共两次签发，重试请求携带重签 token
      expect(svc.issueToken).toHaveBeenCalledTimes(2);
      expect(mockedAxios.post).toHaveBeenLastCalledWith(
        "http://executor.local:8001/api/config/reload",
        {},
        {
          headers: { Authorization: "Bearer second-token" },
          timeout: 10_000,
        },
      );
      expect(retryCount("reissued_success")).toBe(1);
      expect(retryCount("still_unauthorized")).toBe(0);
    });

    // b) 首发 401 → 重签后仍 401：错误文案含执行器地址与"重签重试后"语义，
    //    建议动作齐全；计数 still_unauthorized +1。
    it("surfaces the precise still-401 message after the retry also fails with 401 (b)", async () => {
      const svc = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
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
      mockedAxios.post.mockRejectedValue(unauthorized());

      const err = await controller
        .reloadConfig("executor-1", {})
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toContain("executor.local:8001");
      expect(err.message).toContain("even after a token re-issue retry");
      expect(err.message).toContain("one heartbeat");
      expect(err.message).toContain("rotate-token");
      expect(retryCount("still_unauthorized")).toBe(1);
      expect(retryCount("reissued_success")).toBe(0);
    });

    // c) 非 401 失败不触发重签（connect/timeout 保持单发），也不产生任何
    //    重试计数——只有真正的 401 裁定才进 metric。
    it("keeps non-401 failures single-shot and leaves the retry counter untouched (c)", async () => {
      const svc = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
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
      mockedAxios.post.mockRejectedValue(new Error("connect ECONNREFUSED"));

      await expect(controller.reloadConfig("executor-1", {})).rejects.toThrow(
        "Failed to reach executor",
      );
      expect(svc.issueToken).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(retryCount("reissued_success")).toBe(0);
      expect(retryCount("still_unauthorized")).toBe(0);
    });

    // c) 补充：首发 2xx 的正常路径完全不触碰重签与计数。
    it("does not re-issue or count anything when the first push succeeds (c)", async () => {
      const svc = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
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
      mockedAxios.post.mockResolvedValue({ data: { success: true } });

      await expect(controller.reloadConfig("executor-1", {})).resolves.toEqual({
        success: true,
      });
      expect(svc.issueToken).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(retryCount("reissued_success")).toBe(0);
      expect(retryCount("still_unauthorized")).toBe(0);
    });

    // d) 重试仅一次：首发 401 + 重试 401 后总计恰两次 POST、两次签发，无第三次。
    it("retries the push EXACTLY once, never a second re-issue cycle (d)", async () => {
      const svc = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
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
      mockedAxios.post.mockRejectedValue(unauthorized());

      await expect(
        controller.reloadConfig("executor-1", {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(svc.issueToken).toHaveBeenCalledTimes(2);
    });

    // e) 计数在 a/b 两分支各 +1 且跨分支累加（monotonic within the reset window）。
    it("increments the counter once per retry outcome across both branches (e)", async () => {
      // 分支 a：首发 401 → 重试 2xx
      const svcA = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
        issueToken: jest
          .fn()
          .mockResolvedValueOnce({ token: "first-token", tokenHash: "h1" })
          .mockResolvedValueOnce({ token: "second-token", tokenHash: "h2" }),
        getExecutorUrl: jest
          .fn()
          .mockReturnValue("http://executor.local:8001/api/config/reload"),
      };
      const controllerA = new ExecutorController(
        svcA as any,
        {} as ConfigService,
        {} as any,
      );
      mockedAxios.post
        .mockRejectedValueOnce(unauthorized())
        .mockResolvedValueOnce({ data: { success: true } });
      await controllerA.reloadConfig("executor-1", {});
      expect(retryCount("reissued_success")).toBe(1);

      // 分支 b：首发 401 → 重试 401（另一控制器实例，同一模块级计数表）
      const svcB = {
        findOne: jest.fn().mockResolvedValue(makeOnlineExecutor()),
        issueToken: jest.fn().mockResolvedValue({ token: "t", tokenHash: "h" }),
        getExecutorUrl: jest
          .fn()
          .mockReturnValue("http://executor.local:8001/api/config/reload"),
      };
      const controllerB = new ExecutorController(
        svcB as any,
        {} as ConfigService,
        {} as any,
      );
      mockedAxios.post.mockRejectedValue(unauthorized());
      await expect(
        controllerB.reloadConfig("executor-1", {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(retryCount("reissued_success")).toBe(1);
      expect(retryCount("still_unauthorized")).toBe(1);

      // 再走一轮分支 a：reissued_success 累加到 2（单调累计）
      mockedAxios.post
        .mockRejectedValueOnce(unauthorized())
        .mockResolvedValueOnce({ data: { success: true } });
      await controllerB.reloadConfig("executor-1", {});
      expect(retryCount("reissued_success")).toBe(2);
      expect(retryCount("still_unauthorized")).toBe(1);
    });
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

    it("returns 403 to a normal user without exposing credentials", async () => {
      const res = await request(app.getHttpServer())
        .get("/executors/install-cmd")
        .set("x-test-role", "user")
        .expect(403);
      expect(svc.getInstallCmd).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain("shared-token");
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer())
        .get("/executors/install-cmd")
        .expect(401);
      expect(svc.getInstallCmd).not.toHaveBeenCalled();
    });

    it("returns the unchanged command/token/URL structure to an admin", async () => {
      const res = await request(app.getHttpServer())
        .get("/executors/install-cmd")
        .set("x-test-role", "admin")
        .expect(200);
      expect(res.body).toEqual(response);
      expect(res.body.cmd).toContain("/api/executors/install.sh");
      expect(res.body.cmd).toContain("--secret 'shared-token'");
      expect(svc.getInstallCmd).toHaveBeenCalledTimes(1);
    });
  });

  describe("RBAC — install command is ADMIN-only", () => {
    it("declares ADMIN role metadata", () => {
      expect(
        Reflect.getMetadata(
          ROLES_KEY,
          ExecutorController.prototype.getInstallCmd,
        ),
      ).toEqual(["admin"]);
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
