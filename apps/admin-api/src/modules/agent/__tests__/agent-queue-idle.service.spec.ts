/**
 * R207 · 「队列空转」观测的**接线层**（`AgentQueueIdleService.inspect`）
 * 与**阈值推导**（`deriveIdleThresholdMs`）。
 *
 * 判据本体（`evaluateQueueIdle`）已由 `agent-queue-idle-check.spec.ts` 钉住；
 * 本文件钉的是**接线层与推导**，即判据文档 §3.2 与 §5 里那两条「必须由外部量推导」
 * 与「读不到不得当成正常」的要求：
 *
 * ① **阈值由配置推导，不是魔法数**：`wallClockMs × concurrency + tick`
 *    —— 分量任一个非法/非正 ⇒ 0 ⇒ 判据层「不判定」（**宁可漏报**）。
 * ② **最老 job 取自 `getWaiting(0, 1)` 的第一个**（依赖 `asc=true` 的排序保证；
 *    上游改排序方向会让判据**静默失效**，所以这一条必须被钉住）。
 * ③ **单个观测量读失败 ⇒ `degraded: true` 且 `idleStuck` 恒 false**
 *    （既不谎报「空转」也不谎报「正常」）。
 * ④ **停摆优先**（R399）：已停摆 ⇒ 本条 `suppressedBy: "queue-stall"` 让位，
 *    否则同一现象会同时点亮两个徽标。
 */
import {
  AgentQueueIdleService,
  pickOldestProbe,
} from "../runtime/agent-queue-idle.service";
import { deriveIdleThresholdMs } from "../runtime/agent-queue-idle-check";

const NOW = 1_800_000_000_000;

interface MockOpts {
  waitingCount?: number;
  /** `getWaiting` 返回的 job 观测面（简化对象即可）。 */
  waitingJobs?: Array<{
    id?: unknown;
    timestamp?: unknown;
    attemptsStarted?: unknown;
  }>;
  workers?: number;
  paused?: boolean;
  active?: number;
  /** 这些观测量读失败（抛错）。 */
  failFor?: string[];
  /** 配置值（`agent.budget.wallClockMs` / `executor.heartbeatInterval`）。 */
  cfg?: Record<string, unknown>;
}

function makeService(opts: MockOpts = {}) {
  const fail = (name: string) => {
    if (opts.failFor?.includes(name)) throw new Error(`${name} down`);
  };
  const queue = {
    getWaitingCount: jest.fn(async () => {
      fail("waitingCount");
      return opts.waitingCount ?? 0;
    }),
    getWaiting: jest.fn(async () => {
      fail("waiting");
      return opts.waitingJobs ?? [];
    }),
    getWorkersCount: jest.fn(async () => {
      fail("workers");
      return opts.workers ?? 1;
    }),
    isPaused: jest.fn(async () => {
      fail("paused");
      return opts.paused ?? false;
    }),
    getActiveCount: jest.fn(async () => {
      fail("active");
      return opts.active ?? 0;
    }),
  };
  const cfg = opts.cfg ?? {
    "agent.budget.wallClockMs": 30 * 60_000,
    "executor.heartbeatInterval": 30_000,
  };
  const config = { get: (k: string) => cfg[k] };
  const svc = new AgentQueueIdleService(queue as never, config as never);
  return { svc, queue, config };
}

/** 冻结时间：判据用 `Date.now()`，故用假定时器把「现在」钉死。 */
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
});

describe("R207 · 阈值推导（R403：不允许魔法数）", () => {
  it("① 阈值 = 墙钟预算 × 并发槽位数 + 一拍", () => {
    // 30min × 2 + 30s = 60.5min —— 每一环都是仓里已有的量。
    expect(deriveIdleThresholdMs(1_800_000, 2, 30_000)).toBe(3_630_000);
  });

  it("② 不带「一拍」时是纯乘积（tick 是可选项，不是保守系数）", () => {
    expect(deriveIdleThresholdMs(1_800_000, 2)).toBe(3_600_000);
  });

  it("③ 任一分量非法/非正 ⇒ 0（由判据层「阈值 ≤ 0 ⇒ 不判定」接手，**宁可漏报**）", () => {
    expect(deriveIdleThresholdMs(0, 2, 30_000)).toBe(0);
    expect(deriveIdleThresholdMs(1_800_000, 0, 30_000)).toBe(0);
    expect(deriveIdleThresholdMs(Number.NaN, 2, 30_000)).toBe(0);
    expect(deriveIdleThresholdMs(1_800_000, Number.POSITIVE_INFINITY, 0)).toBe(
      0,
    );
    // 负的 tick 不会把阈值拉小（非法 tick 按 0 处理，而不是「减掉」）。
    expect(deriveIdleThresholdMs(1_800_000, 2, -5_000)).toBe(3_600_000);
  });
});

