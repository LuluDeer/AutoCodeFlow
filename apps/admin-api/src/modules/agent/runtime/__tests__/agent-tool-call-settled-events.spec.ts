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
 *
 * 第六阶段补缺口②：该事件此前只带 `errorMessage: "present"` 哨兵，正文靠回读
 * 台账行（会被就地覆盖）。现在它带 `payload.body.error`（脱敏 + 2 KiB 截断 +
 * `truncated` / `originalBytes`，与另两个写入点同形），因此上面 ① 组的用例同时
 * 钉住：正文进了事件、含凭据时库里无明文、超长时截断不静默。
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
    const payload = h.seen[0].event.payload as Any;
    expect(payload).toMatchObject({
      toolCallId: "c1",
      toolName: "stop_task",
      tier: "write",
      status: "denied",
      hasResult: false,
      resultTruncated: false,
      // 存在性哨兵保留（投影与守卫脚本按它判断「事件说这里有错误文案」）
      errorMessage: "present",
    });

    // ① 正文**进事件**（第六阶段补的缺口②）：body.error 带脱敏后的拒绝原因，
    //    形状与另两个写入点逐字段同形（text/bytes/originalBytes/truncated）。
    //    脱敏对这句真实文案是**恒等**的（没有凭据样式），所以 text 应当逐字等于
    //    台账行的那一句——这正是「deny 文案与回落快照逐字相同」的写入侧前提。
    expect(payload.body).toMatchObject({
      result: null,
      error: {
        text: DENIED_ROW.errorMessage,
        bytes: Buffer.byteLength(DENIED_ROW.errorMessage, "utf8"),
        originalBytes: Buffer.byteLength(DENIED_ROW.errorMessage, "utf8"),
        truncated: false,
      },
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

  it("errorMessage 为空时：哨兵是 null，body.error 也是 null（不是空信封）", async () => {
    const h = harness({ rows: [{ ...DENIED_ROW, errorMessage: null }] });
    await deny(h);

    expect(h.seen[0].event.payload).toMatchObject({
      errorMessage: null,
      body: { result: null, error: null },
    });
  });

  /**
   * ② 含凭据的拒绝原因 ⇒ 库里（= 事件 payload 序列化结果）**无明文**。
   *
   * 造例贴近真实泄密面：拒绝文案里带模型/上游那句 `apiKey=sk-live-…`（S1-C3 的
   * 小写凭据形态，历史上正是这条规则被内联复制时丢掉的那一条）。断言的是
   * **整个 payload 的 JSON 串**里没有密钥明文，而不只是某一个字段——「某一处
   * 打了码、另一处还留着」正是上一次事故的形态。
   */
  it("含凭据的拒绝原因 ⇒ 事件 payload 里无明文（脱敏用既有 sanitizeString）", async () => {
    const secret = "sk-live-9f8e7d6c5b4a";
    const reason = `拒绝原因：上游 401（apiKey=${secret}）——不得重试同一调用`;
    const h = harness({ rows: [{ ...DENIED_ROW, errorMessage: reason }] });
    await deny(h);

    const payload = h.seen[0].event.payload as Any;
    const serialized = JSON.stringify(payload);

    // 库里那份（JSON 串）没有明文
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("9f8e7d6c5b4a");
    // 正文仍然可读：键名与上下文保留，只把值打码
    const error = (payload.body as Any).error as Any;
    expect(String(error.text)).toContain("拒绝原因：上游 401");
    expect(String(error.text)).toContain("apiKey=");
    // 打码标记由共享实现给出（不是本模块自创的占位）
    expect(String(error.text)).toMatch(/apiKey=\[REDACTED[_A-Z]*\]/);
    // 台账行的哨兵语义不受影响
    expect(payload.errorMessage).toBe("present");
  });

  /**
   * ③ 超长拒绝原因 ⇒ 截断 + `truncated:true` + `originalBytes` = **原文**长度
   * （不是截断后的 2048，也不是脱敏器 4000 字符上限之后的长度）。
   *
   * 用 5 KiB 的中文（每字 3 字节 ⇒ 真实字节数远大于 4000 字符上限），同时钉住
   * 「UTF-8 边界不切半个汉字」：截断后的文本里不该出现 U+FFFD。
   */
  it("超长拒绝原因 ⇒ 2 KiB 截断 + truncated:true + originalBytes=原文长度", async () => {
    const longReason = `拒绝原因：${"超长拒绝文案".repeat(900)}`;
    const rawBytes = Buffer.byteLength(longReason, "utf8");
    expect(rawBytes).toBeGreaterThan(4096);

    const h = harness({ rows: [{ ...DENIED_ROW, errorMessage: longReason }] });
    await deny(h);

    const error = ((h.seen[0].event.payload as Any).body as Any).error as {
      text: string;
      bytes: number;
      originalBytes: number;
      truncated: boolean;
    };
    expect(error.truncated).toBe(true);
    // 不静默：原文长度必须如实记下（脱敏器自己的 4000 字符上限也不能改写它）
    expect(error.originalBytes).toBe(rawBytes);
    expect(error.originalBytes).toBeGreaterThan(error.bytes);
    // 2 KiB 上限 + UTF-8 边界（不切半个汉字 ⇒ 字节数可小于上限，但绝不超过）
    expect(error.bytes).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(String(error.text), "utf8")).toBe(error.bytes);
    expect(String(error.text)).not.toContain("\uFFFD");
    expect(longReason.startsWith(String(error.text))).toBe(true);
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
