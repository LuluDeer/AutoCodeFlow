import type { Job } from "bullmq";

import {
  AGENT_QUEUE_CONCURRENCY,
  AGENT_QUEUE_NAME,
  AgentProcessor,
  type AgentJobData,
} from "../runtime/agent.processor";

/**
 * P2 Agent 队列执行体的**兜底契约**：process() 只有三件事——交给 runtime.run
 * （run 每次从 DB 重建上下文，可重入）、成功时记结果、未预期异常时**不重抛**。
 *
 * 为什么「不重抛」值得单独钉：BullMQ 的默认策略是失败即重试，而落到这里的
 * 异常都是 run() 收敛不了的未预期异常（DB 不可用等）。重试不会让它好转，
 * 却会**重复执行已发生的副作用**（工具调用、写操作）。这条纪律一旦被改成
 * 「抛出」，故障时的损失面立刻从「一次日志」放大成「N 次重复写」。
 */
function harness(runImpl?: (sessionId: string) => Promise<unknown>) {
  const run = jest.fn(
    runImpl ??
      (async () => ({ status: "succeeded", steps: 3 }) as unknown),
  );
  const runtime = { run };
  const proc = new AgentProcessor(runtime as never);
  return { proc, runtime, run };
}

function job(data: Partial<AgentJobData> = {}): Job<AgentJobData> {
  return { data: { sessionId: "sess-1", ...data } } as unknown as Job<AgentJobData>;
}

describe("AgentProcessor · 队列装配契约", () => {
  // 独立队列 + 固定并发 2 是刻意的保守选择（设计文档 02 §5.3）：Agent 是
  // 唯一会烧 LLM 费用、会做写操作的组件，不能与 task-queue 抢主链，也不能
  // 随 CPU 弹性扩容。改这个数字必须先评估 LLM 配额与事件循环延迟。
  it("队列名独立于 task-queue；并发固定为 2（不随 CPU 弹性扩）", () => {
    expect(AGENT_QUEUE_NAME).toBe("agent-jobs");
    expect(AGENT_QUEUE_NAME).not.toBe("task-queue");
    expect(AGENT_QUEUE_CONCURRENCY).toBe(2);
  });
});

describe("AgentProcessor · process（委托 + 兜底）", () => {
  it("只把 sessionId 交给 runtime.run——reason 不进参数（start/resume 同一条路径）", async () => {
    const h = harness();
    await h.proc.process(job({ sessionId: "sess-42", reason: "resume:approval" }));
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run).toHaveBeenCalledWith("sess-42");
    // reason 仅用于可观测：参数面里不能出现，否则 run 会因「不同原因走不同分支」
    // 退化成两条可能漂移的路径。
    expect(h.run.mock.calls[0]).toEqual(["sess-42"]);
  });

  it("成功路径记 status/steps，且 job 正常结束（不抛）", async () => {
    const h = harness(async () => ({ status: "succeeded", steps: 3 }) as unknown);
    const log = jest.spyOn((h.proc as any).logger, "log").mockImplementation(() => undefined);
    await expect(h.proc.process(job())).resolves.toBeUndefined();
    const done = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes("job done"));
    expect(done).toBeDefined();
    expect(done).toContain("status=succeeded");
    expect(done).toContain("steps=3");
    log.mockRestore();
  });

  it("run 抛未预期异常 → 吞掉（不重抛 → BullMQ 不重试已发生的副作用）", async () => {
    const h = harness(async () => {
      throw new Error("db down");
    });
    const err = jest.spyOn((h.proc as any).logger, "error").mockImplementation(() => undefined);
    // 关键断言：resolve 而不是 reject。若有人加上 `throw err`，这条立刻转红。
    await expect(h.proc.process(job())).resolves.toBeUndefined();
    expect(h.run).toHaveBeenCalledTimes(1); // 自身也不做内部重试
    const msg = String(err.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("session=sess-1");
    expect(msg).toContain("db down");
    // Error 实例要带栈（否则线上只剩一句话，无法归因）
    expect(err.mock.calls[0]?.[1]).toContain("db down");
    err.mockRestore();
  });

  it("非 Error 抛出（字符串）也被归一记录，且不带栈", async () => {
    const h = harness(async () => {
      throw "boom-string";
    });
    const err = jest.spyOn((h.proc as any).logger, "error").mockImplementation(() => undefined);
    await expect(h.proc.process(job({ reason: "trigger:cron" }))).resolves.toBeUndefined();
    const msg = String(err.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("boom-string");
    expect(err.mock.calls[0]?.[1]).toBeUndefined();
    err.mockRestore();
  });

  it("reason 缺省时日志不带 reason 段（避免 'undefined' 噪声）", async () => {
    const h = harness();
    const log = jest.spyOn((h.proc as any).logger, "log").mockImplementation(() => undefined);
    await h.proc.process(job());
    const start = log.mock.calls.map((c) => String(c[0])).find((m) => m.includes("job start"));
    expect(start).toBeDefined();
    expect(start).not.toContain("reason=");
    log.mockRestore();
  });
});
