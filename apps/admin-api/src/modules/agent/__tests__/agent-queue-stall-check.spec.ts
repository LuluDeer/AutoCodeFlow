/**
 * R204 · 「队列停摆」（queue stall）判据。
 *
 * 判据（完整推导见 `docs/observability/agent-queue-stall-criterion.md`）：
 * > **stall = `pendingJobs > 0` 且 `active === 0` 且（`workers === 0` 或 `isPaused()`）**
 *
 * ## 本文件钉的是**判据本身**（不是接线）
 *
 * ① **有活没人干 ⇒ 停摆**（`waiting>0` + `workers=0` + `active=0`）。
 * ② **队列被暂停 + 有活 ⇒ 停摆**（成因是「暂停」，处置是 `resume`）。
 * ③ **合法积压**（`waiting>0` 但**有人在干活**）⇒ **不是**停摆 —— 这是本判据
 *    **最容易被写错**的地方：`AGENT_QUEUE_CONCURRENCY = 2`，批量触发时 18 个正常排队，
 *    任何「waiting 多就算异常」的写法都会**把正常排队报成停摆**（R201 的同款教训）。
 * ④ **没有活 ⇒ 不是停摆**（队列空着不是「停摆」，是「没活干」）。
 * ⑤ **`delayed` / `prioritized` 也算「在排队」** —— 只数 `waiting` 会漏掉
 *    「自动续跑的 delayed job」这类真实等待。
 * ⑥ **成因可区分**（`paused` vs `no-worker`）—— 两者的**处置不同**
 *    （前者 `resume`，后者查进程），混为一谈就没法指引人。
 */
import {
  isQueueStalled,
  pendingJobCount,
  queueStallReason,
  type QueueStallSnapshot,
} from "../runtime/agent-queue-stall-check";

const snap = (over: Partial<QueueStallSnapshot> = {}): QueueStallSnapshot => ({
  waiting: 0,
  delayed: 0,
  prioritized: 0,
  active: 0,
  workers: 1,
  paused: false,
  ...over,
});

describe("R204 · 队列停摆判据", () => {
  it("① 有活没人干（waiting>0 + workers=0 + active=0）⇒ 停摆", () => {
    const s = snap({ waiting: 5, workers: 0, active: 0 });
    expect(isQueueStalled(s)).toBe(true);
    expect(queueStallReason(s)).toBe("no-worker");
  });

  it("② 队列被暂停 + 有活 ⇒ 停摆（成因是「暂停」）", () => {
    const s = snap({ waiting: 3, paused: true, workers: 1, active: 0 });
    expect(isQueueStalled(s)).toBe(true);
    expect(queueStallReason(s)).toBe("paused");
  });

  it("③ **合法积压**（waiting>0 但**有人在干活**）⇒ **不是**停摆", () => {
    // workers>=1 或 active>0 任一 ⇒ 有人在干活 ⇒ 只是排队长，不是停摆。
    expect(isQueueStalled(snap({ waiting: 18, workers: 2, active: 2 }))).toBe(
      false,
    );
    // ⚠️ 这一条最容易被写错：并发只有 2（AGENT_QUEUE_CONCURRENCY），
    // 批量触发 20 个时其余 18 个**合法地**排队 ⇒ 「waiting 多就算异常」会误报。
    expect(isQueueStalled(snap({ waiting: 18, workers: 0, active: 1 }))).toBe(
      false,
    );
  });

  it("④ 没有活 ⇒ 不是停摆（队列空着不是「停摆」）", () => {
    expect(isQueueStalled(snap({ waiting: 0, workers: 0, active: 0 }))).toBe(
      false,
    );
    expect(
      isQueueStalled(
        snap({ waiting: 0, delayed: 0, prioritized: 0, workers: 0 }),
      ),
    ).toBe(false);
  });

  it("⑤ `delayed` / `prioritized` 也算「在排队」", () => {
    expect(pendingJobCount(snap({ delayed: 2, prioritized: 1 }))).toBe(3);
    const s = snap({
      waiting: 0,
      delayed: 2,
      prioritized: 1,
      workers: 0,
      active: 0,
    });
    expect(isQueueStalled(s)).toBe(true);
  });

  it("⑥ 成因可区分（`paused` vs `no-worker`）—— 两者的**处置不同**", () => {
    expect(
      queueStallReason(snap({ waiting: 1, paused: true, workers: 0 })),
    ).toBe("paused");
    expect(
      queueStallReason(snap({ waiting: 1, paused: false, workers: 0 })),
    ).toBe("no-worker");
    // 不是停摆时**没有**成因（不得给一个空成因）
    expect(
      queueStallReason(snap({ waiting: 1, workers: 2, active: 1 })),
    ).toBeNull();
  });

  it("⑦ `requireIdleWorker: false` 时放宽 `active` 条件（默认**开启**该要求）", () => {
    const s = snap({ waiting: 3, workers: 0, active: 2 });
    // 默认：active>0 ⇒ 不是停摆
    expect(isQueueStalled(s)).toBe(false);
    // 显式放宽：只看 workers
    expect(isQueueStalled(s, { requireIdleWorker: false })).toBe(true);
  });
});
