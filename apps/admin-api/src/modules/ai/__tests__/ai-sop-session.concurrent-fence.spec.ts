/**
 * R184 · `ai-sop-session` 的**并发围栏**（审计 A-1 / A-2 的回归钉子）。
 *
 * ## 为什么单独这个文件（而不是塞进 `ai-sop-session.service.spec.ts`）
 *
 * ① 那个 spec 已在 `check:size-caps` 的棘轮上（→ 方法学 363：顶格文件先问「必须住在这里吗」）；
 * ② **更要紧**：本文件钉的两条**此前一条测试都没有** ——
 *    我把实现里的围栏**去掉**后跑 `src/modules/ai`，**242/242 仍然全绿**
 *    ⇒ 那两条保护当时处于「**改了但没被验证**」的状态（→ 方法学 359）。
 *
 * ## 判据（三条，每条都「去掉实现就会红」）
 *
 * ① **`releaseTurn` 必须带 token**：它的 `WHERE` 里除了 `id` 还必须有
 *    `"turnLockedAt" = :token` 且 `token` 就是 claim 时拿到的那个值。
 *    —— 没有它，超过 5 分钟租约的**旧持有者**会清掉**新持有者**的锁 ⇒ 第三个请求又能抢
 *    ⇒ 两轮并发跑、各自用快照写回、后写者静默覆盖。
 * ② **`claimTurn` 必须把 token 交出来**：它用 `RETURNING "turnLockedAt"` 取回**数据库生成**
 *    的时间戳（不用 JS 时间 —— 那会引入实例间时钟偏移，让 5 分钟窗口跟着漂）。
 * ③ **`markSaved` 只写 `status` 一列**：整行 `save()` 会用**读那一刻的旧快照**覆盖并发进行的
 *    模型轮次 ⇒ 新 `messagesJson`/`draftJson` 被静默擦掉；而 `AiSopSession` **没有
 *    `@VersionColumn`** ⇒ 覆盖后连痕迹都没有。
 */
import { AiSopSessionService } from "../ai-sop-session.service";
import { AiSopSession } from "../entities/ai-sop-session.entity";

/** 记录每次 `update()` 链上 `where` / `set` / `returning` 的入参。 */
type Call = {
  set?: Record<string, unknown>;
  where?: { sql: string; params: any };
  returning?: unknown;
};

function makeHarness(claimAffected = 1) {
  const calls: Call[] = [];
  const repo: any = {
    findOne: jest.fn(async () => ({
      id: "s-1",
      createdBy: "user:1",
      status: "active",
      messagesJson: [],
      draftJson: null,
      questionsAsked: 0,
      mediaJson: [],
    })),
    save: jest.fn(async (e: any) => e),
    createQueryBuilder: jest.fn(() => {
      const call: Call = {};
      calls.push(call);
      const chain: any = {
        update: () => chain,
        set: (payload: Record<string, unknown>) => {
          call.set = payload;
          return chain;
        },
        where: (sql: string, params: any) => {
          call.where = { sql, params };
          return chain;
        },
        returning: (expr: unknown) => {
          call.returning = expr;
          return chain;
        },
        execute: jest.fn(async () => ({
          affected: claimAffected,
          raw:
            claimAffected === 0
              ? []
              : [
                  {
                    turnLockedAt:
                      calls[calls.length - 1]?.set?.turnLockedAt ??
                      "DB_NOW_TOKEN",
                  },
                ],
        })),
      };
      return chain;
    }),
  };
  const svc = Object.create(AiSopSessionService.prototype) as any;
  svc.repo = repo;
  svc.logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };
  return { svc, repo, calls };
}

describe("R184 · ai-sop-session 的并发围栏", () => {
  it("① releaseTurn 的 WHERE 带 token 围栏（只释放自己那一把锁）", async () => {
    const { svc, calls } = makeHarness();
    const token = new Date("2026-11-08T00:00:00.000Z");
    await (svc as any).releaseTurn("s-1", token);

    const release = calls[calls.length - 1]!;
    expect(release.set).toEqual({ turnLockedAt: null });
    // **核心断言**：谓词里必须有 token（去掉它 ⇒ 会清掉新持有者的锁）
    expect(release.where!.sql).toContain('"turnLockedAt" = :token');
    expect(release.where!.params).toEqual({ id: "s-1", token });
  });

  it("② claimTurn 用 RETURNING 取回数据库生成的 token，并把它交给调用方", async () => {
    const { svc, calls } = makeHarness();
    const token = await (svc as any).claimTurn("s-1");

    const claim = calls[calls.length - 1]!;
    // 用 `now()` 生成（**不用 JS 时间** —— 那会引入实例间时钟偏移）
    expect(String((claim.set as any).turnLockedAt())).toBe("now()");
    // 取回 token（否则释放没有围栏可用）
    expect(claim.returning).toContain("turnLockedAt");
    expect(token).toBe(
      calls[calls.length - 1]?.set?.turnLockedAt ?? "DB_NOW_TOKEN",
    );
    // 租约条件仍在（陈旧锁可抢）
    expect(claim.where!.sql).toContain("interval '5 minutes'");
  });

  it("③ markSaved 只写 status 一列（不碰 messagesJson / draftJson）", async () => {
    const { svc, calls } = makeHarness();
    await (svc as any).markSaved("s-1", "user:1");

    const mark = calls.find((c) => c.set?.status === "saved")!;
    expect(mark).toBeDefined();
    // **核心断言**：只列了 status（整行写回会把这些列一起写回旧快照）
    expect(Object.keys(mark.set!)).toEqual(["status"]);
    expect(mark.set).not.toHaveProperty("messagesJson");
    expect(mark.set).not.toHaveProperty("draftJson");
  });

  it("④ affected=0 时 claimTurn 抛 409（不静默继续）", async () => {
    const { svc } = makeHarness(0);
    await expect((svc as any).claimTurn("s-1")).rejects.toMatchObject({
      status: 409,
    });
  });
});

void AiSopSession;
