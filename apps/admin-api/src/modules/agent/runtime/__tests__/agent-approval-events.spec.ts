import { ConflictException } from "@nestjs/common";

import {
  AgentApprovalsService,
  buildApprovalDecidedPayload,
} from "../agent-approvals.service";
import { AgentSessionService } from "../agent-session.service";
import { AGENT_EVENT_KINDS } from "../../entities/agent-event.entity";
import type { AgentApproval } from "../../entities/agent-approval.entity";
import type { AgentEventInput } from "../../entities/agent-event.entity";

/**
 * S7-G1（第四阶段）：`approval_decided` 的**写入面**。
 *
 * 这一组用例钉住四件只能靠实现证伪的事：
 *  ① grant / deny / consume **各自**落一条事件，payload 形状与「与库同一个时刻」
 *    逐字对齐（少一个字段，投影就重建不出快照那三句文案）；
 *  ② **并发输家不落事件**——条件 UPDATE 命中 0 行时库里什么都没变，此时落一条
 *    「批了」会让投影指挥模型重提一次并未获批的副作用调用（本组最关键的用例）；
 *  ③ 事件写入失败（端口抛错 / 返回 null / 端口缺席）**不改变审批主链**；
 *  ④ 接线本身（`AgentSessionService` 构造时把写事件的端口注册给审批服务）——
 *    漏了这一步，事件永远不会被写，而上游三条用例全都绿（它们自己 attach）。
 *
 * 为什么用 `attachEventSink` 而不是真装配 Nest：审批与会话之间是**反向注册**
 * （见 `AgentApprovalEventSink` 的注释），本组用同一个接口替身即可覆盖两条边。
 */

type Any = Record<string, any>;

const KEY = "apr-s-1-0123456789abcdef";
const FP = "f".repeat(64);

/** 已批准的单（deny/consume 用例的读回形态按需覆盖字段）。 */
const grantedRow = {
  id: "ap-1",
  approvalKey: KEY,
  sessionId: "s-1",
  toolName: "update_task",
  status: "granted",
  scope: "once",
  decidedBy: "alice",
  decidedAt: new Date("2026-11-02T02:00:00.000Z"),
  argsDigest: null,
  policyFingerprint: null,
} as unknown as AgentApproval;

/** 审批仓库替身（只提供本组触达的方法）。 */
function repo(o: {
  update: jest.Mock;
  findOne: jest.Mock;
  insert?: jest.Mock;
}) {
  return {
    create: jest.fn((x: Any) => x),
    save: jest.fn(async (x: Any) => x),
    insert: o.insert ?? jest.fn(async () => ({ identifiers: [] })),
    update: o.update,
    findOne: o.findOne,
    find: jest.fn(async () => []),
  } as Any;
}

/** 事件端口替身：记录「落给哪个会话、落的什么事件」。 */
function sink() {
  const seen: Array<{ sessionId: string; event: AgentEventInput }> = [];
  const tryAppendEvent = jest.fn(
    async (sessionId: string, event: AgentEventInput) => {
      seen.push({ sessionId, event });
      return seen.length;
    },
  );
  return { seen, tryAppendEvent };
}