describe("R207 · 取最老 job（依赖 getWaiting 的 asc 排序保证）", () => {
  it("① 取第一个（即最老的）", () => {
    expect(
      pickOldestProbe([
        { id: "old", timestamp: NOW - 120_000, attemptsStarted: 1 },
        { id: "new", timestamp: NOW - 1_000, attemptsStarted: 0 },
      ]),
    ).toEqual({ id: "old", timestamp: NOW - 120_000, attemptsStarted: 1 });
  });

  it("② 没有 job ⇒ null", () => {
    expect(pickOldestProbe([])).toBeNull();
  });

  it("③ 入队时间不可用 ⇒ null（**不得**用 `Date.now()` 顶替，否则年龄恒 0 ⇒ 永远判正常）", () => {
    expect(pickOldestProbe([{ id: "x" }])).toBeNull();
    expect(pickOldestProbe([{ id: "x", timestamp: 0 }])).toBeNull();
    expect(
      pickOldestProbe([{ id: "x", timestamp: "not-a-number" }]),
    ).toBeNull();
  });
});

describe("R207 · 接线层 inspect()", () => {
  it("① 最老 waiting job 超阈值 ⇒ 空转；阈值与依据一并返回", async () => {
    const { svc } = makeService({
      waitingCount: 1,
      waitingJobs: [
        { id: "j", timestamp: NOW - 4_000_000, attemptsStarted: 0 },
      ],
      workers: 2,
      active: 1,
    });
    const r = await svc.inspect();
    expect(r.idleStuck).toBe(true);
    expect(r.thresholdMs).toBe(3_630_000);
    expect(r.basis.formula).toContain("wallClockMs(1800000)");
    expect(r.waitingCount).toBe(1);
    expect(r.degraded).toBe(false);
    expect(r.suppressedBy).toBeNull();
  });

  it("② 年龄未超阈值 ⇒ **不**空转（合法积压不误报）", async () => {
    const { svc } = makeService({
      waitingCount: 18,
      waitingJobs: [{ id: "j", timestamp: NOW - 3_000_000 }],
      workers: 2,
      active: 2,
    });
    const r = await svc.inspect();
    expect(r.idleStuck).toBe(false);
    expect(r.oldestAgeMs).toBe(3_000_000);
  });

  it("③ 已停摆（workers=0 且 active=0）⇒ 本条**让位**，不重复报警", async () => {
    const { svc } = makeService({
      waitingCount: 3,
      waitingJobs: [{ id: "j", timestamp: NOW - 4_000_000 }],
      workers: 0,
      active: 0,
    });
    const r = await svc.inspect();
    expect(r.suppressedBy).toBe("queue-stall");
    expect(r.idleStuck).toBe(false);
    // 让位不等于「没读到」：判定是**完整**的，只是这一格归停摆判据。
    expect(r.degraded).toBe(false);
  });

  it("④ 有人在干活 + 最老 job 很老 ⇒ 空转（**不**被停摆判据吞掉）", async () => {
    // 这正是本判据要报的形态：worker 在跑一个永远跑不完的 job，队列不再前进。
    const { svc } = makeService({
      waitingCount: 5,
      waitingJobs: [
        { id: "j", timestamp: NOW - 4_000_000, attemptsStarted: 2 },
      ],
      workers: 2,
      active: 2,
    });
    const r = await svc.inspect();
    expect(r.idleStuck).toBe(true);
    expect(r.retried).toBe(true);
    expect(r.suppressedBy).toBeNull();
  });

  it("⑤ 读失败 ⇒ `degraded: true` 且**不**断言（既不报空转也不报正常）", async () => {
    const { svc } = makeService({
      waitingCount: 5,
      waitingJobs: [{ id: "j", timestamp: NOW - 4_000_000 }],
      failFor: ["waiting"],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    expect(r.idleStuck).toBe(false);
  });

  it("⑤b **判据本会成立**但某个观测量读失败 ⇒ 仍**不得**断言空转", async () => {
    // ⚠️ 这一条才是 `degraded` 守卫的真正靶心。选**哪个**观测量读失败很关键：
    //   ① 让 `waiting` 抛错 ⇒ 最老 job 本就是 null ⇒ 判据恒 false ⇒ **有没有守卫都一样绿**；
    //   ② 让 `workers` 抛错 ⇒ workers 回落 0 ⇒ 走进「停摆让位」分支 ⇒ 也被压住 ⇒ 挡不住回归。
    //   ③ 只能让 `paused` 抛错：workers/active 正常 ⇒ 不停摆；waiting/age 正常 ⇒
    //      判据本会判「空转」⇒ **只有 `degraded` 守卫能把它压住**。（反证实测：
    //      去掉守卫 ⇒ 本条红。）
    const { svc } = makeService({
      waitingCount: 5,
      waitingJobs: [{ id: "j", timestamp: NOW - 4_000_000 }],
      workers: 2,
      active: 1,
      failFor: ["paused"],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    // 最老 job 的年龄确实超了阈值（说明判据本会成立），但结论仍是「不断言」。
    expect(r.oldestAgeMs).toBe(4_000_000);
    expect(r.idleStuck).toBe(false);
  });

  it("⑥ 配置缺失 ⇒ 阈值为 0 ⇒ **不判定**（配错时宁可漏报）", async () => {
    const { svc } = makeService({
      waitingCount: 5,
      waitingJobs: [{ id: "j", timestamp: NOW - 4_000_000 }],
      cfg: {}, // 两个键都读不到
    });
    const r = await svc.inspect();
    expect(r.thresholdMs).toBe(0);
    expect(r.idleStuck).toBe(false);
    expect(r.basis.formula).toContain("不判定");
  });
});
