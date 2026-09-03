import axios from "axios";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorController } from "../executor.controller";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";
import {
  INSTALL_SCRIPT,
  repoInstallScriptOrNull,
} from "../install-script.content";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";

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
        status: ExecutorStatus.ONLINE,
        type: ExecutorType.PYTHON,
      }),
      rotateToken: jest.fn().mockResolvedValue({ token: "rotated-token" }),
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
    expect(svc.rotateToken).toHaveBeenCalledWith("executor-1");
    expect(svc.getExecutorUrl).toHaveBeenCalledWith(
      "executor.local:8001",
      "api/config/reload",
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://executor.local:8001/api/config/reload",
      body,
      {
        headers: { Authorization: "Bearer rotated-token" },
        timeout: 10_000,
      },
    );
  });

  it("rejects config reload for offline executor", async () => {
    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: "executor-1",
        address: "executor.local:8001",
        status: ExecutorStatus.OFFLINE,
      }),
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

  // N11 复核后 GET /executors 保持"仅登录"（不设 @Roles）：任务 CRUD 对普通
  // 用户开放且 executions 侧本就暴露 executorAddress，锁列表只会打断
  // TaskFormPage 下拉。这里固化"列表无角色限制 + 机器端点无角色限制"的姿态。
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
});