describe("approval_decided · ① 写入点：grant / deny / consume 各落一条", () => {
  it("事件类型已登记（闭集里必须有它，否则写入点编译不过、投影记 unknown_event）", () => {
    expect(AGENT_EVENT_KINDS).toContain("approval_decided");
  });

  it("grant 成功 ⇒ 落一条 status=granted + decidedBy + 与库同一时刻，且**先写库后落事件**", async () => {
    const update = jest.fn(async () => ({ affected: 1 }));
    const r = repo({ update, findOne: jest.fn(async () => grantedRow) });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    const out = await svc.decide(KEY, "granted", "alice");
    expect(out?.status).toBe("granted");

    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].sessionId).toBe("s-1");
    expect(s.seen[0].event.kind).toBe("approval_decided");
    expect(s.seen[0].event.payload).toEqual({
      approvalKey: KEY,
      status: "granted",
      decidedBy: "alice",
      decidedAt: expect.any(String),
    });
    // 决定时刻：事件里的 ISO 串必须**就是**落库那个 Date（同一时刻，不是两次 new Date）
    const [, patch] = update.mock.calls[0] as unknown as [Any, Any];
    expect(s.seen[0].event.payload?.decidedAt).toBe(
      (patch.decidedAt as Date).toISOString(),
    );
    // 顺序：条件 UPDATE 命中在前，事件在后（反过来就可能在命中 0 行时也写了事件）
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      s.tryAppendEvent.mock.invocationCallOrder[0],
    );
  });

  it("payload 恰好四个键：不放 preview / argsDigest / 参数（本表长期保留，宁可少记）", async () => {
    const update = jest.fn(async () => ({ affected: 1 }));
    const r = repo({ update, findOne: jest.fn(async () => grantedRow) });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);
    await svc.decide(KEY, "granted", "alice");

    const payload = s.seen[0].event.payload as Any;
    expect(Object.keys(payload).sort()).toEqual([
      "approvalKey",
      "decidedAt",
      "decidedBy",
      "status",
    ]);
    expect(payload).not.toHaveProperty("preview");
    expect(payload).not.toHaveProperty("argsDigest");
  });

  it("deny ⇒ 落一条 status=denied（决定人随事件走）", async () => {
    const update = jest.fn(async () => ({ affected: 1 }));
    const r = repo({
      update,
      findOne: jest.fn(async () => ({ ...grantedRow, status: "denied" })),
    });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    await svc.decide(KEY, "denied", "bob");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].event.payload).toMatchObject({
      approvalKey: KEY,
      status: "denied",
      decidedBy: "bob",
    });
  });

  it("consume 命中 ⇒ 落一条 status=consumed（decidedBy=null：领取由执行体发起），时刻与 consumedAt 同一", async () => {
    const update = jest.fn(async () => ({ affected: 1 }));
    const r = repo({
      update,
      findOne: jest.fn(async () => ({ sessionId: "s-1" })),
    });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    await expect(svc.consume(KEY, FP)).resolves.toBe(true);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].sessionId).toBe("s-1");
    expect(s.seen[0].event.payload).toMatchObject({
      approvalKey: KEY,
      status: "consumed",
      decidedBy: null,
    });
    const [, patch] = update.mock.calls[0] as unknown as [Any, Any];
    expect(s.seen[0].event.payload?.decidedAt).toBe(
      (patch.consumedAt as Date).toISOString(),
    );
  });

  it("consume 命中 0 行（已被别处领取 / 指纹已变）⇒ 不落事件", async () => {
    const r = repo({
      update: jest.fn(async () => ({ affected: 0 })),
      findOne: jest.fn(async () => ({ ...grantedRow })),
    });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    await expect(svc.consume(KEY, FP)).resolves.toBe(false);
    expect(s.tryAppendEvent).not.toHaveBeenCalled();
  });
});

describe("approval_decided · ② 并发输家（条件 UPDATE 命中 0 行）**不落事件**", () => {
  it("后到的 grant 收 409，且事件流里没有第二条「批了」", async () => {
    const update = jest.fn(async () => ({ affected: 0 }));
    const r = repo({
      update,
      // 赢家已经把单改成 denied（结论只有一个，先到者赢）
      findOne: jest.fn(async () => ({ ...grantedRow, status: "denied" })),
    });
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    await expect(svc.decide(KEY, "granted", "bob")).rejects.toThrow(
      ConflictException,
    );
    // 库里没变 ⇒ 事件也不能说变了：否则投影会让模型「立即重提」一次未获批的调用
    expect(s.tryAppendEvent).not.toHaveBeenCalled();
    expect(s.seen).toEqual([]);
  });

  it("并发两次 grant：只有命中 0 行以外的那一次落事件（win/lose 成对断言）", async () => {
    const s = sink();
    // 赢家
    const winner = new AgentApprovalsService(
      repo({
        update: jest.fn(async () => ({ affected: 1 })),
        findOne: jest.fn(async () => grantedRow),
      }) as never,
    );
    winner.attachEventSink(s);
    // 输家（同一瞬间的另一个管理员）
    const loser = new AgentApprovalsService(
      repo({
        update: jest.fn(async () => ({ affected: 0 })),
        findOne: jest.fn(async () => grantedRow),
      }) as never,
    );
    loser.attachEventSink(s);

    await expect(loser.decide(KEY, "granted", "bob")).rejects.toThrow(
      ConflictException,
    );
    await expect(winner.decide(KEY, "granted", "alice")).resolves.toBeTruthy();

    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].event.payload?.decidedBy).toBe("alice");
  });
});

