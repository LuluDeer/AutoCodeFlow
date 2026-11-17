/**
 * R216 · 「积压」自动补入队的**额度领取**（`AgentBacklogReenqueueClaim.claim`）。
 *
 * 判据见 `docs/observability/backlog-auto-reenqueue-criterion.md` §3.1 / §5.1。
 *
 * 这是本仓**唯一**一条「自动处置」判据的关键闸门：它挡的是「同一条会话被补 N 次」。
 * 本文件钉的是**谓词的每一段**（少一段都会让闸门失效）：
 *
 * ① **递增必须是 SQL 表达式**（读后写会丢并发更新）；
 * ② **`backlogReenqueueCount < :limit`** —— 没这段就是无限补；
 * ③ **`status = :pending`** —— 没这段会给已在跑的会话补一条 job；
 * ④ **与 `autoResumeCount` 分列** —— 共用会让两条自动处置互相吃掉额度；
 * ⑤ **非法 max 回落 1** —— 脏配置不能变成无限补。
 *
 * ⚠️ 并发下的「只有一个赢家」由**真 PG** 证明（`npm run test:r216-auto-requeue-live`，
 * 10 并发 ⇒ 赢家=1）。单测只能证明谓词写对了。
 */
import { AgentBacklogReenqueueClaim } from "../runtime/agent-backlog-reenqueue-claim";

function makeClaimer(
  responses: Array<{ affected?: number }> = [{ affected: 1 }],
) {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  for (const r of responses) qb.execute.mockResolvedValueOnce(r);
  const svc = new AgentBacklogReenqueueClaim({
    createQueryBuilder: () => qb,
  } as never);
  return { svc, qb };
}

describe("R216 · 自动补入队额度领取（CAS）", () => {
  it("① 递增是 SQL 表达式（读后写会在多副本下丢更新）", async () => {
    const { svc, qb } = makeClaimer();
    await expect(svc.claim("s-1")).resolves.toBe(true);

    const set = qb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof set.backlogReenqueueCount).toBe("function");
    // 表达式必须引用**本列**（不是别的列）
    expect((set.backlogReenqueueCount as () => string)()).toContain(
      '"backlogReenqueueCount" + 1',
    );
  });

  it("②③ 谓词必须同时含「额度未耗尽」与「仍 pending」", async () => {
    const { svc, qb } = makeClaimer();
    await svc.claim("s-1");

    const [where, params] = qb.where.mock.calls[0];
    expect(where).toContain('"backlogReenqueueCount" < :limit');
    expect(where).toContain("status = :pending");
    expect(params).toMatchObject({ id: "s-1", limit: 1, pending: "pending" });
  });

  it("④ 与 `autoResumeCount` **分列**（共用会让两条自动处置互相吃额度）", async () => {
    const { svc, qb } = makeClaimer();
    await svc.claim("s-1");
    const [where] = qb.where.mock.calls[0];
    const set = qb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(where).not.toContain("autoResumeCount");
    expect(set).not.toHaveProperty("autoResumeCount");
  });

  it("⑤ 非法 max（0 / 负数 / 非整数）回落 1（脏配置不能变成无限补）", async () => {
    for (const bad of [0, -5, 1.7, Number.NaN]) {
      const { svc, qb } = makeClaimer();
      await svc.claim("s-1", bad as number);
      expect(qb.where.mock.calls[0][1]).toMatchObject({ limit: 1 });
    }
  });

  it("⑥ 额度耗尽 / 非 pending（affected=0）⇒ false（调用方据此**不入队**）", async () => {
    const { svc } = makeClaimer([{ affected: 0 }]);
    await expect(svc.claim("s-1")).resolves.toBe(false);
  });

  it("⑦ `affected` 缺失（驱动返回 undefined）也按失败处理 —— 不猜「大概成功了」", async () => {
    const { svc } = makeClaimer([{}]);
    await expect(svc.claim("s-1")).resolves.toBe(false);
  });
});
