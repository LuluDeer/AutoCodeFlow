/**
 * RT-LOG 反证：`POST /executions/:id/logs` 的授权与落库语义。
 *
 * 这个端点把「执行中的日志」提前落进 ExecutionLogLine（既有 SSE 通路据此
 * 实时推送），因此它的两条失败模式都很安静、也很贵：
 *
 * ① 授权按**路径上的 executionId** 收敛。首版沿用了 callback 的"批量"形态，
 *    但单执行端点若只验签、不校验 `claims.executionId === executionId`，
 *    任一执行器签发的合法 v1 令牌就能往**别人**的执行里写日志（伪造/污染
 *    他人执行日志）。用例把"绑定不匹配必须 401"钉死。
 * ② 回调的**截断**日志不得覆盖实时流已落的行。执行器内存里只留头尾
 *    （LOG_TRUNCATION_MARKER），终态回调若照旧走 storeLogLines 的 replace
 *    语义，用户看到的终态日志会比执行过程中**更少**——实时流白做。
 *    两条路径（winner 与重复回调补写）都必须保留既有行。
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";
import { ExecutionCallbackMetricsService } from "../execution-callback-metrics.service";
import {
  signExecutionCallbackToken,
  EXECUTION_CALLBACK_TOKEN_PREFIX,
} from "../execution-callback-token.util";
import { AppendLogChunkDto } from "../dto/append-log-chunk.dto";

const EXEC_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const OTHER_UUID = "6b4adba5-a2f8-4fe7-bf4f-5277d0d7f2b7";
const SHARED_SECRET = "test-shared-secret";
const ADDRESS = "executor-node:8001";

const makeDto = (
  overrides: Partial<AppendLogChunkDto> = {},
): AppendLogChunkDto =>
  Object.assign(new AppendLogChunkDto(), {
    fromLine: 0,
    lines: ["hello", "world"],
    ...overrides,
  });

/** v1 令牌签名：签名的实参序是 (secret, executionId, expiresAtSec)。 */
const nowSec = () => Math.floor(Date.now() / 1000);
const sign = (execId: string, exp = nowSec() + 60, secret = SHARED_SECRET) =>
  signExecutionCallbackToken(secret, execId, exp);

