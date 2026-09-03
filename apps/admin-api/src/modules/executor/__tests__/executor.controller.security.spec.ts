import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorController } from "../executor.controller";
import { ExecutorStatus, ExecutorType } from "../entities/executor.entity";

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  const post = jest.fn();
  const get = jest.fn();
  return {
    ...actual,
    post,
    get,
    default: { ...(actual.default ?? actual), post, get },
  };
});
jest.mock("../../../common/utils/safe-http.util", () => ({
  assertSafeExecutorUrl: jest.fn().mockResolvedValue(new URL("http://ok")),
}));
// register/getToken call the real shared-token verifier; stub it — these specs
// exercise payload whitelisting, not token verification.
jest.mock("../../../common/utils/verify-executor-token.util", () => ({
  verifyExecutorToken: jest.fn().mockResolvedValue(undefined),
}));

describe("ExecutorController — F-2 heartbeat / F-7 register mass-assignment guards", () => {
  const makeSvc = (overrides: Record<string, jest.Mock> = {}) => ({
    register: jest.fn(async (data) => ({ id: "new-id", ...data })),
    registerExecutor: jest.fn(async (data) => ({
      executor: { id: "new-id", ...data },
      perExecutorToken: "fresh-token",
    })),
    heartbeat: jest.fn(async (address, metrics) => ({ address, metrics })),
    validateTokenByAddress: jest.fn().mockResolvedValue(true),
    rotateToken: jest.fn().mockResolvedValue({ token: "fresh-token" }),
    ...overrides,
  });

  const makeConfig = (): ConfigService => ({ get: () => undefined }) as any;

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("F-2: heartbeat field whitelist", () => {
    it("forwards only whitelisted metric fields to the service", async () => {
      const svc = makeSvc();
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      await controller.heartbeat(
        {
          address: "10.0.0.9:3002",
          cpuUsage: 12.5,
          memUsage: 40,
          diskUsage: 55,
          networkLatency: 3,
          runningTaskCount: 2,
          totalTaskCount: 10,
          failedTaskCount: 1,
          restartedAt: "2026-01-01T00:00:00.000Z",
          startupId: "startup-1",
          // injection attempts below must be dropped by the controller
          tokenHash: "$2b$12$attackerhash",
          version: 99,
          maxConcurrentTasks: 100000,
          status: "offline",
          id: "victim-id",
        } as any,
        "Bearer tok",
      );
      expect(svc.heartbeat).toHaveBeenCalledWith("10.0.0.9:3002", {
        cpuUsage: 12.5,
        memUsage: 40,
        diskUsage: 55,
        networkLatency: 3,
        runningTaskCount: 2,
        totalTaskCount: 10,
        failedTaskCount: 1,
        restartedAt: "2026-01-01T00:00:00.000Z",
        startupId: "startup-1",
      });
    });

    it("drops the injected tokenHash so a rotated shared token still revokes access", async () => {
      const svc = makeSvc();
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      await controller.heartbeat(
        { address: "10.0.0.9:3002", tokenHash: "$2b$12$attackerhash" } as any,
        "Bearer shared-or-per-address-token",
      );
      const forwarded = svc.heartbeat.mock.calls[0][1];
      expect("tokenHash" in forwarded).toBe(false);
      expect(forwarded.tokenHash).toBeUndefined();
    });
  });

  describe("F-7: register field whitelist", () => {
    it("ignores client-supplied id / tokenHash / status / version / runningTaskCount", async () => {
      const svc = makeSvc();
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      await controller.register(
        {
          appName: "executor-node",
          address: "10.0.0.9:3002",
          // injection attempts
          id: "existing-executor-id",
          tokenHash: "$2b$12$attackerhash",
          status: "online",
          runningTaskCount: -1000,
          version: 99,
          createdAt: "2020-01-01T00:00:00.000Z",
        } as any,
        "Bearer shared-token",
      );
      // N4: register + token issuance now goes through the idempotent
      // registerExecutor service method; the whitelist contract is unchanged.
      expect(svc.registerExecutor).toHaveBeenCalledWith(
        expect.not.objectContaining({
          id: expect.anything(),
          tokenHash: expect.anything(),
          status: expect.anything(),
          runningTaskCount: expect.anything(),
          createdAt: expect.anything(),
        }),
      );
      const forwarded = svc.registerExecutor.mock.calls[0][0];
      expect(forwarded).toMatchObject({
        appName: "executor-node",
        address: "10.0.0.9:3002",
      });
      expect(Object.keys(forwarded).sort()).toEqual(
        [
          "address",
          "appName",
          "capabilities",
          "description",
          "groupName",
          "maxConcurrent",
          "maxConcurrentTasks",
          "restartedAt",
          "runtime",
          "startupId",
          "tags",
          "type",
          "version",
        ].sort(),
      );
    });

    it("N4: returns perExecutorToken=null on idempotent re-register, token on rotate paths", async () => {
      const svc = makeSvc({
        registerExecutor: jest
          .fn()
          .mockResolvedValueOnce({
            executor: { id: "e1", address: "10.0.0.9:3002" },
            perExecutorToken: "first-issued-token",
          })
          .mockResolvedValueOnce({
            executor: { id: "e1", address: "10.0.0.9:3002" },
            perExecutorToken: null,
          }),
      });
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      const body = {
        appName: "executor-node",
        address: "10.0.0.9:3002",
        startupId: "s-1",
      } as any;

      const first = await controller.register(body, "Bearer shared-token");
      expect(first).toMatchObject({ perExecutorToken: "first-issued-token" });

      const second = await controller.register(body, "Bearer shared-token");
      expect(second).toMatchObject({ perExecutorToken: null });
      // rotateToken is never called from register anymore — the service owns
      // the rotation decision.
      expect(svc.rotateToken).not.toHaveBeenCalled();
    });
  });

  describe("F-2 family: PATCH :id metadata whitelist", () => {
    it("forwards only the four metadata fields to service.update", async () => {
      const update = jest.fn(async (id, data) => ({ id, ...data }));
      const svc = { ...makeSvc(), update };
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      await controller.update("e1", {
        groupName: "prod",
        tags: ["a"],
        description: "d",
        maxConcurrentTasks: 4,
        tokenHash: "$2b$12$attackerhash",
        version: 99,
        status: "offline",
      } as any);
      expect(update).toHaveBeenCalledWith("e1", {
        groupName: "prod",
        tags: ["a"],
        description: "d",
        maxConcurrentTasks: 4,
      });
    });
  });

  describe("reload-config SSRF + error hardening (F-3 / F-8)", () => {
    it("rejects reload-config targeting a metadata address before sending the rotated token", async () => {
      const { assertSafeExecutorUrl } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../../common/utils/safe-http.util") as {
          assertSafeExecutorUrl: jest.Mock;
        };
      assertSafeExecutorUrl.mockRejectedValueOnce(
        new UnauthorizedException("blocked"),
      );
      const svc = makeSvc({
        findOne: jest.fn().mockResolvedValue({
          id: "executor-1",
          address: "169.254.169.254:80",
          status: ExecutorStatus.ONLINE,
          type: ExecutorType.PYTHON,
        }),
        rotateToken: jest.fn().mockResolvedValue({ token: "rotated-token" }),
        getExecutorUrl: jest
          .fn()
          .mockReturnValue("http://169.254.169.254:80/api/config/reload"),
      });
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const axios = require("axios");
      await expect(
        controller.reloadConfig("executor-1", {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it("does not echo the underlying axios error message (F-8)", async () => {
      const svc = makeSvc({
        findOne: jest.fn().mockResolvedValue({
          id: "executor-1",
          address: "10.0.0.9:8001",
          status: ExecutorStatus.ONLINE,
          type: ExecutorType.PYTHON,
        }),
        rotateToken: jest.fn().mockResolvedValue({ token: "rotated-token" }),
        getExecutorUrl: jest
          .fn()
          .mockReturnValue("http://10.0.0.9:8001/api/config/reload"),
      });
      const controller = new ExecutorController(
        svc as any,
        makeConfig(),
        {} as any,
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const axios = require("axios");
      axios.post.mockRejectedValueOnce(
        new Error("connect ECONNREFUSED 10.0.0.9:8000"),
      );
      await expect(controller.reloadConfig("executor-1", {})).rejects.toThrow(
        "Failed to reach executor",
      );
      await expect(
        controller.reloadConfig("executor-1", {}),
      ).rejects.not.toThrow(/ECONNREFUSED/);
    });
  });
});
