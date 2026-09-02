import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ExecutionCallbackController } from "../execution-callback.controller";
import { TaskService } from "../task.service";
import { SystemConfigService } from "../../config/config.service";
import { ExecutorService } from "../../executor/executor.service";

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
    expect(
      Reflect.getMetadata(SKIP_KEY, handler as object),
    ).toBeUndefined();
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
    await expect(controller.callback("Bearer tok", [item])).rejects.toThrow(
      /shared token/,
    );
  });
});
