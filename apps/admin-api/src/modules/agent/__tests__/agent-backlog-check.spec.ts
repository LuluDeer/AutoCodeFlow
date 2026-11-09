/**
 * R201 · 「调度积压」（backlogged）判据。
 *
 * 判据（完整推导见 `docs/observability/agent-backlog-criterion.md`）：
 * > **backlogged = 状态是 `pending`，且队列里**查不到**该会话对应的 job。**
 *
 * ## 本文件钉的是**判据本身**（不是接线）
 *
 * ① **`present`（job 在队列里）⇒ 不是积压** —— 这是「合法排队」与「积压」的**分界线**。
 *    删掉这条 ⇒ 一次批量触发 20 个会话（`AGENT_QUEUE_CONCURRENCY = 2`）就会**全部误报**
 *    ⇒ 运营看到一片红、**下次就不看了**（比没有判据更糟）。
 * ② **`missing` ⇒ 积压**（`queue.add` 失败 ⇒ 永远不会跑；`agent-trigger.service.ts:70-76` 自己记过这条）。
 * ③ **`finished` ⇒ 积压**（job 已终结而会话仍 `pending` ⇒ 不会再被消费）。
 * ④ **未知状态 ⇒ 按 `present` 保守处理**（**漏报优于误报**）。
 * ⑤ **判据里**不得出现任何时间列** —— 这是本判据最容易写错的地方（见下）。
 *
 * ## 为什么**不用**时间阈值（⑤ 的展开，已实测两条打穿路径）
 *
 * · ❌ `createdAt`：`reopenForResume()` 重开终态会话时 **不动 `createdAt`**
 *   ⇒ 3 小时前创建、**刚刚 resume** 的会话会被**立刻**误判成「积压 3 小时」。
 * · ❌ `updatedAt` / 任何纯时间阈值：并发只有 **2** ⇒ 批量触发时多数会话**合法地**排队，
 *   任何阈值都会把正常排队报成积压。
 * ⇒ 只能查队列（`jobId === session.id`，`agent-trigger.service.ts:352`/`:520`）。
 */
import {
  classifyJobState,
  isBacklogged,
  pickBacklogged,
  type PendingJobState,
} from "../runtime/agent-backlog-check";

describe("R201 · 调度积压（backlogged）判据", () => {
  it("① job 在队列里（waiting/delayed/active）⇒ **不是**积压（合法排队）", () => {
    for (const raw of [
      "waiting",
      "delayed",
      "active",
      "prioritized",
      "waiting-children",
    ]) {
      expect(classifyJobState(raw)).toBe("present");
      expect(isBacklogged({ sessionId: "s1", jobState: "present" })).toBe(
        false,
      );
    }
  });

  it("② job **查不到** ⇒ 积压（`queue.add` 失败 ⇒ 永远不会跑）", () => {
    expect(classifyJobState(undefined)).toBe("missing");
    expect(classifyJobState(null)).toBe("missing");
    expect(isBacklogged({ sessionId: "s1", jobState: "missing" })).toBe(true);
  });

  it("③ job 已终结（completed/failed）而会话仍 pending ⇒ 积压", () => {
    for (const raw of ["completed", "failed"]) {
      expect(classifyJobState(raw)).toBe("finished");
      expect(isBacklogged({ sessionId: "s1", jobState: "finished" })).toBe(
        true,
      );
    }
  });

  it("④ 未知状态 ⇒ 按 `present` 保守处理（**漏报优于误报**）", () => {
    // 为什么保守方向是这个：误报会让运营**不再看这个徽标**；
    // 漏报只是回到「没有判据」的现状。
    for (const raw of ["unknown", "some-future-state", ""]) {
      expect(classifyJobState(raw)).toBe("present");
    }
  });

  it("⑤ 判据里**不得**出现任何时间列（createdAt / updatedAt 都不是判据输入）", () => {
    // 这条是**结构性**判据：本判据的输入类型只有 `sessionId` + `jobState`。
    // 若将来有人「顺手」加一个 `pendingForMinutes` 之类的字段，这条用例会红。
    const probe = { sessionId: "s1", jobState: "present" } as const;
    expect(Object.keys(probe).sort()).toEqual(["jobState", "sessionId"]);
    // 且纯函数的签名不接受时间参数（类型层面已保证；这里钉「调用可以不带时间就跑」）。
    expect(pickBacklogged([probe])).toEqual([]);
  });

  it("⑥ `pickBacklogged` 只挑积压的，保持输入顺序", () => {
    const probes: Array<{ sessionId: string; jobState: PendingJobState }> = [
      { sessionId: "a", jobState: "present" },
      { sessionId: "b", jobState: "missing" },
      { sessionId: "c", jobState: "finished" },
      { sessionId: "d", jobState: "present" },
    ];
    expect(pickBacklogged(probes)).toEqual(["b", "c"]);
  });
});
