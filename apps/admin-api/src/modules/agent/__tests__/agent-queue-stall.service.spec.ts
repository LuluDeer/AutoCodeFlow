/**
 * R205 · 「队列停摆」观测的**接线层**（`AgentQueueStallService.inspect`）。
 *
 * 判据本身（纯函数）已由 `agent-queue-stall-check.spec.ts` 钉住；本文件钉接线层的三件事：
 *
 * ① **六个观测量都读**（waiting/delayed/prioritized/active/workers/paused）——
 *    少读一个就会让判据**缺一角**（例如漏读 `delayed` ⇒ 自动续跑的 delayed job 被忽略）。
 * ② **单个观测量读失败 ⇒ 该量按未知处理 + `degraded: true`**，而**不**因此断言「停摆」
 *    （**误报**代价更大：误报会让运营不再看这个徽标）。
 * ③ **`degraded` 必须为 true 时，判定**不得**被当成「队列正常」** —— 这是**防假事实**的
 *    关键：前端据此显示「未知」而不是「正常」。
 */
import { AgentQueueStallService } from "../runtime/agent-queue-stall.service";

function makeService(
  opts: {
    waiting?: number;
    delayed?: number;
    prioritized?: number;
    active?: number;
    workers?: number;
    paused?: boolean;
    /** 这些观测量读失败（抛错）。 */
    failFor?: string[];
  } = {},
) {
  const fail = (name: string) => {
    if (opts.failFor?.includes(name)) throw new Error(`${name} down`);
  };
  const queue = {
    getWaitingCount: jest.fn(async () => {
      fail("waiting");
      return opts.waiting ?? 0;
    }),
    getDelayedCount: jest.fn(async () => {
      fail("delayed");
      return opts.delayed ?? 0;
    }),
    getPrioritizedCount: jest.fn(async () => {
      fail("prioritized");
      return opts.prioritized ?? 0;
    }),
    getActiveCount: jest.fn(async () => {
      fail("active");
      return opts.active ?? 0;
    }),
    getWorkersCount: jest.fn(async () => {
      fail("workers");
      return opts.workers ?? 1;
    }),
    isPaused: jest.fn(async () => {
      fail("paused");
      return opts.paused ?? false;
    }),
  };
  const svc = new AgentQueueStallService(queue as never);
  return { svc, queue };
}

describe("R205 · 队列停摆观测（接线层）", () => {
  it("① 六个观测量**都读**（少读一个就缺一角）", async () => {
    const { svc, queue } = makeService();
    await svc.inspect();
    expect(queue.getWaitingCount).toHaveBeenCalled();
    expect(queue.getDelayedCount).toHaveBeenCalled();
    expect(queue.getPrioritizedCount).toHaveBeenCalled();
    expect(queue.getActiveCount).toHaveBeenCalled();
    expect(queue.getWorkersCount).toHaveBeenCalled();
    expect(queue.isPaused).toHaveBeenCalled();
  });

  it("② 全部读到 ⇒ `degraded: false`，判定按判据走", async () => {
    const { svc } = makeService({ waiting: 5, workers: 0, active: 0 });
    const r = await svc.inspect();
    expect(r.degraded).toBe(false);
    expect(r.stalled).toBe(true);
    expect(r.reason).toBe("no-worker");
    expect(r.pendingJobs).toBe(5);
  });

  it("③ 单个观测量读失败 ⇒ **`degraded: true`**，且**不**因此断言停摆", async () => {
    // `workers` 读失败 ⇒ 按 0 处理会**看起来**像「没有 worker」⇒ 若照此断言就是**误报**。
    // ⇒ 正确做法：标 `degraded`，让调用方知道「这个判定不完整」。
    const { svc } = makeService({
      waiting: 5,
      active: 2,
      workers: 2,
      failFor: ["workers"],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    // `active > 0` ⇒ 有人在干活 ⇒ 即使 workers 读成 0 也不该判停摆
    expect(r.stalled).toBe(false);
  });

  it("④ 六个全读失败 ⇒ `degraded: true` 且**不**谎报「正常」也不谎报「停摆」", async () => {
    const { svc } = makeService({
      failFor: [
        "waiting",
        "delayed",
        "prioritized",
        "active",
        "workers",
        "paused",
      ],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    // 计数全按 0 处理 ⇒ 没有活 ⇒ 不是停摆（**不是**「队列停摆」）
    expect(r.stalled).toBe(false);
    expect(r.pendingJobs).toBe(0);
  });
});
