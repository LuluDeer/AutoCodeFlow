/**
 * R199 · 「卡住」（stalled）判定判据。
 *
 * 判据（完整推导见 `docs/observability/agent-stalled-criterion.md`）：
 * > **stalled = 状态是 `running`，且「最近一步 `AgentStep` 的 `createdAt`」距今超过 N 分钟。**
 *
 * ## 为什么用「最近一步 step」而**不是**会话的 `updatedAt`（判据的**唯一**技术要点）
 *
 * `AgentSession.updatedAt` 是 `@UpdateDateColumn`，但仓里有**多处裸
 * `createQueryBuilder().update(AgentSession)`**（`autoResumeCount` 递增、`contextFoldStreak` 清零…），
 * **绕过** `@UpdateDateColumn` ⇒ `updatedAt` **不只**反映「业务进展」，还混着**维护性写入**
 * ⇒ 一次 `autoResumeCount` 递增就把 `updatedAt` 刷新了 ⇒ 用它判会**误报**。
 * 而 `AgentStep` 是**纯追加**的 ⇒ 「最近一步的时间」与「业务进展」**严格同向**。
 *
 * ## 本文件的判据
 *
 * ① 谓词里**必须**出现 `agent_steps` 子查询（钉「判据看的是 step 不是 session」）——
 *    删掉它 ⇒ 用例②红。
 * ② 谓词里**必须**带 `s.status = :runningStatus`（钉「只判 running」）——
 *    删掉它 ⇒ 用例④红。
 * ③ **子查询而不是 JOIN**（钉「不放大行数」）：JOIN 会把一行会话放大成 N 行
 *    ⇒ `getManyAndCount` 的 COUNT 重复计数、分页错位 ⇒ 谓词里**不得**出现 `JOIN`。
 * ④ 阈值**必须被钳制**（`stalledMinutes` 超上限 ⇒ 不得放行成「永不判定」）。
 */
import { AgentSessionService } from "../runtime/agent-session.service";
import {
  STALLED_DEFAULT_MINUTES,
  STALLED_MAX_MINUTES,
} from "../runtime/agent-stalled-thresholds";

/** 记录 QB 上被调用的方法与参数，供断言用。 */
interface Recorded {
  andWhere: Array<[string, Record<string, unknown> | undefined]>;
  orderBy: Array<[string, string]>;
  skip: number[];
  take: number[];
}

function makeService() {
  const rec: Recorded = { andWhere: [], orderBy: [], skip: [], take: [] };
  const qb: any = {
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      rec.andWhere.push([sql, params]);
      return qb;
    }),
    orderBy: jest.fn((col: string, dir: string) => {
      rec.orderBy.push([col, dir]);
      return qb;
    }),
    skip: jest.fn((n: number) => {
      rec.skip.push(n);
      return qb;
    }),
    take: jest.fn((n: number) => {
      rec.take.push(n);
      return qb;
    }),
    getManyAndCount: jest.fn(async () => [[], 0]),
  };
  const sessions = { createQueryBuilder: jest.fn(() => qb) };
  // 构造函数有 7 个参数（sessions/steps/toolCalls/budget/notify/leaderGate/approvalStore…），
  // 本用例只用到 `sessions` ⇒ 其余一律 `null`（既有单测同款装配方式）。
  const svc = new AgentSessionService(
    sessions as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { svc, rec };
}

/** 把所有 andWhere 的 SQL 拼起来（断言谓词用）。 */
const allSql = (rec: Recorded): string =>
  rec.andWhere.map(([sql]) => sql).join("\n");

describe("R199 · stalled（卡住）判定判据", () => {
  it("① 判据看的是 **agent_steps 子查询**（不是 session 的 updatedAt）", async () => {
    const { svc, rec } = makeService();
    await svc.list({ stalled: {} });
    const sql = allSql(rec);
    expect(sql).toContain("agent_steps");
    // ⚠️ 钉「不是 updatedAt」——那是本判据最容易做错的地方（`updatedAt` 会被
    // 裸 UPDATE 刷新 ⇒ 会把真卡住的会话误判成「刚动过」）。
    expect(sql).not.toMatch(/updatedAt/i);
  });

  it("② 只判 `running`（waiting_input / 终态都不算卡住）", async () => {
    const { svc, rec } = makeService();
    await svc.list({ stalled: {} });
    const sql = allSql(rec);
    expect(sql).toMatch(/status\s*=\s*:runningStatus/);
    // 阈值参数确实是 running
    const params = rec.andWhere.flatMap(([, p]) =>
      p ? Object.entries(p) : [],
    );
    expect(
      params.some(([k, v]) => k === "runningStatus" && v === "running"),
    ).toBe(true);
  });

  it("③ 用 **EXISTS 子查询**而不是 JOIN（JOIN 会把行数放大 ⇒ COUNT/分页都错）", async () => {
    const { svc, rec } = makeService();
    await svc.list({ stalled: {} });
    const sql = allSql(rec);
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).not.toMatch(/\bJOIN\b/i);
  });

  it("④ 阈值被**钳制**：超过上限 ⇒ 不得放行成「永不判定」", async () => {
    const { svc, rec } = makeService();
    await svc.list({ stalled: { minutes: 10 ** 9 } });
    const params = rec.andWhere.flatMap(([, p]) =>
      p ? Object.entries(p) : [],
    );
    const since = params.find(([k]) => k === "stalledSince")?.[1] as
      Date | undefined;
    expect(since).toBeInstanceOf(Date);
    // 上限 1 天 ⇒ 阈值不超过 1 天（`Date.now()` 有毫秒抖动 ⇒ 放宽 1 分钟容差）
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(STALLED_MAX_MINUTES / 1440 + 1 / 1440);
  });

  it("⑤ 不传 `stalled` ⇒ **完全不加**该谓词（旧行为不变）", async () => {
    const { svc, rec } = makeService();
    await svc.list({});
    expect(allSql(rec)).not.toContain("agent_steps");
  });

  it("⑥ 默认阈值 = 15 分钟；下限 1 分钟（新建会话不会被瞬间判卡住）", async () => {
    expect(STALLED_DEFAULT_MINUTES).toBe(15);

    const { svc, rec } = makeService();
    await svc.list({ stalled: { minutes: 0 } });
    const params = rec.andWhere.flatMap(([, p]) =>
      p ? Object.entries(p) : [],
    );
    const since = params.find(([k]) => k === "stalledSince")?.[1] as Date;
    const minutes = (Date.now() - since.getTime()) / 60_000;
    // 下限 1 分钟（容差 0.1）
    expect(minutes).toBeGreaterThanOrEqual(0.9);
    expect(minutes).toBeLessThanOrEqual(1.1);
  });
});