describe("ExecutionCallbackController — POST /executions/:id/logs (RT-LOG)", () => {
  let controller: ExecutionCallbackController;
  let taskService: {
    appendLogChunk: jest.Mock;
    findExecutionAddress: jest.Mock;
  };
  let configService: { get: jest.Mock };
  let systemConfigService: { findOne: jest.Mock };
  let executorService: {
    validateTokenByAddress: jest.Mock;
    getCallbackSecretByAddress: jest.Mock;
  };
  let callbackMetrics: ExecutionCallbackMetricsService;

  const authCounts = () => callbackMetrics.snapshot.auth;

  beforeEach(async () => {
    taskService = {
      appendLogChunk: jest.fn().mockResolvedValue({ count: 2 }),
      findExecutionAddress: jest.fn().mockResolvedValue(ADDRESS),
    };
    configService = {
      get: jest.fn((key: string) => {
        if (key === "app.nodeEnv") return "test";
        if (key === "executor.sharedToken") return SHARED_SECRET;
        if (key === "executionCallback.secret") return SHARED_SECRET;
        return undefined;
      }),
    };
    systemConfigService = {
      findOne: jest.fn().mockRejectedValue(new Error("not found")),
    };
    executorService = {
      validateTokenByAddress: jest.fn().mockResolvedValue(true),
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

    controller = module.get(ExecutionCallbackController);
    callbackMetrics = module.get(ExecutionCallbackMetricsService);
  });

  it("v1 令牌绑定到本执行时落库，并把 fromLine/lines 原样交给 service", async () => {
    const token = sign(EXEC_UUID);
    expect(token.startsWith(EXECUTION_CALLBACK_TOKEN_PREFIX)).toBe(true);

    const dto = makeDto({ fromLine: 42, lines: ["a", "b"] });
    await expect(
      controller.appendLogChunk(EXEC_UUID, `Bearer ${token}`, dto),
    ).resolves.toEqual({ count: 2 });

    expect(taskService.appendLogChunk).toHaveBeenCalledWith(EXEC_UUID, 42, [
      "a",
      "b",
    ]);
  });

  it("① v1 令牌绑定到**别的**执行时必须 401（不得跨执行写日志）", async () => {
    const token = sign(OTHER_UUID);

    await expect(
      controller.appendLogChunk(EXEC_UUID, `Bearer ${token}`, makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(taskService.appendLogChunk).not.toHaveBeenCalled();
    expect(authCounts().v1_bad_signature).toBe(1);
  });

  it("① v1 令牌过期时 401（fail-closed）并计入 v1_expired", async () => {
    const token = sign(EXEC_UUID, nowSec() - 1);

    await expect(
      controller.appendLogChunk(EXEC_UUID, `Bearer ${token}`, makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(taskService.appendLogChunk).not.toHaveBeenCalled();
    expect(authCounts().v1_expired).toBe(1);
  });

  it("① v1 令牌签名不合法时 401，且不落库", async () => {
    await expect(
      controller.appendLogChunk(EXEC_UUID, "Bearer v1.garbage", makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(taskService.appendLogChunk).not.toHaveBeenCalled();
    expect(authCounts().v1_bad_signature).toBe(1);
  });

  it("① per-executor 兜底：fleet 全局密钥不匹配时用该执行行的 tokenHash 验签", async () => {
    const token = sign(EXEC_UUID, nowSec() + 60, "per-executor-secret");
    executorService.getCallbackSecretByAddress.mockResolvedValue(
      "per-executor-secret",
    );

    await expect(
      controller.appendLogChunk(EXEC_UUID, `Bearer ${token}`, makeDto()),
    ).resolves.toEqual({ count: 2 });

    expect(taskService.findExecutionAddress).toHaveBeenCalledWith(EXEC_UUID);
    expect(executorService.getCallbackSecretByAddress).toHaveBeenCalledWith(
      ADDRESS,
    );
  });

  it("① 非 v1 令牌走 per-address 校验（地址取自该执行行）", async () => {
    await expect(
      controller.appendLogChunk(EXEC_UUID, "Bearer dynamic-token", makeDto()),
    ).resolves.toEqual({ count: 2 });

    expect(executorService.validateTokenByAddress).toHaveBeenCalledWith(
      ADDRESS,
      "dynamic-token",
    );
  });

  it("① 非 v1 令牌且 per-address 失败时退共享令牌", async () => {
    executorService.validateTokenByAddress.mockResolvedValue(false);

    await expect(
      controller.appendLogChunk(
        EXEC_UUID,
        `Bearer ${SHARED_SECRET}`,
        makeDto(),
      ),
    ).resolves.toEqual({ count: 2 });
  });

  it("① 执行行不存在时 401（bad_address），不落库", async () => {
    taskService.findExecutionAddress.mockResolvedValue(null);

    await expect(
      controller.appendLogChunk(EXEC_UUID, "Bearer dynamic-token", makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(taskService.appendLogChunk).not.toHaveBeenCalled();
    expect(authCounts().bad_address).toBe(1);
  });

  it("① 缺 token 头时 401 并计入 missing_token", async () => {
    await expect(
      controller.appendLogChunk(EXEC_UUID, undefined, makeDto()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(taskService.appendLogChunk).not.toHaveBeenCalled();
    expect(authCounts().missing_token).toBe(1);
  });

  it("空 lines 由 service 短路为 count:0（不写空片）", async () => {
    const token = sign(EXEC_UUID);
    taskService.appendLogChunk.mockResolvedValue({ count: 0 });

    await expect(
      controller.appendLogChunk(
        EXEC_UUID,
        `Bearer ${token}`,
        makeDto({ lines: [] }),
      ),
    ).resolves.toEqual({ count: 0 });
  });
});
