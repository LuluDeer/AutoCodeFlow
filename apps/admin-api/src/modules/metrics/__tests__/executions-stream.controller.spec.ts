/**
 * FEAT-16：GET /executions/stream（执行列表终态推送流）行为契约。
 *
 * 覆盖：SSE 头、槽位复用（占用/释放/超限 503）、领域事件 → SSE 帧转发
 * （completed/failed/killed 三事件名与载荷透传）、断连清理（abort + 监听器
 * 注销）、done 终止帧、事件帧刷新保活时钟（有事件期间不发 ping）。
 *
 * 对齐 metrics-stream.controller.spec 先例：@Res() library mode 用 mock res，
 * 事件用 DomainEventBus 真实例（emit/on/off 语义全真），不 fake timers。
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionsStreamController } from "../executions-stream.controller";
import { MetricsStreamSlotService } from "../metrics-stream-slot.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../../common/events/domain-events";
import { resetRuntimeGauges } from "../runtime-metrics-entry";

interface MockRes {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
  setHeader: (k: string, v: string) => void;
  flushHeaders: () => void;
  write: (chunk: string) => boolean;
  end: () => void;
  on: (event: string, cb: () => void) => void;
  writableEnded: boolean;
}

function makeMockRes(): { res: MockRes; close: () => void } {
  const res: MockRes = {
    headers: {},
    writes: [],
    ended: false,
    setHeader: (k, v) => {
      res.headers[k] = v;
    },
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      res.writes.push(chunk);
      return true;
    },
    end: () => {
      res.ended = true;
      res.writableEnded = true;
    },
    on: (_event, _cb) => undefined,
    writableEnded: false,
  };
  return { res, close: () => undefined };
}

function terminalPayload(
  over: Partial<ExecutionTerminalEventPayload> = {},
): ExecutionTerminalEventPayload {
  return {
    executionId: "exec-1",
    taskId: "task-1",
    taskName: "备份任务",
    status: "success",
    failureReason: null,
    durationMs: 60_000,
    finishedAt: new Date("2026-09-09T00:00:00Z").toISOString(),
    ...over,
  };
}

/** 与 metrics-stream spec 同款 SSE 帧解析（event 名 + data 行）。 */
function parseFrames(
  writes: string[],
): Array<{ event?: string; data?: string; comment?: boolean }> {
  const frames: Array<{ event?: string; data?: string; comment?: boolean }> =
    [];
  let current: { event?: string; data?: string; comment?: boolean } = {};
  for (const chunk of writes) {
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) {
        frames.push({ comment: true, data: line });
      } else if (line.startsWith("event:")) {
        current.event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        current.data = line.slice("data:".length).trim();
        frames.push({ ...current });
        current = {};
      }
    }
  }
  return frames;
}

async function makeModule(config: Record<string, number> = {}) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [ExecutionsStreamController],
    providers: [
      DomainEventBus,
      MetricsStreamSlotService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            const [section, leaf] = key.split(".");
            if (section === "executionsStream") return config[leaf];
            return undefined;
          },
        },
      },
    ],
  }).compile();
  const controller = module.get<ExecutionsStreamController>(
    ExecutionsStreamController,
  );
  const slots = module.get<MetricsStreamSlotService>(MetricsStreamSlotService);
  const bus = module.get<DomainEventBus>(DomainEventBus);
  return { controller, slots, bus };
}

