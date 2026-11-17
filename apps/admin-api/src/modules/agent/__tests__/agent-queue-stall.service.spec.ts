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

  it("③b **`workers` 读失败 + `active === 0` + 有待办 ⇒ 不得报停摆**（R210 的真误报路径）", async () => {
    // ⚠️ 这条是 ③ **没覆盖**的那一格：③ 里 `active: 2` 会让 `isQueueStalled` 的
    // `requireIdleWorker` 分支直接返回 false ⇒ **有没有修复都一样绿**。
    // 真实路径是：Redis 抖动 ⇒ `getWorkersCount()` 抛错 ⇒ 回落 0 ⇒ 若照此判定
    // 就会把「不知道」报成「停摆」。修复前实测 `stalled === true`。
    const { svc } = makeService({
      waiting: 5,
      active: 0,
      failFor: ["workers"],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    // 「读不到」≠「确有其事」：宁可漏报，也不制造一条假告警。
    expect(r.stalled).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("③c **`paused` 是独立强证据**：`workers` 读失败也不影响「暂停」那一路", async () => {
    // 判据有两路：`paused` 单独成立 / `workers` 那一路。前者是**人为显式状态**，
    // 不依赖 worker 观测 ⇒ `workers` 读失败**不该**把这条真实停摆也压掉。
    const { svc } = makeService({
      waiting: 3,
      active: 0,
      paused: true,
      failFor: ["workers"],
    });
    const r = await svc.inspect();
    expect(r.degraded).toBe(true);
    expect(r.stalled).toBe(true);
    // 归因必须是 `paused`（去 resume），**不是** `no-worker`（去查进程）。
    expect(r.reason).toBe("paused");
  });

  it("③d `workers` 读**成功**且为 0 ⇒ 仍然报停摆（正例控制组，防 ③b 改过头）", async () => {
    // ⚠️ ③b 的修复很容易写成「degraded 就一律不报」—— 那会把**真的停摆**也吞掉。
    // 本条是它的对立面：`workers` 正常读到 0、`active === 0`、有待办 ⇒ **必须**报。
    const { svc } = makeService({ waiting: 5, active: 0, workers: 0 });
    const r = await svc.inspect();
    expect(r.degraded).toBe(false);
    expect(r.stalled).toBe(true);
    expect(r.reason).toBe("no-worker");
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
