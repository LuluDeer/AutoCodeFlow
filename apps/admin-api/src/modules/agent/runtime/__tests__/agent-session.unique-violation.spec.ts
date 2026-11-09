import { AgentSessionService } from "../agent-session.service";
import { AGENT_UNIQUE_CONSTRAINTS } from "../agent-unique-violation.util";

/**
 * R9：`appendStep` / `appendEvents` 的 **23505 按约束名归因**（路径 ① / ②）。
 *
 * ## 为什么这两条也要按约束名（虽然后果比 ③④ 轻）
 *
 * 误判的后果是**白烧重试**——但它是**有界**的（`APPEND_STEP_MAX_RETRIES = 3`、
 * `APPEND_EVENT_MAX_RETRIES = 3`），不是无限重试（R5 实测）。真正的理由是
 * **归因正确性**：重算 `MAX(seq)` 只可能解决 `(sessionId, seq)` 冲突；
 * 撞**别的**唯一索引时重试是纯浪费（第二次必然再撞），且会把一条**真错误**
 * 拖成 3 倍延迟才暴露。
 *
 * ## 改前 / 改后（逐路径）
 *
 * | 路径 | 错误形态 | 改前 | 改后 |
 * |---|---|---|---|
 * | ① `appendStep` | 撞**目标** `idx_agent_steps_sessionId_seq` | 重试（≤3） | **不变** |
 * | ① `appendStep` | 撞**别的**唯一索引 | 重试（≤3，纯浪费） | **立即外抛** |
 * | ① `appendStep` | `unknown`（读不到约束名） | 重试 | **不变**（维持现状） |
 * | ① `appendStep` | 非 23505 | 立即外抛 | **不变** |
 * | ② `appendEvents` | 撞**目标** `uq_agent_events_sessionId_seq` | 重试（≤3） | **不变** |
 * | ② `appendEvents` | 撞**别的**唯一索引 | 重试（≤3，纯浪费） | **立即外抛** |
 * | ② `appendEvents` | `unknown` | 重试 | **不变**（维持现状） |
 * | ② `appendEvents` | 非 23505 | 立即外抛 | **不变** |
 *
 * ⚠️ `unknown` **必须**保持「重试」：本仓既有 spec 全部构造
 * `Object.assign(new Error, { code: "23505" })`（**无 constraint**）⇒ 若把
 * `unknown` 当「不是我的冲突」，真实的 seq 冲突会立刻外抛 ⇒ 退回到
 * 「会话卡在 running 等 30 分钟清扫」那个已修掉的 bug。
 */

const STEP = AGENT_UNIQUE_CONSTRAINTS.stepSeq;
const EVENT = AGENT_UNIQUE_CONSTRAINTS.eventSeq;

/** 顶层带 `code` + 指定约束名（TypeORM 真形态：顶层与 driverError 都有）。 */
const conflictOn = (constraint?: string) => {
  const e = Object.assign(new Error("duplicate key"), {
    code: "23505",
  }) as Error & { constraint?: string; driverError?: Record<string, unknown> };
  if (constraint !== undefined) {
    e.constraint = constraint;
    e.driverError = { code: "23505", constraint };
  } else {
    e.driverError = { code: "23505" };
  }
  return e;
};

/** TypeORM 惯用 fake：createQueryBuilder 链式桩。 */
function qbChain() {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    "update",
    "set",
    "where",
    "andWhere",
    "orderBy",
    "skip",
    "take",
    "select",
  ]) {
    qb[m] = jest.fn().mockReturnThis();
  }
  qb.execute = jest.fn(async () => ({ affected: 1 }));
  qb.getRawOne = jest.fn(async () => ({ maxSeq: 2 }));
  qb.getManyAndCount = jest.fn(async () => [[], 0]);
  return qb;
}

/**
 * 最小 harness：只够跑 `appendStep` / `appendEvents` 的**重试循环**。
 *
 * `sessions.manager.transaction` 是外部观察点（调用次数 = 事务尝试次数）。
 */
function harness(options: { eventQuery?: jest.Mock } = {}) {
  const emQb = qbChain();
  const em = {
    createQueryBuilder: jest.fn(() => emQb),
    create: jest.fn((_cls: unknown, v: unknown) => ({
      id: "step-1",
      ...(v as object),
    })),
    save: jest.fn(async (v: unknown) => v),
    findOne: jest.fn(async () => null),
    query: options.eventQuery ?? jest.fn(async () => [{ seq: 1 }]),
  };
  const sessions = {
    createQueryBuilder: jest.fn(() => qbChain()),
    findOne: jest.fn(async () => ({ id: "s-1", status: "running" })),
    update: jest.fn(async () => ({ affected: 1 })),
    manager: {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
        cb(em),
      ),
    },
  };
  // DI 顺序：sessions / steps / toolCalls / budgetService / notify /
  //          leaderGate(optional) / approvals(optional)
  const steps = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(async () => []),
    update: jest.fn(),
  };
  const toolCalls = {
    create: jest.fn((v: unknown) => ({ id: "tc-1", ...(v as object) })),
    save: jest.fn(async (v: unknown) => v),
    find: jest.fn(async () => []),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const budgetService = {
    resolveBudget: jest.fn(() => ({
      maxSteps: 40,
      maxTokens: 1000,
      wallClockMs: 60000,
      maxToolCalls: 20,
    })),
  };
  const notify = { emit: jest.fn(), notify: jest.fn() };
  const svc = new AgentSessionService(
    sessions as never,
    steps as never,
    toolCalls as never,
    budgetService as never,
    notify as never,
  );
  return { svc, sessions, em };
}

