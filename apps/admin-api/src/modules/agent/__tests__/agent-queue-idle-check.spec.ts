/**
 * R206 · 「队列空转」（queue idle-stuck）判据。
 *
 * 判据（完整推导见 `docs/observability/agent-queue-idle-criterion.md`）：
 * > **idle-stuck = 存在一个 `waiting` job，其「入队至今」的年龄 > 阈值 T
 * > （T 由「单 job 合理耗时上界」推导，不写死魔法数）。**
 *
 * ## 本文件钉的是**判据本身**
 *
 * ① **最老 waiting job 的年龄 > T ⇒ 空转**（这是判据的正向）。
 * ② **年龄 ≤ T ⇒ 不空转**（**合法积压**：`AGENT_QUEUE_CONCURRENCY = 2`，
 *    批量触发 20 个时最后一个**合法地**等 45 分钟 ⇒ 任何偏小的阈值都会造成误报）。
 * ③ **没有 waiting job ⇒ 不空转**（队列是空的，不是「卡住了」）。
 * ④ **阈值 ≤ 0 ⇒ 不判定**（配错时**宁可漏报**，也不要制造一片红）。
 * ⑤ **`attemptsStarted > 0` 记为「重试过」**（**不是**必要条件，但能加强判据：
 *    区分「从没开始过」与「开始了但反复重来」）。
 * ⑥ **只覆盖 `waiting`**（**不含** `delayed`）—— `delayed` job 是**故意**延迟的
 *    （GAP-3 自动续跑），把它算进来会把**正常延迟**报成「空转」。
 */
import {
  evaluateQueueIdle,
  type WaitingJobProbe,
} from "../runtime/agent-queue-idle-check";

const NOW = 1_800_000_000_000;
const job = (over: Partial<WaitingJobProbe> = {}): WaitingJobProbe => ({
  id: "j1",
  timestamp: NOW - 60_000, // 60 秒前入队
  ...over,
});

describe("R206 · 队列空转判据", () => {
  it("① 最老 waiting job 的年龄 > T ⇒ 空转", () => {
    const v = evaluateQueueIdle({
      waitingCount: 1,
      oldest: job({ timestamp: NOW - 10 * 60_000 }),
      thresholdMs: 5 * 60_000,
      now: NOW,
    });
    expect(v.idleStuck).toBe(true);
    expect(v.oldestAgeMs).toBe(10 * 60_000);
  });

  it("② 年龄 ≤ T ⇒ **不**空转（合法积压不误报）", () => {
    const v = evaluateQueueIdle({
      waitingCount: 18,
      oldest: job({ timestamp: NOW - 3 * 60_000 }),
      thresholdMs: 5 * 60_000,
      now: NOW,
    });
    expect(v.idleStuck).toBe(false);
    expect(v.oldestAgeMs).toBe(3 * 60_000);
  });

  it("③ 没有 waiting job ⇒ 不空转（队列空着不是「卡住」）", () => {
    const v = evaluateQueueIdle({
      waitingCount: 0,
      oldest: null,
      thresholdMs: 1000,
      now: NOW,
    });
    expect(v.idleStuck).toBe(false);
    expect(v.oldestAgeMs).toBe(0);
  });

  it("④ 阈值 ≤ 0 ⇒ **不判定**（宁可漏报，也不要制造一片红）", () => {
    const v = evaluateQueueIdle({
      waitingCount: 5,
      oldest: job({ timestamp: NOW - 10 * 60_000 }),
      thresholdMs: 0,
      now: NOW,
    });
    expect(v.idleStuck).toBe(false);
    // 但**仍然报告年龄**（诊断信息不丢）
    expect(v.oldestAgeMs).toBe(10 * 60_000);
  });

  it("⑤ `attemptsStarted > 0` ⇒ 记为「重试过」（加强判据，非必要条件）", () => {
    const v = evaluateQueueIdle({
      waitingCount: 1,
      oldest: job({ timestamp: NOW - 10 * 60_000, attemptsStarted: 2 }),
      thresholdMs: 5 * 60_000,
      now: NOW,
    });
    expect(v.idleStuck).toBe(true);
    expect(v.retried).toBe(true);
    // 首轮就卡住的 ⇒ attemptsStarted 为 0/未定义 ⇒ 不算重试
    const v2 = evaluateQueueIdle({
      waitingCount: 1,
      oldest: job({ timestamp: NOW - 10 * 60_000, attemptsStarted: 0 }),
      thresholdMs: 5 * 60_000,
      now: NOW,
    });
    expect(v2.retried).toBe(false);
  });

  it("⑥ 只覆盖 `waiting`（`delayed` 由接线层排除，不进本判据）", () => {
    // 本判据的输入**只有** `waitingCount` 与 `oldest`（waiting 的那个）
    // ⇒ 结构上就不可能把 `delayed` 混进来。
    const v = evaluateQueueIdle({
      waitingCount: 1,
      oldest: job(),
      thresholdMs: 1000,
      now: NOW,
    });
    expect(Object.keys(v).sort()).toEqual([
      "idleStuck",
      "oldestAgeMs",
      "retried",
    ]);
  });
});
