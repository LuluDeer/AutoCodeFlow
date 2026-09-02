import axios from "axios";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorController } from "../executor.controller";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";

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
      getExecutorUrl: jest.fn().mockReturnValue("http://executor.local:8001/api/config/reload"),
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

    await expect(controller.reloadConfig("executor-1", body)).resolves.toEqual({ success: true });
    expect(svc.findOne).toHaveBeenCalledWith("executor-1");
    expect(svc.rotateToken).toHaveBeenCalledWith("executor-1");
    expect(svc.getExecutorUrl).toHaveBeenCalledWith("executor.local:8001", "api/config/reload");
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

    await expect(controller.reloadConfig("executor-1", {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.rotateToken).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