describe("approval_decided · ⑤ 事件写入失败不改变审批主链（旁路契约）", () => {
  it("端口抛错 ⇒ decide 照常返回 granted（记账失败不得弄挂一次人工批准）", async () => {
    const r = repo({
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => grantedRow),
    });
    const svc = new AgentApprovalsService(r as never);
    svc.attachEventSink({
      tryAppendEvent: jest.fn(async () => {
        throw new Error("agent_events insert failed");
      }),
    });

    await expect(svc.decide(KEY, "granted", "alice")).resolves.toMatchObject({
      status: "granted",
    });
  });

  it("端口返回 null（tryAppendEvent 的失败形态）⇒ consume 照常返回 true", async () => {
    const svc = new AgentApprovalsService(
      repo({
        update: jest.fn(async () => ({ affected: 1 })),
        findOne: jest.fn(async () => ({ sessionId: "s-1" })),
      }) as never,
    );
    svc.attachEventSink({ tryAppendEvent: jest.fn(async () => null) });
    await expect(svc.consume(KEY, FP)).resolves.toBe(true);
  });

  it("端口缺席（单测直接 new / 裁剪部署）⇒ 不落事件、不抛、也不多发那次回读", async () => {
    const findOne = jest.fn(async () => ({ sessionId: "s-1" }));
    const svc = new AgentApprovalsService(
      repo({
        update: jest.fn(async () => ({ affected: 1 })),
        findOne,
      }) as never,
    );
    await expect(svc.consume(KEY, FP)).resolves.toBe(true);
    await expect(svc.decide(KEY, "granted", "alice")).resolves.toBeTruthy();
    // consume：端口缺席时连「按 key 回读 sessionId」都不发
    expect(findOne).toHaveBeenCalledTimes(1); // 只有 decide 那一次
  });
});

describe("approval_decided · ④ 接线：AgentSessionService 把写事件端口注册给审批服务", () => {
  /** 装配 AgentSessionService（只提供本组触达的依赖）。 */
  function sessionService(approvals: Any) {
    const emQuery = jest.fn(async (_sql: string, _params?: unknown) => [
      { seq: 1 },
    ]);
    const sessions: Any = {
      findOne: jest.fn(async () => null),
      update: jest.fn(async () => ({ affected: 1 })),
      manager: {
        transaction: jest.fn(async (cb: (em: Any) => Promise<unknown>) =>
          cb({ query: emQuery }),
        ),
      },
    };
    const svc = new AgentSessionService(
      sessions as never,
      { find: jest.fn(async () => []) } as never,
      { find: jest.fn(async () => []), update: jest.fn() } as never,
      { resolveBudget: jest.fn(() => ({})) } as never,
      {
        sessionFinished: jest.fn(),
        staleSweepConverged: jest.fn(),
      } as never,
      null,
      approvals as never,
    );
    return { svc, emQuery };
  }

  it("构造时注册 attachEventSink，端口调下去真的走到 appendEvents（seq 分配的唯一实现）", async () => {
    const attachEventSink = jest.fn();
    const { emQuery } = sessionService({
      attachEventSink,
      hasPendingForSession: jest.fn(),
      expireStalePending: jest.fn(),
    });
    expect(attachEventSink).toHaveBeenCalledTimes(1);

    const port = attachEventSink.mock.calls[0][0] as {
      tryAppendEvent: (s: string, e: AgentEventInput) => Promise<number | null>;
    };
    await expect(
      port.tryAppendEvent("s-1", {
        kind: "approval_decided",
        payload: { approvalKey: KEY, status: "granted" },
      }),
    ).resolves.toBe(1);
    // 走的是那条「取基址 + 连续分配 + 插入」的单语句，不是另写一份 seq 逻辑
    expect(emQuery).toHaveBeenCalledTimes(1);
    expect(String(emQuery.mock.calls[0][0])).toContain('MAX("seq")');
  });

  it("既有单测式替身（没有 attachEventSink）⇒ 构造不抛，事件静默缺席", () => {
    expect(() =>
      sessionService({ hasPendingForSession: jest.fn() }),
    ).not.toThrow();
  });

  it("payload 构造函数把 null 署名写成显式 null（不能整键消失）", () => {
    const p = buildApprovalDecidedPayload({
      approvalKey: KEY,
      status: "consumed",
      decidedBy: null,
      decidedAt: new Date("2026-11-02T02:00:00.000Z"),
    });
    expect(p).toEqual({
      approvalKey: KEY,
      status: "consumed",
      decidedBy: null,
      decidedAt: "2026-11-02T02:00:00.000Z",
    });
    // jsonb 往返：undefined 会整键消失，null 不会
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
