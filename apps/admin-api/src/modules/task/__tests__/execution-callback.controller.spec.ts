import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { CallbackItemDto } from "../dto/execution-callback.dto";
import { ExecutorService } from "../../executor/executor.service";
import { ExecutionFailureReason } from "../entities/task-execution.entity";

const EXEC_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_TOKEN = "test-shared-secret";

const makeCallbackItem = (overrides: Partial<CallbackItemDto> = {}): CallbackItemDto =>
  Object.assign(new CallbackItemDto(), {
    executionId: EXEC_UUID,
    status: "success" as const,
    durationMs: 123,
    ...overrides,
  });

describe("ExecutionCallbackController", () => {
  let controller: ExecutionCallbackController;
  let taskService: { handleCallback: jest.Mock };
  let configService: { get: jest.Mock };
  let systemConfigService: { findOne: jest.Mock };
  let executorService: { validateTokenByAddress: jest.Mock };

  beforeEach(async () => {
    taskService = { handleCallback: jest.fn().mockResolvedValue([{ executionId: EXEC_UUID, success: true }]) };
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutionCallbackController],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ConfigService, useValue: configService },
        { provide: SystemConfigService, useValue: systemConfigService },
        { provide: ExecutorService, useValue: executorService },
      ],
    }).compile();

    controller = module.get<ExecutionCallbackController>(ExecutionCallbackController);
  });

  describe("POST /executions/callback — token verification", () => {
    it("accepts valid Bearer shared token", async () => {
      const result = await controller.callback(
        `Bearer ${VALID_TOKEN}`,
        [makeCallbackItem()],
      );
      expect(result).toEqual({ results: [{ executionId: EXEC_UUID, success: true }] });
      expect(taskService.handleCallback).toHaveBeenCalledTimes(1);
      expect(executorService.validateTokenByAddress).not.toHaveBeenCalled();
    });

    it("accepts shared token without Bearer prefix", async () => {
      await expect(
        controller.callback(VALID_TOKEN, [makeCallbackItem()]),
      ).resolves.toBeDefined();
    });

    it("accepts per-executor dynamic token when callback includes one executorAddress", async () => {
      const item = makeCallbackItem({ executorAddress: "executor-python:8001" });

      await expect(
        controller.callback("Bearer dynamic-token", [item]),
      ).resolves.toBeDefined();

      expect(executorService.validateTokenByAddress).toHaveBeenCalledWith(
        "executor-python:8001",
        "dynamic-token",
      );
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("rejects invalid per-executor dynamic token", async () => {
      executorService.validateTokenByAddress.mockResolvedValue(false);
      const item = makeCallbackItem({ executorAddress: "executor-python:8001" });

      await expect(
        controller.callback("Bearer bad-dynamic-token", [item]),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("falls back to shared token when callback batch has multiple executor addresses", async () => {
      await expect(
        controller.callback(`Bearer ${VALID_TOKEN}`, [
          makeCallbackItem({ executorAddress: "executor-a:8001" }),
          makeCallbackItem({ executionId: "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7", executorAddress: "executor-b:8001" }),
        ]),
      ).resolves.toBeDefined();

      expect(executorService.validateTokenByAddress).not.toHaveBeenCalled();
    });

    it("rejects wrong shared token with 401", async () => {
      await expect(
        controller.callback("Bearer wrong-token", [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("rejects missing header with 401 when token is configured", async () => {
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects when no token configured in non-production (fail closed)", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "development";
        if (key === "executor.sharedToken") return "";
        return undefined;
      });
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.handleCallback).not.toHaveBeenCalled();
    });

    it("throws in production when no token configured", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "production";
        if (key === "executor.sharedToken") return "";
        return undefined;
      });
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("prefers DB shared token over env token", async () => {
      const dbToken = "db-token-value";
      systemConfigService.findOne.mockResolvedValue({ value: dbToken });
      await expect(
        controller.callback(`Bearer ${dbToken}`, [makeCallbackItem()]),
      ).resolves.toBeDefined();
      await expect(
        controller.callback(`Bearer ${VALID_TOKEN}`, [makeCallbackItem()]),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("POST /executions/callback — business logic", () => {
    it("returns results from handleCallback", async () => {
      const expected = [
        { executionId: EXEC_UUID, success: true },
        { executionId: "another-id", success: false, error: "not found" },
      ];
      taskService.handleCallback.mockResolvedValue(expected);
      const result = await controller.callback(
        `Bearer ${VALID_TOKEN}`,
        [makeCallbackItem(), makeCallbackItem({ executionId: "another-id" })],
      );
      expect(result.results).toEqual(expected);
    });

    it("forwards failed status callbacks", async () => {
      taskService.handleCallback.mockResolvedValue([{ executionId: EXEC_UUID, success: true }]);
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
});
