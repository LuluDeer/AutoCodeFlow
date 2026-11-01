/**
 * S7-G1（第五阶段）：deny 之后**台账 settle** 的事件写入面。
 *
 * 背景：审批单被 deny 后，`AgentController.decideApproval` 会调
 * `settleToolCallByApprovalId` 把 `agent_tool_calls` 那一行从
 * `awaiting_approval` 条件写成 `denied`。这一步此前**只改库、不发事件**，于是
 * 事件流仍停在 `awaiting_approval`：投影说「【已被拒绝】不得重试」，快照说
 * 「【调用未成功】状态 denied：…」——同一段历史两句话，双跑对账在 deny 路径上
 * 永远差一句。
 *
 * 本文件钉四件事：
 *   ① deny 成功（affected > 0）⇒ 台账行改 denied **且**落一条
 *      `tool_call_status_changed`（status=denied），且**顺序**是先写库后写事件；
 *   ② 条件写命中 0 行（并发输家/库里已终态）⇒ **不落事件**（结构性保证）；
 *   ③ 事件写入失败 ⇒ deny 主链不受影响（旁路契约，纪律 2）；
 *   ④ 投影与快照在 deny 路径**逐字节一致**——那条在
 *      `agent-event-projection.spec.ts` 的 ⑤ 组（双跑对账本身）。
 */

import { Logger } from "@nestjs/common";

import { AgentController } from "../../agent.controller";

type Any = Record<string, unknown>;

const SESSION = { id: "s-1", status: "waiting_input", createdBy: null };
const APPROVAL = {
  approvalKey: "ap-1",
  sessionId: "s-1",
  toolName: "stop_task",
  status: "denied",
  decidedBy: "alice",
};
const DENIED_ROW = {
  id: "tc-0",
  sessionId: "s-1",
  stepId: "s-2",
  toolCallId: "c1",
  toolName: "stop_task",
  tier: "write",
  status: "denied",
  resultJson: null,
  resultTruncated: false,
  errorMessage: "已被 alice 人工拒绝（审批单 ap-1）——不得重试同一调用",
  approvalId: "ap-1",
  durationMs: 0,
};

interface HarnessOptions {
  /** `settleToolCallByApprovalId` 的返回（受影响行数）。 */
  affected?: number;
  /** `listToolCalls` 返回值（回读拿事件所需的身份）。 */
  rows?: Any[];
  /** `listToolCalls` 抛（模拟读失败 / 既有单测替身没有这个方法）。 */
  readThrows?: boolean;
  /** `tryAppendEvent` 的实现（默认成功返回 seq）。 */
  append?: (sessionId: string, event: Any) => Promise<number | null>;
  /** `tryAppendEvent` 根本不存在（模拟未装配端口）。 */
  noAppend?: boolean;
}

function harness(o: HarnessOptions = {}) {
  const seen: Array<{ sessionId: string; event: Any }> = [];
  const requireById = jest.fn(async () => SESSION);
  const settle = jest.fn(async () => o.affected ?? 1);
  const listToolCalls = jest.fn(async () => {
    if (o.readThrows) throw new Error("db down");
    return o.rows ?? [DENIED_ROW];
  });
  const append = jest.fn(
    async (sessionId: string, event: Any): Promise<number | null> => {
      if (o.append) return o.append(sessionId, event);
      seen.push({ sessionId, event });
      return seen.length;
    },
  );
  const sessions: Any = {
    requireById,
    settleToolCallByApprovalId: settle,
    listToolCalls,
  };
  // 端口未装配的那一档：**整个方法都不存在**（既有单测替身就是这样）。
  if (!o.noAppend) sessions.tryAppendEvent = append;
  const approvals: Any = {
    findByKey: jest.fn(async () => APPROVAL),
    decide: jest.fn(async () => APPROVAL),
    hasPendingForSession: jest.fn(async () => false),
  };
  const queue: Any = { add: jest.fn(async () => undefined) };
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    approvals as never,
    queue as never,
    { get: () => false } as never,
  );
  return {
    ctl,
    seen,
    mocks: {
      requireById,
      settle,
      listToolCalls,
      append,
      approvals,
      queue,
    },
  };
}

const admin = { id: 1, username: "alice", role: "admin" } as never;

/** 直接打公开端点（`decideApproval` 是私有共享体，deny 走这里）。 */
const deny = (h: { ctl: AgentController }, key = "ap-1") =>
  (
    h.ctl as unknown as {
      denyApproval: (
        id: string,
        approvalKey: string,
        user: unknown,
      ) => Promise<{ ok: boolean; resumed: boolean }>;
    }
  ).denyApproval("s-1", key, admin);

