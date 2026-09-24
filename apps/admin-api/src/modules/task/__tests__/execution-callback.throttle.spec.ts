import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";
import { ExecutionCallbackMetricsService } from "../execution-callback-metrics.service";

/**
 * F-5: /api/executions/callback used to be fully @SkipThrottle()'d while its
 * handler runs bcrypt token validation + 55 MB JSON parsing. The class must no
 * longer skip the global ThrottlerGuard, and the callback route must carry its
 * own relaxed-but-finite limit (60 req/min — executors legitimately send
 * ~2/min, so this gives 30x headroom).
 */
const SKIP_KEY = "THROTTLER:SKIPdefault";
const LIMIT_KEY = "THROTTLER:LIMITdefault";
const TTL_KEY = "THROTTLER:TTLdefault";

describe("ExecutionCallbackController — F-5 rate limiting", () => {
  let controller: ExecutionCallbackController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutionCallbackController],
      providers: [
        { provide: TaskService, useValue: { handleCallback: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { findOne: jest.fn() } },
        {
          provide: ExecutorService,
          useValue: { validateTokenByAddress: jest.fn() },
        },
        // N32: real in-memory counter instance (behaviour under test is the
        // throttler metadata, not the counting).
        ExecutionCallbackMetricsService,
      ],
    }).compile();
    controller = module.get<ExecutionCallbackController>(
      ExecutionCallbackController,
    );
  });

  it("no longer skips the throttler (SkipThrottle removed)", () => {
    const handler = Object.getOwnPropertyDescriptor(
      ExecutionCallbackController.prototype,
      "callback",
    )?.value;
    expect(Reflect.getMetadata(SKIP_KEY, handler as object)).toBeUndefined();
  });

  it("applies a finite per-minute limit to the callback route", () => {
    const handler = Object.getOwnPropertyDescriptor(
      ExecutionCallbackController.prototype,
      "callback",
    )?.value;
    const limit = Reflect.getMetadata(LIMIT_KEY, handler as object);
    const ttl = Reflect.getMetadata(TTL_KEY, handler as object);
    expect(limit).toBe(60);
    expect(ttl).toBe(60_000);
  });

  it("handler still rejects an unauthenticated batch (smoke — decorator change did not alter DI)", async () => {
    const item: any = {
      executionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      status: "success",
      executorAddress: "executor-a:8001",
    };
    // No shared token configured in this harness → the handler must still
    // fail closed with UnauthorizedException (behaviour unchanged by F-5).
    await expect(
      controller.callback("Bearer tok", undefined, [item]),
    ).rejects.toThrow(/shared token/);
  });

  // RT-LOG: 实时日志流端点自带档位。它与 callback 同属**机器面**（速率由
  // 执行器输出节奏决定，不是人点出来的），因此不能落进 60/min 的全局默认档
  // ——一个话痨任务每秒可能推好几片，60/min 会让日志在执行中途被限流截断，
  // 而这恰恰是本端点要修的问题。档位必须显式且高于全局默认。
  describe("RT-LOG: POST /executions/:id/logs rate limiting", () => {
    const handlerOf = (name: string) =>
      Object.getOwnPropertyDescriptor(
        ExecutionCallbackController.prototype,
        name,
      )?.value;

    it("carries its own finite limit above the global default", () => {
      const limit = Reflect.getMetadata(LIMIT_KEY, handlerOf("appendLogChunk"));
      const ttl = Reflect.getMetadata(TTL_KEY, handlerOf("appendLogChunk"));
      expect(limit).toBe(120);
      expect(ttl).toBe(60_000);
      // 必须高于全局默认 60——否则实时流会被限流成「比回调还慢」。
      expect(limit).toBeGreaterThan(60);
    });

    it("does not skip the throttler", () => {
      expect(
        Reflect.getMetadata(SKIP_KEY, handlerOf("appendLogChunk")),
      ).toBeUndefined();
    });

    it("limit is configurable via THROTTLE_LOG_STREAM_LIMIT (no silent hardcode)", () => {
      // 与 CALLBACK_THROTTLE 同款可配：多执行器同出口（NAT）时按
      // 「执行器数 × 分片/分钟」上调，无需改代码。
      //
      // 档位常量在**模块求值期**固化（W-22 现场：装饰器参数早于 ConfigModule
      // 生命周期），故只能靠 jest.isolateModules + 重设 env 后重新求值模块来
      // 观测——这也是本文件其余用例读 Reflect 元数据的原因。
      const prev = process.env.THROTTLE_LOG_STREAM_LIMIT;
      process.env.THROTTLE_LOG_STREAM_LIMIT = "500";
      try {
        let limit: unknown;
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require("../execution-callback.controller");
          limit = Reflect.getMetadata(
            LIMIT_KEY,
            Object.getOwnPropertyDescriptor(
              mod.ExecutionCallbackController.prototype,
              "appendLogChunk",
            )?.value,
          );
        });
        expect(limit).toBe(500);
      } finally {
        if (prev === undefined) delete process.env.THROTTLE_LOG_STREAM_LIMIT;
        else process.env.THROTTLE_LOG_STREAM_LIMIT = prev;
      }
    });
  });
});
