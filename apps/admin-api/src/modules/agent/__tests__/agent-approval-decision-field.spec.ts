/**
 * approval_decided payload 的 `decision` 字段单测（内存替身）。
 *
 * 覆盖：withdraw/deny/grant 显式传 decision ⇒ 事件 payload 带该字段且 status 兼容；
 * 既有 agent 主线 3 参调用不传 ⇒ payload 仍是 4 键（不破坏既有断言）。
 */
import {
  AgentApprovalsService,
  buildApprovalDecidedPayload,
} from "../runtime/agent-approvals.service";
import type { AgentEventInput } from "../entities/agent-event.entity";

type Any = Record<string, any>;

const KEY = "apr-s-1-0123456789abcdef";
const DECIDED_AT = new Date("2026-11-02T02:00:00.000Z");

function repo(status = "denied") {
  const row: Any = {
    approvalKey: KEY,
    sessionId: "s-1",
    toolName: "update_task",
    status,
    scope: "once",
    decidedBy: "alice",
    decidedAt: DECIDED_AT,
    argsDigest: null,
    policyFingerprint: null,
  };
  return {
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async () => ({ ...row })),
  };
}

function sink() {
  const seen: Array<{ sessionId: string; event: AgentEventInput }> = [];
  return {
    seen,
    tryAppendEvent: jest.fn(
      async (sessionId: string, event: AgentEventInput) => {
        seen.push({ sessionId, event });
        return seen.length;
      },
    ),
  };
}

describe("approval_decided · decision 字段", () => {
  it("buildApprovalDecidedPayload 显式 decision ⇒ 带字段且保留 status", () => {
    const payload = buildApprovalDecidedPayload({
      approvalKey: KEY,
      status: "denied",
      decidedBy: "withdraw:user:42",
      decidedAt: DECIDED_AT,
      decision: "withdraw",
    });
    expect(payload).toEqual({
      approvalKey: KEY,
      status: "denied",
      decidedBy: "withdraw:user:42",
      decidedAt: DECIDED_AT.toISOString(),
      decision: "withdraw",
    });
  });

  it("不传 decision ⇒ 仍是旧 4 键 payload（既有 agent 主线零改动）", () => {
    const payload = buildApprovalDecidedPayload({
      approvalKey: KEY,
      status: "granted",
      decidedBy: "alice",
      decidedAt: DECIDED_AT,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "approvalKey",
      "decidedAt",
      "decidedBy",
      "status",
    ]);
    expect(payload).not.toHaveProperty("decision");
  });

  it.each(["grant", "deny", "withdraw"] as const)(
    "decide 第 4 参 %s ⇒ 发出的 approval_decided 带 decision=%s",
    async (decision) => {
      const r = repo(decision === "grant" ? "granted" : "denied");
      const svc = new AgentApprovalsService(r as never);
      const s = sink();
      svc.attachEventSink(s);

      await svc.decide(
        KEY,
        decision === "grant" ? "granted" : "denied",
        "alice",
        decision,
      );

      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].event.kind).toBe("approval_decided");
      expect(s.seen[0].event.payload).toMatchObject({
        approvalKey: KEY,
        status: decision === "grant" ? "granted" : "denied",
        decision,
      });
    },
  );

  it("3 参 decide（agent 主线既有调用）⇒ 事件不带 decision 字段", async () => {
    const r = repo("granted");
    const svc = new AgentApprovalsService(r as never);
    const s = sink();
    svc.attachEventSink(s);

    await svc.decide(KEY, "granted", "alice");

    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].event.payload).not.toHaveProperty("decision");
    expect(s.seen[0].event.payload).toMatchObject({ status: "granted" });
  });
});
