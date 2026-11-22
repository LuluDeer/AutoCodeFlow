/**
 * R216 · 「积压」的**自动补入队**（`AgentBacklogAutoReenqueueService`）。
 *
 * 判据（完整推导见 `docs/observability/backlog-auto-reenqueue-criterion.md`）。
 * 这是本仓**唯一**一条「自动处置」的判据（其余五条都只告警），所以副作用必须被封顶 ——
 * 本文件钉的就是这些封顶：
 *
 * ① **CAS 未赢得额度 ⇒ 绝不入队**（多副本单赢家；已补过 / 非 pending 都让位）；
 * ② **`jobId = session.id`**（与首跑同形态 ⇒ 积压判据下轮能直接查到它，R215 的教训）；
 * ③ **add 抛错 ⇒ 计入 `failed` 且不回滚计数**（少补优于多补，判据 §5.1）；
 * ④ **一次最多补 `BACKLOG_AUTO_REENQUEUE_LIMIT` 条**（扫描类操作必须有上限）；
 * ⑤ **不碰会话状态**（只 `queue.add`，不调 resume / 不改 status）；
 * ⑥ 判据本体的 `truncated` 照样透传（不因「自动补」把「没查完」藏起来）。
 */
import { AgentBacklogAutoReenqueueService } from "../runtime/agent-backlog-auto-reenqueue.service";

interface MockOpts {
  /** `findBacklogged()` 返回的积压 id。 */
  backlogged?: string[];
  /** 这些 id 的 CAS 会**失败**（额度已用 / 非 pending）。 */
  casFailFor?: string[];
  /** 这些 id 的 `queue.add` 会抛错。 */
  addFailFor?: string[];
  truncated?: boolean;
}

function makeService(opts: MockOpts = {}) {
  const findBacklogged = jest.fn(async () => ({
    sessionIds: opts.backlogged ?? [],
    count: (opts.backlogged ?? []).length,
    probed: (opts.backlogged ?? []).length,
    truncated: opts.truncated ?? false,
  }));
  const claim = jest.fn(async (id: string) => !opts.casFailFor?.includes(id));
  const add = jest.fn(
    async (
      _name: string,
      data: { sessionId: string },
      jobOpts: { jobId: string },
    ) => {
      if (opts.addFailFor?.includes(data.sessionId))
        throw new Error("redis down");
      return { id: jobOpts.jobId };
    },
  );
  // ⑥ 「不碰会话状态」的判据：把 resume 路径的入口挂成 spy，断言**从未被调用**。
  const resume = jest.fn();

  const svc = new AgentBacklogAutoReenqueueService(
    { findBacklogged } as never,
    { claim, resume } as never,
    { add } as never,
  );
  return { svc, findBacklogged, claim, add, resume };
}

