import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { CallbackItemDto } from "../dto/execution-callback.dto";
import { ExecutorService } from "../../executor/executor.service";
import { ExecutionFailureReason } from "../entities/task-execution.entity";
import { signExecutionCallbackToken } from "../execution-callback-token.util";
import { ExecutionCallbackMetricsService } from "../execution-callback-metrics.service";

const EXEC_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_TOKEN = "test-shared-secret";

const makeCallbackItem = (
  overrides: Partial<CallbackItemDto> = {},
): CallbackItemDto =>
  Object.assign(new CallbackItemDto(), {
    executionId: EXEC_UUID,
    status: "success" as const,
    durationMs: 123,
    executorAddress: "executor-python:8001",
    ...overrides,
  });

describe("ExecutionCallbackController", () => {
  let controller: ExecutionCallbackController;
  let taskService: { handleCallback: jest.Mock };
  let configService: { get: jest.Mock };
  let systemConfigService: { findOne: jest.Mock };
  let executorService: {
    validateTokenByAddress: jest.Mock;
    getCallbackSecretByAddress: jest.Mock;
  };
  // N32: real in-memory counter service — the auth-metric tests below read
  // its snapshot to assert the classification of each failure branch.
  let callbackMetrics: ExecutionCallbackMetricsService;

  beforeEach(async () => {
    taskService = {
      handleCallback: jest
        .fn()
        .mockResolvedValue([{ executionId: EXEC_UUID, success: true }]),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === "app.nodeEnv") return "test";
        if (key === "executor.sharedToken") return VALID_TOKEN;
        return undefined;
      }),
    };
    systemConfigService = {
      findOne: jest.fn().mockRejectedValue(new Error("not found")),
    };
    executorService = {
      validateTokenByAddress: jest.fn().mockResolvedValue(true),
      // N26: per-executor tokenHash candidate — default "unknown address".
      getCallbackSecretByAddress: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutionCallbackController],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ConfigService, useValue: configService },
        { provide: SystemConfigService, useValue: systemConfigService },
        { provide: ExecutorService, useValue: executorService },
        ExecutionCallbackMetricsService,
      ],
    }).compile();

    controller = module.get<ExecutionCallbackController>(
      ExecutionCallbackController,
    );
    callbackMetrics = module.get(ExecutionCallbackMetricsService);
  });

  describe("POST /executions/callback — token verification", () => {
    it("accepts per-executor dynamic token when callback includes one executorAddress", async () => {
      const item = makeCallbackItem({
        executorAddress: "executor-python:8001",
      });

      await expect(
        controller.callback("Bearer dynamic-token", [item]),
      ).resolves.toBeDefined();

      expect(executorService.validateTokenByAddress).toHaveBeenCalledWith(
        "executor-python:8001",
        "dynamic-token",
      );
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("accepts shared token for single-executor callback as fallback", async () => {
      // Single-executor batches may still use the shared token (legacy path)
      // when validateTokenByAddress rejects; this preserves backwards
      // compatibility for executors that haven't been migrated to dynamic
      // tokens yet. Multi-executor batches can NEVER use a shared token.
      executorService.validateTokenByAddress.mockResolvedValue(false);
      const item = makeCallbackItem({
        executorAddress: "executor-python:8001",
      });
      const result = await controller.callback(`Bearer ${VALID_TOKEN}`, [item]);
      expect(result.results).toBeDefined();
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("rejects shared token when callback batch spans multiple executor addresses", async () => {
      // TASK-001: a single shared token must NEVER be allowed to confirm
      // callbacks belonging to multiple executors — that would bypass
      // per-executor authentication.
      executorService.validateTokenByAddress.mockResolvedValue(false);
      await expect(
        controller.callback(`Bearer ${VALID_TOKEN}`, [
          makeCallbackItem({ executorAddress: "executor-a:8001" }),
          makeCallbackItem({
            executionId: "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7",
            executorAddress: "executor-b:8001",
          }),
        ]),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects invalid per-executor dynamic token", async () => {
      executorService.validateTokenByAddress.mockResolvedValue(false);
      // Use a non-default address so the shared-token fallback isn't tried.
      const item = makeCallbackItem({ executorAddress: "executor-bad:8001" });
      // Configure env so there is no shared token to fall back to.
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "test";
        return undefined;
      });

      await expect(
        controller.callback("Bearer bad-dynamic-token", [item]),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects wrong shared token with 401 when no executor address", async () => {
      // Items must carry executorAddress (TASK-001).
      const item = makeCallbackItem();
      item.executorAddress = undefined;
      await expect(
        controller.callback("Bearer wrong-token", [item]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects missing header with 401", async () => {
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects when no token configured (fail closed)", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "development";
        return undefined;
      });
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("accepts DB shared token for single-executor callback", async () => {
      // Single-executor batch: per-address token check fails, then we try
      // the shared-token fallback (DB > env).
      executorService.validateTokenByAddress.mockResolvedValue(false);
      const dbToken = "db-token-value";
      systemConfigService.findOne.mockResolvedValue({ value: dbToken });
      const item = makeCallbackItem({ executorAddress: "executor-a:8001" });
      const result = await controller.callback(`Bearer ${dbToken}`, [item]);
      expect(result.results).toBeDefined();
    });
  });

  describe("POST /executions/callback — business logic", () => {
    it("returns results from handleCallback", async () => {
      const expected = [
        { executionId: EXEC_UUID, success: true },
        { executionId: "another-id", success: false, error: "not found" },
      ];
      taskService.handleCallback.mockResolvedValue(expected);
      const result = await controller.callback(`Bearer ${VALID_TOKEN}`, [
        makeCallbackItem(),
        makeCallbackItem({ executionId: "another-id" }),
      ]);
      expect(result.results).toEqual(expected);
    });

    it("forwards failed status callbacks", async () => {
      taskService.handleCallback.mockResolvedValue([
        { executionId: EXEC_UUID, success: true },
      ]);
      const item = makeCallbackItem({
        status: "failed",
        errorMessage: "OOM",
        exitCode: 137,
        failureReason: ExecutionFailureReason.SCRIPT_ERROR,
      });
      await controller.callback(`Bearer ${VALID_TOKEN}`, [item]);
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("passes durationMs, logs, and executorAddress through", async () => {
      const item = makeCallbackItem({
        logs: "hello\nworld",
        durationMs: 4200,
        executorAddress: "executor-python:8001",
      });
      await controller.callback("Bearer dynamic-token", [item]);
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });
  });

  // N23: per-execution callback tokens (AUTOFLOW_CALLBACK_TOKEN injected by
  // executor-node) — HMAC `v1.` tokens bound to a single executionId.
  describe("POST /executions/callback — per-execution token (N23)", () => {
    const nowSec = () => Math.floor(Date.now() / 1000);
    const sign = (execId: string, exp: number, secret = VALID_TOKEN) =>
      signExecutionCallbackToken(secret, execId, exp);

    it("accepts a valid token bound to the batch's executionId", async () => {
      const token = sign(EXEC_UUID, nowSec() + 60);
      const item = makeCallbackItem();
      const result = await controller.callback(`Bearer ${token}`, [item]);
      expect(result.results).toBeDefined();
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
      // Per-execution tokens bypass the per-address shared-token dance.
      expect(executorService.validateTokenByAddress).not.toHaveBeenCalled();
    });

    it("accepts a token derived from the dedicated EXECUTION_CALLBACK_SECRET", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "test";
        if (key === "executionCallback.secret") return "dedicated-hmac-secret";
        if (key === "executor.sharedToken") return VALID_TOKEN;
        return undefined;
      });
      const token = sign(EXEC_UUID, nowSec() + 60, "dedicated-hmac-secret");
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).resolves.toBeDefined();
    });

    it("rejects a token whose executionId does not match a batch item", async () => {
      const token = sign("11111111-1111-4111-8111-111111111111", nowSec() + 60);
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects a batch mixing the bound execution with a foreign one", async () => {
      const token = sign(EXEC_UUID, nowSec() + 60);
      await expect(
        controller.callback(`Bearer ${token}`, [
          makeCallbackItem(),
          makeCallbackItem({
            executionId: "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7",
          }),
        ]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects an expired token", async () => {
      const token = sign(EXEC_UUID, nowSec() - 1);
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects a forged token (signed with the wrong secret)", async () => {
      const token = sign(EXEC_UUID, nowSec() + 60, "attacker-secret");
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects a validly-signed token when no secret is configured (fail closed)", async () => {
      const token = sign(EXEC_UUID, nowSec() + 60, "some-secret");
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "test";
        return undefined;
      });
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    // N27 (round-8, 方案2): the per-execution branch no longer requires
    // executorAddress — the token is execution-bound and handleCallback
    // still compares any provided address against the execution row.
    it("accepts items without executorAddress (N27: no longer mandatory on the token path)", async () => {
      const token = sign(EXEC_UUID, nowSec() + 60);
      const item = makeCallbackItem();
      item.executorAddress = undefined;
      const result = await controller.callback(`Bearer ${token}`, [item]);
      expect(result.results).toBeDefined();
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("legacy shared-token path is untouched for non-v1 tokens", async () => {
      // Regression guard: a plain bearer string keeps flowing through the
      // per-address check + shared-token fallback exactly as before.
      const item = makeCallbackItem();
      await controller.callback(`Bearer ${VALID_TOKEN}`, [item]);
      expect(executorService.validateTokenByAddress).toHaveBeenCalled();
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    // N26 (round-8, 方案A): when every fleet-global candidate fails, the
    // per-executor tokenHash (adopted by the executor at register time)
    // is tried as the HMAC key, per unique batch address.
    describe("per-executor tokenHash fallback (N26)", () => {
      const EXECUTOR_HASH = "$2b$12$perexecutorhashvalue";

      it("accepts a token signed with the per-executor tokenHash when global candidates miss", async () => {
        // No fleet-global secret configured at all.
        configService.get.mockImplementation((key: string) => {
          if (key === "app.nodeEnv") return "test";
          return undefined;
        });
        executorService.getCallbackSecretByAddress.mockResolvedValue(
          EXECUTOR_HASH,
        );
        const token = sign(EXEC_UUID, nowSec() + 60, EXECUTOR_HASH);
        const item = makeCallbackItem();
        const result = await controller.callback(`Bearer ${token}`, [item]);
        expect(result.results).toBeDefined();
        expect(executorService.getCallbackSecretByAddress).toHaveBeenCalledWith(
          "executor-python:8001",
        );
        expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
      });

      it("does not consult per-executor secrets when a global candidate verifies", async () => {
        const token = sign(EXEC_UUID, nowSec() + 60); // global VALID_TOKEN
        await controller.callback(`Bearer ${token}`, [makeCallbackItem()]);
        expect(
          executorService.getCallbackSecretByAddress,
        ).not.toHaveBeenCalled();
      });

      it("interleaved: global secret configured but token signed per-executor still verifies", async () => {
        // Global shared token IS configured (VALID_TOKEN) but the node
        // signed with its own hash — global candidates must fail over to
        // the per-executor one.
        executorService.getCallbackSecretByAddress.mockResolvedValue(
          EXECUTOR_HASH,
        );
        const token = sign(EXEC_UUID, nowSec() + 60, EXECUTOR_HASH);
        await expect(
          controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
        ).resolves.toBeDefined();
      });

      it("multi-address batch: tries each unique address once, accepts on first match", async () => {
        executorService.getCallbackSecretByAddress.mockImplementation(
          async (addr: string) =>
            addr === "executor-b:8001" ? EXECUTOR_HASH : null,
        );
        const token = sign(EXEC_UUID, nowSec() + 60, EXECUTOR_HASH);
        await expect(
          controller.callback(`Bearer ${token}`, [
            makeCallbackItem({ executorAddress: "executor-a:8001" }),
            makeCallbackItem({ executorAddress: "executor-a:8001" }),
            makeCallbackItem({ executorAddress: "executor-b:8001" }),
          ]),
        ).resolves.toBeDefined();
        expect(
          executorService.getCallbackSecretByAddress.mock.calls.map(
            (c) => c[0],
          ),
        ).toEqual(["executor-a:8001", "executor-b:8001"]);
      });

      it("rejects when the per-executor lookup yields no secret (fail closed)", async () => {
        configService.get.mockImplementation((key: string) => {
          if (key === "app.nodeEnv") return "test";
          return undefined;
        });
        executorService.getCallbackSecretByAddress.mockResolvedValue(null);
        const token = sign(EXEC_UUID, nowSec() + 60, EXECUTOR_HASH);
        await expect(
          controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(taskService.handleCallback).not.toHaveBeenCalled();
      });

      it("per-executor fallback still enforces the executionId binding", async () => {
        configService.get.mockImplementation((key: string) => {
          if (key === "app.nodeEnv") return "test";
          return undefined;
        });
        executorService.getCallbackSecretByAddress.mockResolvedValue(
          EXECUTOR_HASH,
        );
        const token = sign(
          "11111111-1111-4111-8111-111111111111",
          nowSec() + 60,
          EXECUTOR_HASH,
        );
        await expect(
          controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(taskService.handleCallback).not.toHaveBeenCalled();
      });
    });
  });

  // N32 (round-9, 交接 #3): 401 分类观测——每个失败分支必须落入
  // ExecutionCallbackMetricsService 对应分类计数，成功路径计 ok。
  describe("POST /executions/callback — auth metrics (N32)", () => {
    const nowSec = () => Math.floor(Date.now() / 1000);
    const authCounts = () => callbackMetrics.snapshot.auth;

    it("counts result=ok on the per-execution token success path", async () => {
      const token = signExecutionCallbackToken(
        VALID_TOKEN,
        EXEC_UUID,
        nowSec() + 60,
      );
      await controller.callback(`Bearer ${token}`, [makeCallbackItem()]);
      expect(authCounts().ok).toBe(1);
      expect(authCounts().v1_bad_signature).toBe(0);
    });

    it("counts result=ok on the legacy per-address success path", async () => {
      await controller.callback("Bearer dynamic-token", [makeCallbackItem()]);
      expect(authCounts().ok).toBe(1);
    });

    it("counts missing_token when no bearer token is present", async () => {
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().missing_token).toBe(1);
    });

    it("counts bad_address when a legacy item lacks executorAddress", async () => {
      const item = makeCallbackItem();
      item.executorAddress = undefined;
      await expect(
        controller.callback(`Bearer ${VALID_TOKEN}`, [item]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().bad_address).toBe(1);
    });

    it("counts v1_expired for an expired per-execution token", async () => {
      const token = signExecutionCallbackToken(
        VALID_TOKEN,
        EXEC_UUID,
        nowSec() - 1,
      );
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().v1_expired).toBe(1);
      expect(authCounts().v1_bad_signature).toBe(0);
    });

    it("counts v1_binding_mismatch when a batch item escapes the bound executionId", async () => {
      const token = signExecutionCallbackToken(
        VALID_TOKEN,
        EXEC_UUID,
        nowSec() + 60,
      );
      await expect(
        controller.callback(`Bearer ${token}`, [
          makeCallbackItem({
            executionId: "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7",
          }),
        ]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().v1_binding_mismatch).toBe(1);
    });

    it("counts v1_bad_signature for a token signed with the wrong secret", async () => {
      const token = signExecutionCallbackToken(
        "attacker-secret",
        EXEC_UUID,
        nowSec() + 60,
      );
      await expect(
        controller.callback(`Bearer ${token}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().v1_bad_signature).toBe(1);
    });

    it("counts v1_bad_signature for a malformed v1 token (not expired)", async () => {
      await expect(
        controller.callback("Bearer v1.garbage", [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().v1_bad_signature).toBe(1);
      expect(authCounts().v1_expired).toBe(0);
    });

    it("counts legacy_shared_invalid when a multi-executor batch uses one token", async () => {
      executorService.validateTokenByAddress.mockResolvedValue(false);
      await expect(
        controller.callback(`Bearer ${VALID_TOKEN}`, [
          makeCallbackItem({ executorAddress: "executor-a:8001" }),
          makeCallbackItem({
            executionId: "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7",
            executorAddress: "executor-b:8001",
          }),
        ]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().legacy_shared_invalid).toBe(1);
    });

    it("counts legacy_shared_invalid when the single-executor shared fallback also fails", async () => {
      executorService.validateTokenByAddress.mockResolvedValue(false);
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "test";
        return undefined;
      });
      await expect(
        controller.callback("Bearer wrong-shared-token", [
          makeCallbackItem({ executorAddress: "executor-a:8001" }),
        ]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(authCounts().legacy_shared_invalid).toBe(1);
    });
  });
});