describe("ExecutionsStreamController — GET /executions/stream（FEAT-16）", () => {
  beforeEach(() => {
    resetRuntimeGauges();
  });

  it("写出标准 SSE 头且无快照帧（事件驱动流不发快照）", async () => {
    const { controller } = await makeModule();
    const { res } = makeMockRes();

    let closeCb: (() => void) | null = null;
    const done = controller.stream(
      {
        on: (_e: string, cb: () => void) => {
          closeCb = cb;
        },
      } as never,
      res as never,
    );
    await new Promise((r) => setImmediate(r));

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    // 无快照帧：建连后（未 emit 事件前）零数据帧
    expect(parseFrames(res.writes).filter((f) => !f.comment)).toHaveLength(0);

    (closeCb as () => void)();
    await done;
  });

  it("终态事件转发为同名 SSE 帧，载荷 JSON 透传（completed/failed/killed 三事件）", async () => {
    const { controller, bus } = await makeModule();
    const { res } = makeMockRes();

    let closeCb: (() => void) | null = null;
    const done = controller.stream(
      {
        on: (_e: string, cb: () => void) => {
          closeCb = cb;
        },
      } as never,
      res as never,
    );

    // 等监听器注册完成（建流同步段内已注册）
    await new Promise((r) => setImmediate(r));

    const completed = terminalPayload({ status: "success", executionId: "e1" });
    const failed = terminalPayload({
      status: "failed",
      executionId: "e2",
      failureReason: "script_error",
      errorMessage: "boom",
    });
    const killed = terminalPayload({ status: "killed", executionId: "e3" });
    bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, completed);
    bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, failed);
    bus.emit(DOMAIN_EVENTS.EXECUTION_KILLED, killed);

    await new Promise((r) => setImmediate(r));
    (closeCb as () => void)();
    await done;

    const frames = parseFrames(res.writes).filter(
      (f) => !f.comment && f.event !== "done" && f.event !== "error",
    );
    expect(frames.length).toBe(3);
    expect(frames[0].event).toBe("execution.completed");
    expect(JSON.parse(frames[0].data)).toEqual(completed);
    expect(frames[1].event).toBe("execution.failed");
    expect(JSON.parse(frames[1].data)).toEqual(failed);
    expect(frames[2].event).toBe("execution.killed");
    expect(JSON.parse(frames[2].data)).toEqual(killed);
  });

  it("断连后监听器注销：off 后再 emit 不写已结束的响应", async () => {
    const { controller, bus } = await makeModule();
    const { res } = makeMockRes();

    let closeCb: (() => void) | null = null;
    const done = controller.stream(
      {
        on: (_e: string, cb: () => void) => {
          closeCb = cb;
        },
      } as never,
      res as never,
    );
    await new Promise((r) => setImmediate(r));
    (closeCb as () => void)();
    await done;

    const writesAtClose = res.writes.length;
    bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, terminalPayload());
    await new Promise((r) => setImmediate(r));

    expect(res.writes.length).toBe(writesAtClose);
    expect(res.ended).toBe(true);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_COMPLETED)).toBe(0);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_FAILED)).toBe(0);
    expect(bus.listenerCount(DOMAIN_EVENTS.EXECUTION_KILLED)).toBe(0);
  });

  it("断连收尾发 done 帧；槽位归还回零", async () => {
    const { controller, slots } = await makeModule();
    const { res } = makeMockRes();

    let closeCb: (() => void) | null = null;
    const done = controller.stream(
      {
        on: (_e: string, cb: () => void) => {
          closeCb = cb;
        },
      } as never,
      res as never,
    );
    expect(slots.active).toBe(1);
    await new Promise((r) => setImmediate(r));
    (closeCb as () => void)();
    await done;

    expect(slots.active).toBe(0);
    expect(res.ended).toBe(true);
    expect(parseFrames(res.writes).some((f) => f.event === "done")).toBe(true);
  });

  it("超限拒绝在写 SSE 头之前：503 且零响应头（复用 metrics 流槽位）", async () => {
    const { controller, slots } = await makeModule();
    const releasers: Array<() => void> = [];
    for (let i = 0; i < 32; i++) releasers.push(slots.acquireSlot());

    const { res } = makeMockRes();
    await expect(
      controller.stream({ on: () => undefined } as never, res as never),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(Object.keys(res.headers)).toHaveLength(0);
    expect(res.writes).toHaveLength(0);

    for (const r of releasers) r();
  });

  it("监听器抛错被总线 fail-open 吞掉：sendEvent 异常不影响主循环", async () => {
    const { controller, bus } = await makeModule();
    const { res } = makeMockRes();

    let closeCb: (() => void) | null = null;
    const done = controller.stream(
      {
        on: (_e: string, cb: () => void) => {
          closeCb = cb;
        },
      } as never,
      res as never,
    );
    await new Promise((r) => setImmediate(r));

    // 置响应为已结束态后 emit——sendEvent 内 write 短路，不抛错；
    // 即便抛错也被 DomainEventBus fail-open 捕获。
    res.writableEnded = true;
    expect(() =>
      bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, terminalPayload()),
    ).not.toThrow();

    (closeCb as () => void)();
    await done;
  });
});
