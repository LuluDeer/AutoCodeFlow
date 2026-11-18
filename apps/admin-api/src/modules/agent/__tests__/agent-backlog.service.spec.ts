/**
 * R202 · 「调度积压」的**接线层**（`AgentBacklogService.findBacklogged`）。
 *
 * 判据本身（纯函数）在 `agent-backlog-check.ts`，已由 `agent-backlog-check.spec.ts` 钉住；
 * 本文件钉的是**接线层**的三件事：
 *
 * ① **只查 `pending`** —— 非 pending 的会话不参与对账（判据的前提）。
 * ② **对账有上限，且截断时**必须**说**（`truncated: true`）——
 *    否则运营看到 `count = 3` 会以为「一共就 3 条积压」，而实际可能有几百条
 *    ⇒ **这是本仓的假事实类缺陷**（R188–R201 修的同一族）。
 * ③ **单条探针失败 ⇒ 跳过该条，不当成积压**（保守：漏报优于误报，见判据文档 §3.2）。
 */
import {
  AgentBacklogService,
  BACKLOG_PROBE_LIMIT,
} from "../runtime/agent-backlog.service";

/** 造一个 pending 会话行列表。 */
const pendingRows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${offset + i}`,
    totalSteps: 0,
  }));

function makeService(
  opts: {
    pending?: Array<{ id: string; totalSteps?: number }>;
    /** 当前有在途 job 的 BullMQ 去重键。 */
    deduplicationId?: string;
    /** sessionId → job 状态；`undefined` = 队列里查不到。 */
    jobStates?: Record<string, string>;
    /** 这些 id 的探针会抛错。 */
    failFor?: string[];
  } = {},
) {
  const find = jest.fn().mockResolvedValue(opts.pending ?? []);
  const getJob = jest.fn(async (id: string) => {
    if (opts.failFor?.includes(id)) throw new Error("redis down");
    const state = opts.jobStates?.[id];
    if (state === undefined) return undefined; // 队列里没有这个 job
    return { getState: jest.fn(async () => state) };
  });
  const sessions = { find } as never;
  const getDeduplicationJobId = jest.fn(
    async (id: string): Promise<string | null> =>
      id === opts.deduplicationId ? "49" : null,
  );
  const svc = new AgentBacklogService(sessions, {
    getJob,
    getDeduplicationJobId,
  } as never);
  return { svc, find, getJob, getDeduplicationJobId };
}

describe("R202 · 积压对账（接线层）", () => {
  it("① 只查 `pending`（非 pending 不参与对账）", async () => {
    const { svc, find } = makeService({ pending: pendingRows(2) });
    await svc.findBacklogged();
    expect(find).toHaveBeenCalledTimes(1);
    // 谓词必须是 status = pending
    expect(find.mock.calls[0][0]).toMatchObject({
      where: { status: "pending" },
      select: { id: true, totalSteps: true },
    });
  });

  it("② 队列里查不到 job ⇒ 判定为积压；job 在队列里 ⇒ 不是", async () => {
    const { svc } = makeService({
      pending: pendingRows(3),
      jobStates: { s1: "waiting" }, // 合法排队
      // s0 / s2 没有 job ⇒ 积压
    });
    const report = await svc.findBacklogged();
    expect(report.sessionIds).toEqual(["s0", "s2"]);
    expect(report.count).toBe(2);
    expect(report.truncated).toBe(false);
  });

  it("③ 超过上限 ⇒ **截断且必须说**（`truncated: true`），不静默少报", async () => {
    const over = BACKLOG_PROBE_LIMIT + 5;
    const { svc } = makeService({ pending: pendingRows(over) });
    const report = await svc.findBacklogged();
    expect(report.truncated).toBe(true);
    // 只对账了上限那么多（不是全部）
    expect(report.probed).toBe(BACKLOG_PROBE_LIMIT);
    // ⚠️ **不得**把截断后的条数当成「总数」——`count` 只说明「查到的这些里有几条积压」
    expect(report.count).toBe(BACKLOG_PROBE_LIMIT);
  });

  it("④ 单条探针抛错 ⇒ **跳过该条**，不当成积压（保守）", async () => {
    const { svc } = makeService({
      pending: pendingRows(3),
      failFor: ["s1"],
    });
    const report = await svc.findBacklogged();
    // s0/s2 积压（无 job），s1 探针失败 ⇒ **不算**积压
    expect(report.sessionIds).toEqual(["s0", "s2"]);
    expect(report.count).toBe(2);
  });

  it("⑤ 没有 pending 会话 ⇒ 干净返回（不是「0 个积压」的假事实，是**真的** 0）", async () => {
    const { svc } = makeService({ pending: [] });
    const report = await svc.findBacklogged();
    expect(report).toMatchObject({
      sessionIds: [],
      count: 0,
      probed: 0,
      truncated: false,
    });
  });
  it("⑤ **R213：串行探测挂住 ⇒ 总预算耗尽后停止，且 `truncated: true`**", async () => {
    // ⚠️ 本条针对的是**最容易写错的格子**：本循环是**串行**的，每 session 两次往返，
    //    最坏 200×2 = 400 次。若只做「逐调用 5s」，最坏 2000s ⇒ 等于没修。
    //    ⇒ 必须用**整次请求一个总预算**，耗尽即停并标记截断（R395：截断必须可见）。
    const hangForever = () => new Promise<never>(() => {});
    const find = jest.fn().mockResolvedValue(pendingRows(50));
    // 第一条就挂住 ⇒ 预算是唯一的出路
    const getJob = jest.fn(hangForever);
    const svc = new AgentBacklogService({ find } as never, { getJob } as never);
    // 把总预算压到 200ms（生产是 8s）：本条测的是**「预算耗尽会停」这个机制**，
    // 不是「8 秒这个数字」—— 后者由 observation-timeout.util.spec 的常量用例钉住。
    // ⚠️ 不压的话，agent 套件每条会多等 8s ⇒ 「测试慢」最终等于「测试不跑」。
    (svc as unknown as { observationBudgetMs: number }).observationBudgetMs =
      200;
    const started = Date.now();
    const report = await svc.findBacklogged();
    const elapsed = Date.now() - started;

    // 必须**在有限时间内**返回（预算 200ms；给一点余量）
    expect(elapsed).toBeLessThan(3_000);
    // 截断必须为 true。⚠️ 注意 `probed` 的语义是「**本次查了多少条 pending**」
    //   （不是「成功探测了几条」）⇒ 它仍是 50；真正说明「没查完」的是 `truncated`。
    //   （这一条我第一版写错过：断言 probed===0，实测得 50 —— 判据的**语义**要对，
    //    不是「看起来该是 0」。）
    expect(report.truncated).toBe(true);
    expect(report.probed).toBe(50);
    // 第一条就挂住 ⇒ 没有任何一条被确认为积压 ⇒ count=0（不是「没有积压」的假事实，
    // 而是「这次没查到」—— 由 truncated:true 表达）。
    expect(report.count).toBe(0);
  }, 20_000);
  it("⑥ ★ **R215 回归：resume 入队的会话不得被判成积压**（真实的误报路径）", async () => {
    // ⚠️ 这条是**真实缺陷**的回归钉子：本仓三条入队路径用的 jobId 不同 ——
    //   首跑 `session.id`、人工/审批恢复 `resume-<id>`、LLM 自动续跑 `auto-resume-<id>`。
    //   判据原先只查 `session.id` ⇒ 「审批通过、正在正常等消费」的会话会被误判成积压
    //   ⇒ 运营按提示「重新入队」⇒ **同一会话跑两遍（双份副作用）**。
    const { svc } = makeService({
      pending: [{ id: "s0" }, { id: "s1" }, { id: "s2" }, { id: "s3" }],
      jobStates: {
        s0: "waiting", // 首跑（jobId === session.id）
        "resume-s1": "waiting", // 人工/审批恢复
        "auto-resume-s2": "waiting", // LLM 瞬时错误自动续跑
        // s3 三条都没有 ⇒ **真积压**
      },
    });
    const report = await svc.findBacklogged();
    expect(report.sessionIds).toEqual(["s3"]);
    expect(report.count).toBe(1);
  });

  it("⑦ R215：首跑形态**零额外往返**（命中第一个候选就返回）", async () => {
    // 枚举三个候选**不等于**每次都查三次：绝大多数会话走首跑路径，
    // 那条必须只查一次（否则 200 条 pending × 3 次往返会拖慢端点）。
    const { svc, getJob } = makeService({
      pending: [{ id: "s0" }],
      jobStates: { s0: "waiting" },
    });
    await svc.findBacklogged();
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledWith("s0");
  });

  it("新恢复键的查询挂住同样受总预算约束，即使它是最后一条也标明截断", async () => {
    jest.useFakeTimers();
    try {
      const getDeduplicationJobId = jest.fn(() => new Promise<never>(() => {}));
      const svc = new AgentBacklogService(
        { find: async () => pendingRows(1) } as never,
        { getJob: async () => undefined, getDeduplicationJobId } as never,
      );
      Object.defineProperty(svc, "observationBudgetMs", { value: 50 });
      const report = svc.findBacklogged();
      await jest.advanceTimersByTimeAsync(50);
      await expect(report).resolves.toMatchObject({
        sessionIds: [],
        truncated: true,
      });
      expect(getDeduplicationJobId).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("旧 retained job 不遮住在途 job；仅当前进度的去重键参与对账", async () => {
    const { svc } = makeService({
      pending: [
        { id: "s0", totalSteps: 7 },
        { id: "s1", totalSteps: 9 },
        { id: "s2", totalSteps: 7 },
      ],
      jobStates: {
        s0: "completed",
        "resume-s0": "failed",
        "resume-s1": "completed",
        "auto-resume-s1": "delayed",
        "resume-s2": "completed",
        "49": "waiting", // 当前进度的去重键指向自动分配的 jobId 49
      },
      deduplicationId: "resume-s0-7",
    });
    expect((await svc.findBacklogged()).sessionIds).toEqual(["s2"]);
  });

  it("悬空去重指针不算工作；探测途中换代则保守不报且只复查一次", async () => {
    const opts = {
      pending: [{ id: "s0", totalSteps: 7 }],
      deduplicationId: "resume-s0-7",
    };
    const stale = makeService(opts);
    expect((await stale.svc.findBacklogged()).sessionIds).toEqual(["s0"]);
    expect(stale.getDeduplicationJobId).toHaveBeenCalledTimes(2);
    const handoff = makeService(opts);
    handoff.getDeduplicationJobId.mockResolvedValueOnce("48"); // 回读时变成 49
    expect((await handoff.svc.findBacklogged()).sessionIds).toEqual([]);
    expect(handoff.getDeduplicationJobId).toHaveBeenCalledTimes(2);
  });

  it("⑧ 所有已知键都查不到才判积压；不扫队列，不遍历历史步数", async () => {
    const { svc, getJob, getDeduplicationJobId } = makeService({
      pending: [{ id: "s0", totalSteps: 12 }],
    });
    const report = await svc.findBacklogged();
    expect(report.sessionIds).toEqual(["s0"]);
    expect(getDeduplicationJobId).toHaveBeenCalledTimes(1);
    expect(getDeduplicationJobId).toHaveBeenCalledWith("resume-s0-12");
    expect(getJob).toHaveBeenCalledTimes(3);
    expect(getJob.mock.calls.map((c) => c[0])).toEqual([
      "s0",
      "resume-s0",
      "auto-resume-s0",
    ]);
  });
});
