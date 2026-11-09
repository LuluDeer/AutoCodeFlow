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
  Array.from({ length: n }, (_, i) => ({ id: `s${offset + i}` }));

function makeService(
  opts: {
    pending?: Array<{ id: string }>;
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
  const queue = { getJob } as never;
  const svc = new AgentBacklogService(sessions, queue);
  return { svc, find, getJob };
}

describe("R202 · 积压对账（接线层）", () => {
  it("① 只查 `pending`（非 pending 不参与对账）", async () => {
    const { svc, find } = makeService({ pending: pendingRows(2) });
    await svc.findBacklogged();
    expect(find).toHaveBeenCalledTimes(1);
    // 谓词必须是 status = pending
    expect(find.mock.calls[0][0]).toMatchObject({
      where: { status: "pending" },
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
});