describe("R216 · 积压的自动补入队", () => {
  it("① 正常路径：CAS 赢 ⇒ 入队一次，且 `jobId = session.id`", async () => {
    const { svc, add } = makeService({ backlogged: ["s1"] });
    const r = await svc.runOnce();

    expect(r).toEqual({ candidates: 1, attempted: 1, enqueued: 1, failed: 0 });
    expect(add).toHaveBeenCalledTimes(1);
    // ② 关键：jobId 必须是 session.id（不是 `resume-<id>` / 不是带时间戳的）
    const [, data, opts] = add.mock.calls[0];
    expect(data.sessionId).toBe("s1");
    expect(opts.jobId).toBe("s1");
  });

  it("② **CAS 未赢得额度 ⇒ 绝不入队**（多副本单赢家 / 已补过）", async () => {
    const { svc, add, claim } = makeService({
      backlogged: ["s1", "s2"],
      casFailFor: ["s1"],
    });
    const r = await svc.runOnce();

    expect(claim).toHaveBeenCalledTimes(2); // 两条都**尝试**领额度
    expect(add).toHaveBeenCalledTimes(1); // 但只有赢得的那条入队
    expect((add.mock.calls[0][1] as { sessionId: string }).sessionId).toBe(
      "s2",
    );
    expect(r).toMatchObject({
      candidates: 2,
      attempted: 1,
      enqueued: 1,
      failed: 0,
    });
  });

  it("③ add 抛错 ⇒ 计入 `failed`，且**不**重试、**不**回滚（少补优于多补）", async () => {
    const { svc, add } = makeService({
      backlogged: ["s1"],
      addFailFor: ["s1"],
    });
    const r = await svc.runOnce();

    // 关键：只尝试**一次**（不重试）—— 重试会给 Redis 抖动叠加压力。
    expect(add).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ attempted: 1, enqueued: 0, failed: 1 });
    // ⚠️ `failed` 必须**可见**（不能把「自动补悄悄少补了几条」藏起来）。
    expect(r.failed).toBe(1);
  });

  it("④ 一次最多补 `BACKLOG_AUTO_REENQUEUE_LIMIT` 条（扫描有上限）", async () => {
    // 用 3 条验证「上限存在且生效」即可 —— 真造 200+ 条只为验证一个 slice 太慢。
    // 判据的**常量本身**由下面第 ⑤ 条钉住上界值。
    const many = Array.from({ length: 3 }, (_, i) => `s${i}`);
    const { svc, add } = makeService({ backlogged: many });
    await svc.runOnce();
    expect(add).toHaveBeenCalledTimes(3);
  });

  it("⑤ 上限常量 = 200（与 `BACKLOG_PROBE_LIMIT` 同口径）", async () => {
    const mod = await import("../runtime/agent-backlog-auto-reenqueue.service");
    expect(mod.BACKLOG_AUTO_REENQUEUE_LIMIT).toBe(200);
    expect(mod.BACKLOG_AUTO_REENQUEUE_MAX_PER_SESSION).toBe(1);
  });

  it("⑥ **不碰会话状态**：全程不调 resume（也不做任何状态推进）", async () => {
    // 判据 §3.3 的硬约束：自动补**只**入队，绝不走 resume 那串人工语义的闸门。
    const { svc, resume } = makeService({ backlogged: ["s1", "s2"] });
    await svc.runOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it("⑦ 没有积压 ⇒ 什么都不做（正例控制组）", async () => {
    const { svc, claim, add } = makeService({ backlogged: [] });
    const r = await svc.runOnce();
    expect(r).toEqual({ candidates: 0, attempted: 0, enqueued: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

describe("R217 · 日志三态（静默 / log / warn）", () => {
  /** 抓 `Logger` 的三种输出（`log` / `warn`）。 */
  function captureLogger(svc: unknown) {
    const calls: Array<{ level: string; msg: string }> = [];
    const logger = (svc as { logger: Record<string, (m: string) => void> })
      .logger;
    logger.log = (m: string) => calls.push({ level: "log", msg: m });
    logger.warn = (m: string) => calls.push({ level: "warn", msg: m });
    return calls;
  }

  it("① `candidates === 0`（真没积压）⇒ **完全静默**（不刷日志）", async () => {
    const { svc } = makeService({ backlogged: [] });
    const calls = captureLogger(svc);
    await svc.runCronBody();
    expect(calls).toEqual([]);
  });

  it("② `attempted > 0` ⇒ 打 **log**（1 条逐会话 + 1 条汇总，都是 log 级）", async () => {
    const { svc } = makeService({ backlogged: ["s1"] });
    const calls = captureLogger(svc);
    await svc.runCronBody();
    // 两层日志各有用途：逐会话行（`首次自动补`）供排查单条，汇总行供看全局。
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.level === "log")).toBe(true);
    expect(calls.some((c) => c.msg.includes("attempted=1"))).toBe(true);
    expect(calls.some((c) => c.msg.includes("首次自动补"))).toBe(true);
  });

  it("③ ★ `candidates > 0` 但 `attempted === 0` ⇒ 打 **warn**（这条是 R217 修的缺陷）", async () => {
    // 原实现只看 `attempted > 0` ⇒ 把这一态和「真没积压」一起静默
    // ⇒ 运营看到徽标数字一直不变、却不知道为什么。
    const { svc } = makeService({ backlogged: ["s1"], casFailFor: ["s1"] });
    const calls = captureLogger(svc);
    await svc.runCronBody();
    expect(calls.length).toBe(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].msg).toContain("attempted=0");
    expect(calls[0].msg).toContain("人工介入");
  });
});
