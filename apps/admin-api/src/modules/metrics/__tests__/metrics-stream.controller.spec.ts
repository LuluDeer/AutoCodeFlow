/**
 * UI-14 第一阶段：GET /metrics/stream（Dashboard 汇总 SSE）行为契约。
 *
 * 覆盖：鉴权路由豁免不在此处（jwt.strategy / metrics/stream 后缀已在
 * auth 侧 spec 面覆盖）；本 spec 断言控制器级行为——SSE 头、槽位占用/释放
 * （含 503 超限）、快照载荷结构、节流节奏、断连清理、查询失败 fail-open
 * 降级、done 终止帧。
 *
 * SSE 主循环依赖真实计时器；用 intervalMs=0 + 中途 abort 的方式确定性推进，
 * 不使用 fake timers（避免与 Promise 微任务时序耦合）。
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { MetricsStreamController } from "../metrics-stream.controller";
import { MetricsStreamSlotService } from "../metrics-stream-slot.service";
import { MetricsService } from "../metrics.service";
import {
  resetRuntimeGauges,
  getRuntimeGaugesSnapshot,
} from "../runtime-metrics-entry";

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

const summaryFixture = {
  totalTasks: 3,
  todayRuns: 12,
  totalExecutors: 2,
  onlineExecutors: 2,
  executions: { total: 120, success: 110, failed: 10, running: 1 },
  successRate: 91.7,
  avgDurationMs: 3200,
};
const executorStatsFixture = [
  {
    id: "exec-1",
    appName: "alpha",
    address: "10.0.0.1:3002",
    status: "online",
    cpuUsage: 30,
    memUsage: 50,
    runningTaskCount: 1,
    lastHeartbeat: new Date().toISOString(),
  },
];
const schedulerFixture = {
  counters: { ticks: 10, triggersClaimed: 2 },
  derived: { avgTickDurationMs: 5 },
  queue: { waiting: 1, active: 0, delayed: 2, failed: 0, completed: 7 },
  scheduler: { healthy: true, isLeader: true },
  instance: { pid: 1, hostname: "t" },
};

function makeSvc(over: Partial<Record<"getSummary" | "getExecutorStats" | "getSchedulerMetrics", jest.Mock>> = {}) {
  return {
    getSummary: over.getSummary ?? jest.fn().mockResolvedValue(summaryFixture),
    getExecutorStats:
      over.getExecutorStats ?? jest.fn().mockResolvedValue(executorStatsFixture),
    getSchedulerMetrics:
      over.getSchedulerMetrics ?? jest.fn().mockResolvedValue(schedulerFixture),
  };
}

async function makeModule(
  svc: ReturnType<typeof makeSvc>,
  config: Record<string, number> = { intervalMs: 0, idlePingMs: 15_000 },
) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [MetricsStreamController],
    providers: [
      MetricsStreamSlotService,
      { provide: MetricsService, useValue: svc },
      {
        provide: ConfigService,
        // 控制器经 configService.get("metricsStream.intervalMs") 读取——
        // 打桩按点路径键分发（等价真实 ConfigService 的嵌套取值行为）
        useValue: {
          get: (key: string) => {
            const [section, leaf] = key.split(".");
            if (section === "metricsStream") return config[leaf];
            return undefined;
          },
        },
      },
    ],
  }).compile();
  const controller = module.get<MetricsStreamController>(MetricsStreamController);
  const slots = module.get<MetricsStreamSlotService>(MetricsStreamSlotService);
  return { controller, slots };
}

function parseFrames(writes: string[]): Array<{ event?: string; data?: string; comment?: boolean }> {
  const frames: Array<{ event?: string; data?: string; comment?: boolean }> = [];
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

describe("MetricsStreamController — GET /metrics/stream（UI-14 第一阶段）", () => {
  beforeEach(() => {
    resetRuntimeGauges();
  });

  function makeReq(onClose?: () => void): { on: jest.Mock } {
    return { on: jest.fn().mockImplementation((_e: string, cb: () => void) => { onClose?.(); }) };
  }

  it("写出标准 SSE 头并推送首个快照（summary+executors+scheduler 三段齐备）", async () => {
    const svc = makeSvc();
    const { controller } = await makeModule(svc);
    const { res } = makeMockRes();
    const req = makeReq();

    const done = controller.stream(req as never, res as never);
    // 首拍完成后 abort 收尾（setImmediate 让出微任务，保证首帧已写出）
    const close = req.on.mock.calls.find(([e]: [string]) => e === "close")?.[1] as () => void;
    setImmediate(() => close());
    await done;

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.ended).toBe(true);

    const frames = parseFrames(res.writes);
    const dataFrames = frames.filter((f) => !f.comment && f.event !== "done" && f.event !== "error");
    expect(dataFrames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(dataFrames[0].data) as Record<string, unknown>;
    expect(payload.summary).toEqual(summaryFixture);
    expect(payload.executors).toEqual(executorStatsFixture);
    expect(payload.scheduler).toEqual(schedulerFixture);
    expect(payload.errors).toEqual([]);

    const doneFrame = frames.find((f) => f.event === "done");
    expect(doneFrame).toBeTruthy();
  });

  it("超限拒绝在写 SSE 头之前：503 ServiceUnavailableException 且零响应头", async () => {
    const svc = makeSvc();
    const { controller, slots } = await makeModule(svc);
    // 吃满上限（config 缺省 32）
    const max = 32;
    const releasers: Array<() => void> = [];
    for (let i = 0; i < max; i++) releasers.push(slots.acquireSlot());

    const { res } = makeMockRes();
    await expect(
      controller.stream(makeReq() as never, res as never),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(Object.keys(res.headers)).toHaveLength(0);
    expect(res.writes).toHaveLength(0);

    for (const r of releasers) r();
  });

  it("断连清理：close 事件 abort 后槽位归还（active 回零）", async () => {
    const svc = makeSvc();
    // intervalMs 大：主循环停留在等待段，等 req close 触发 abort
    const { controller, slots } = await makeModule(svc, { intervalMs: 60_000, idlePingMs: 15_000 });
    let closeCb: (() => void) | null = null;
    const req = { on: jest.fn().mockImplementation((_e: string, cb: () => void) => { closeCb = cb; }) };
    const { res } = makeMockRes();

    const done = controller.stream(req as never, res as never);
    expect(slots.active).toBe(1);
    expect(typeof closeCb).toBe("function");
    (closeCb as () => void)(); // 模拟客户端断开
    await done;

    expect(slots.active).toBe(0);
    expect(res.ended).toBe(true);
    const frames = parseFrames(res.writes);
    // 首个快照已写出（abort 前完成），终止以 done 帧收尾
    expect(frames.some((f) => f.event === "done")).toBe(true);
  });

  it("节流：intervalMs 覆盖生效（快照间等待按配置推进）", async () => {
    const svc = makeSvc();
    // intervalMs=40：至少推送 2 拍后手动 abort 结束（留 110ms 余量 > 2×40ms）
    const { controller, slots } = await makeModule(svc, { intervalMs: 40, idlePingMs: 15_000 });
    let closeCb: (() => void) | null = null;
    const req = { on: jest.fn().mockImplementation((_e: string, cb: () => void) => { closeCb = cb; }) };
    const { res } = makeMockRes();

    const done = controller.stream(req as never, res as never);
    await new Promise((r) => setTimeout(r, 200));
    (closeCb as () => void)();
    await done;
    void slots;

    const dataFrames = parseFrames(res.writes).filter(
      (f) => !f.comment && f.event !== "done" && f.event !== "error",
    );
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
  });

  it("查询失败 fail-open：summary 段降级为 null + error 帧，流不终止", async () => {
    const svc = makeSvc({
      getSummary: jest.fn().mockRejectedValue(new Error("pg down")),
    });
    const { controller } = await makeModule(svc);
    const { res } = makeMockRes();
    const req = makeReq();

    const done = controller.stream(req as never, res as never);
    // 首拍（含 error 帧 + 降级快照）后 abort 收尾
    const close = req.on.mock.calls.find(([e]: [string]) => e === "close")?.[1] as () => void;
    setImmediate(() => close());
    await done;

    const frames = parseFrames(res.writes);
    const errorFrame = frames.find((f) => f.event === "error");
    expect(errorFrame).toBeTruthy();
    const payload = JSON.parse(
      frames.filter((f) => !f.comment && f.event !== "done" && f.event !== "error")[0].data,
    ) as { summary: unknown; executors: unknown; scheduler: unknown; errors: string[] };
    expect(payload.summary).toBeNull();
    expect(payload.executors).toEqual(executorStatsFixture);
    expect(payload.scheduler).toEqual(schedulerFixture);
    expect(payload.errors).toEqual(["summary"]);
    // 流仍正常收尾
    expect(res.ended).toBe(true);
  });

  it("释放幂等：releaseSlot 双调用（控制器 finally + 内部兜底）只归一次", async () => {
    const svc = makeSvc();
    const { slots } = await makeModule(svc);
    const release = slots.acquireSlot();
    expect(slots.active).toBe(1);
    release();
    release(); // 幂等
    expect(slots.active).toBe(0);
  });

  it("BUG-05 同款水位 gauge：占用/释放两点写 active/limit 双 series", async () => {
    resetRuntimeGauges();
    const svc = makeSvc();
    const { slots } = await makeModule(svc);
    const r1 = slots.acquireSlot();
    expect(getRuntimeGaugesSnapshot().get("autoflow_metrics_streams_active")).toBe(1);
    expect(getRuntimeGaugesSnapshot().get("autoflow_metrics_streams_limit")).toBe(32);
    const r2 = slots.acquireSlot();
    expect(getRuntimeGaugesSnapshot().get("autoflow_metrics_streams_active")).toBe(2);
    r1();
    r2();
    expect(getRuntimeGaugesSnapshot().get("autoflow_metrics_streams_active")).toBe(0);
    // limit 是配置值，不随 active 回落
    expect(getRuntimeGaugesSnapshot().get("autoflow_metrics_streams_limit")).toBe(32);
  });
});
