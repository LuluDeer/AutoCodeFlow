import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { CallbackItemDto } from "../dto/execution-callback.dto";

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutionCallbackController],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ConfigService, useValue: configService },
        { provide: SystemConfigService, useValue: systemConfigService },
      ],
    }).compile();

    controller = module.get<ExecutionCallbackController>(ExecutionCallbackController);
  });

  describe("POST /executions/callback — token verification", () => {
    it("accepts valid Bearer token", async () => {
      const result = await controller.callback(
        `Bearer ${VALID_TOKEN}`,
        [makeCallbackItem()],
      );
      expect(result).toEqual({ results: [{ executionId: EXEC_UUID, success: true }] });
      expect(taskService.handleCallback).toHaveBeenCalledTimes(1);
    });

    it("accepts token without Bearer prefix", async () => {
      await expect(
        controller.callback(VALID_TOKEN, [makeCallbackItem()]),
      ).resolves.toBeDefined();
    });

    it("rejects wrong token with 401", async () => {
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

    it("passes when no token configured in non-production", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "app.nodeEnv") return "development";
        if (key === "executor.sharedToken") return "";
        return undefined;
      });
      // No token configured in DB either (already set to throw)
      await expect(
        controller.callback(undefined, [makeCallbackItem()]),
      ).resolves.toBeDefined();
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

    it("prefers DB token over env token", async () => {
      const dbToken = "db-token-value";
      systemConfigService.findOne.mockResolvedValue({ value: dbToken });
      await expect(
        controller.callback(`Bearer ${dbToken}`, [makeCallbackItem()]),
      ).resolves.toBeDefined();
      // Old env token should now be rejected
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
      });
      await controller.callback(`Bearer ${VALID_TOKEN}`, [item]);
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });

    it("passes durationMs and logs through", async () => {
      const item = makeCallbackItem({ logs: "hello\nworld", durationMs: 4200 });
      await controller.callback(`Bearer ${VALID_TOKEN}`, [item]);
      expect(taskService.handleCallback).toHaveBeenCalledWith([item]);
    });
  });
});