describe("tool_call_status_changed · ① deny 命中 ⇒ 台账改 denied 且落一条状态事件", () => {
  it("affected > 0：事件 payload 带身份与 status=denied，且**先写库后写事件**", async () => {
    const h = harness();
    const out = await deny(h);

    expect(out.ok).toBe(true);
    expect(out.resumed).toBe(false);

    // 台账 settle 仍是原来的调用形状（语义没变）
    expect(h.mocks.settle).toHaveBeenCalledWith(
      "ap-1",
      "denied",
      expect.stringContaining("alice"),
    );

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].sessionId).toBe("s-1");
    expect(h.seen[0].event.kind).toBe("tool_call_status_changed");
    expect(h.seen[0].event.payload).toMatchObject({
      toolCallId: "c1",
      toolName: "stop_task",
      tier: "write",
      status: "denied",
      hasResult: false,
      resultTruncated: false,
      // 正文不进事件（可能含敏感信息），只记存在性——投影按约定回读台账行
      errorMessage: "present",
    });

    // 纪律 1：**条件 UPDATE 命中之后**才落事件。若事件先写、UPDATE 命中 0 行，
    // 事件流里就会多出一条「库里没发生」的迁移，而投影正是拿它指挥模型。
    const settleOrder = h.mocks.settle.mock.invocationCallOrder[0];
    const appendOrder = h.mocks.append.mock.invocationCallOrder[0];
    expect(appendOrder).toBeGreaterThan(settleOrder);
  });

  it("只认这次审批单对应的那一行：别的 approvalId / 别的状态不产生事件", async () => {
    const h = harness({
      rows: [
        { ...DENIED_ROW, id: "tc-9", toolCallId: "c9", approvalId: "ap-2" },
        { ...DENIED_ROW, id: "tc-8", toolCallId: "c8", status: "ok" },
        DENIED_ROW,
      ],
    });
    await deny(h);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].event.payload).toMatchObject({ toolCallId: "c1" });
  });

  it("事件正文只记 presence：errorMessage 为空时 payload 里是 null", async () => {
    const h = harness({ rows: [{ ...DENIED_ROW, errorMessage: null }] });
    await deny(h);

    expect(h.seen[0].event.payload).toMatchObject({ errorMessage: null });
  });
});

describe("tool_call_status_changed · ② 条件写命中 0 行 ⇒ **不落事件**", () => {
  it("affected = 0（并发输家 / 行已终态）：库里没变 ⇒ 事件也不能说变，连回读都不发", async () => {
    const h = harness({ affected: 0 });
    const out = await deny(h);

    expect(out.ok).toBe(true);
    expect(h.mocks.settle).toHaveBeenCalled();
    expect(h.mocks.append).not.toHaveBeenCalled();
    expect(h.mocks.listToolCalls).not.toHaveBeenCalled();
  });

  it("affected = 0 且台账行**看起来**已是 denied（别的路径写的）⇒ 仍然不落事件", async () => {
    // 结构性判据：判据是 UPDATE 的影响行数，不是「读到的行长什么样」。
    // 否则并发下「读后写」会把别人的结论抄成自己的事件。
    const h = harness({ affected: 0, rows: [DENIED_ROW] });
    await deny(h);

    expect(h.seen).toHaveLength(0);
  });
});

describe("tool_call_status_changed · ③ 事件写入失败 ⇒ deny 主链不受影响（旁路）", () => {
  it("tryAppendEvent 抛出 ⇒ deny 照常返回 ok，只 warn", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const h = harness({
      append: async () => {
        throw new Error("events table is read-only");
      },
    });

    const out = await deny(h);

    expect(out).toMatchObject({ ok: true, resumed: false });
    expect(h.mocks.settle).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("bypass — deny unaffected"),
    );
    warn.mockRestore();
  });

  it("端口返回 null（tryAppendEvent 的失败形态）⇒ deny 照常返回 ok", async () => {
    const h = harness({ append: async () => null });
    await expect(deny(h)).resolves.toMatchObject({ ok: true });
  });

  it("回读抛（读失败）⇒ deny 照常返回 ok，只 warn", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const h = harness({ readThrows: true });

    await expect(deny(h)).resolves.toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("bypass — deny unaffected"),
    );
    warn.mockRestore();
  });

  it("端口未装配（既有单测的替身没有 listToolCalls/tryAppendEvent）⇒ 不抛、不改变主链", async () => {
    // 真实的兼容面：`agent-approvals.spec.ts` 之类的替身只实现了一部分方法。
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const h = harness({ readThrows: true, noAppend: true });

    await expect(deny(h)).resolves.toMatchObject({ ok: true });
    warn.mockRestore();
  });
});

describe("tool_call_status_changed · ④ grant 路径**不**受影响（不能被 deny 的改动带坏）", () => {
  it("grant 不落 tool_call_status_changed（grant 时台账行仍是 awaiting_approval）", async () => {
    const h = harness();
    await (
      h.ctl as unknown as {
        grantApproval: (a: string, b: string, c: unknown) => Promise<unknown>;
      }
    ).grantApproval("s-1", "ap-1", admin);

    expect(h.mocks.settle).not.toHaveBeenCalled();
    expect(h.mocks.append).not.toHaveBeenCalled();
  });
});