describe("AgentSessionService · appendStep 的 23505 按约束名归因（路径 ①）", () => {
  const txOf = (h: ReturnType<typeof harness>) =>
    (h.sessions.manager as { transaction: jest.Mock }).transaction;

  it("①-1 撞**目标** `idx_agent_steps_sessionId_seq` ⇒ 重试并成功（行为不变）", async () => {
    const h = harness();
    const tx = txOf(h);
    // 第 1 次撞目标约束；之后的调用走默认实现（成功）
    tx.mockRejectedValueOnce(conflictOn(STEP));
    const step = await h.svc.appendStep("s-1", { role: "assistant" } as never);
    expect(step).toMatchObject({ role: "assistant" });
    // 事务尝试至少 2 次（1 撞 + 重试）；事件旁路另算，故用 ≥2
    expect(tx.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("①-2 撞**别的**唯一索引 ⇒ **立即外抛**，不重试（改后行为）", async () => {
    const h = harness();
    const tx = txOf(h);
    const other = conflictOn("uq_some_other_index");
    tx.mockRejectedValue(other);
    await expect(
      h.svc.appendStep("s-1", { role: "assistant" } as never),
    ).rejects.toBe(other);
    // ⚠️ 只尝试 1 次 ⇒ 没有白烧重试
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("①-3 读不到约束名（unknown）⇒ **维持现状**：照旧重试至成功", async () => {
    const h = harness();
    const tx = txOf(h);
    tx.mockRejectedValueOnce(conflictOn()); // 无 constraint
    const step = await h.svc.appendStep("s-1", { role: "assistant" } as never);
    expect(step).toMatchObject({ role: "assistant" });
    expect(tx.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("①-4 unknown 且一直撞 ⇒ 重试仍**有上限 3**（不放宽上限）", async () => {
    const h = harness();
    const tx = txOf(h);
    tx.mockRejectedValue(conflictOn());
    await expect(
      h.svc.appendStep("s-1", { role: "assistant" } as never),
    ).rejects.toThrow("duplicate key");
    expect(tx).toHaveBeenCalledTimes(3);
  });
});

describe("AgentSessionService · appendEvents 的 23505 按约束名归因（路径 ②）", () => {
  it("②-1 撞**目标** `uq_agent_events_sessionId_seq` ⇒ 重试并成功（行为不变）", async () => {
    const eventQuery = jest
      .fn()
      .mockRejectedValueOnce(conflictOn(EVENT))
      .mockResolvedValueOnce([{ seq: 2 }]);
    const h = harness({ eventQuery });
    const out = await h.svc.appendEvents("s-1", [
      { kind: "step_appended", payload: { a: 1 } },
    ] as never);
    expect(out).toMatchObject({ firstSeq: 2 });
    expect(eventQuery).toHaveBeenCalledTimes(2);
  });

  it("②-2 撞**别的**唯一索引 ⇒ **立即外抛**，不重试（改后行为）", async () => {
    const other = conflictOn("uq_some_other_index");
    const eventQuery = jest.fn().mockRejectedValue(other);
    const h = harness({ eventQuery });
    await expect(
      h.svc.appendEvents("s-1", [
        { kind: "step_appended", payload: {} },
      ] as never),
    ).rejects.toBe(other);
    expect(eventQuery).toHaveBeenCalledTimes(1);
  });

  it("②-3 读不到约束名（unknown）⇒ **维持现状**：照旧重试", async () => {
    const eventQuery = jest
      .fn()
      .mockRejectedValueOnce(conflictOn())
      .mockResolvedValueOnce([{ seq: 3 }]);
    const h = harness({ eventQuery });
    const out = await h.svc.appendEvents("s-1", [
      { kind: "step_appended", payload: {} },
    ] as never);
    expect(out).toMatchObject({ firstSeq: 3 });
    expect(eventQuery).toHaveBeenCalledTimes(2);
  });

  it("②-4 撞的是 ① 的目标约束（跨路径串味）⇒ 也**不**重试（归因到正确路径）", async () => {
    // 反向钉：把 stepSeq 的名字用在 events 路径上，必须被判为 other-constraint。
    const wrong = conflictOn(STEP);
    const eventQuery = jest.fn().mockRejectedValue(wrong);
    const h = harness({ eventQuery });
    await expect(
      h.svc.appendEvents("s-1", [
        { kind: "step_appended", payload: {} },
      ] as never),
    ).rejects.toBe(wrong);
    expect(eventQuery).toHaveBeenCalledTimes(1);
  });
});
