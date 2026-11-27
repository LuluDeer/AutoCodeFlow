/**
 * 工作台审批端口的**真实副作用**单测（内存替身，无 PG / Redis / Nest）。
 *
 * 覆盖：
 * ① deny / withdraw 结算 tool_calls 台账 + 发 tool_call_status_changed（settled）；
 * ② approval_decided 事件带 decision=deny/withdraw（与 status=denied 并存）；
 * ③ 建单人 grant 自己 ⇒ AGENT_APPROVAL_SELF_DENIED + 零副作用；
 * ④ 已处置 / 不存在 / 不匹配 ⇒ false + 零副作用；
 * ⑤ requestAbort 只认 result.aborted（终态 false，不假成功）。
 */
import type { ModuleRef } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { DataSource } from "typeorm";

import { AgentApprovalsService } from "../../agent/runtime/agent-approvals.service";
import { AgentEventStreamService } from "../../agent/runtime/agent-event-stream.service";
import { AgentSessionService } from "../../agent/runtime/agent-session.service";
import { AGENT_QUEUE_NAME } from "../../agent/runtime/agent.processor";
import { createWorkbenchSessionInteractionPort } from "../workbench-session-interaction.adapter";
import type { WorkbenchDecideApprovalInput } from "../workbench-session-interaction.port";

type Any = Record<string, any>;

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "apr-22222222-2222-4222-8222-222222222222-abcdef0123456789";

function harness(options: {
  approvalStatus?: string;
  sessionCreatedBy?: string;
  abortResult?: Any;
} = {}) {
  const approval: Any = {
    approvalKey: KEY,
    sessionId: SESSION_ID,
    toolName: "update_task",
    status: options.approvalStatus ?? "pending",
  };
  const session: Any = {
    id: SESSION_ID,
    status: "waiting_input",
    totalSteps: 3,
    createdBy: options.sessionCreatedBy ?? "user:99",
  };
  const toolCalls: Any[] = [
    {
      approvalId: KEY,
      status: "awaiting_approval",
      toolCallId: "tc-1",
      toolName: "update_task",
      tier: "write",
      durationMs: 12,
      resultJson: null,
      errorMessage: null,
      resultTruncated: false,
    },
  ];

  const approvals = {
    findByKey: jest.fn(async () => approval),
    decide: jest.fn(async (_key: string, status: string) => ({
      ...approval,
      status,
    })),
    hasPendingForSession: jest.fn(async () => false),
  };
  const sessions = {
    findById: jest.fn(async () => session),
    // 真实语义：条件写 awaiting_approval → denied，返回受影响行数
    settleToolCallByApprovalId: jest.fn(async () => {
      let affected = 0;
      for (const row of toolCalls) {
        if (row.approvalId === KEY && row.status === "awaiting_approval") {
          row.status = "denied";
          row.errorMessage = `已被 ... 人工拒绝（审批单 ${KEY}）——不得重试同一调用`;
          affected += 1;
        }
      }
      return affected;
    }),
    listToolCalls: jest.fn(async () => toolCalls),
    findEventSeqByRef: jest.fn(async () => 7),
    tryAppendEvent: jest.fn(async () => 1),
  };
  const stream = {
    requestAbort: jest.fn(async () => options.abortResult ?? {
      sessionId: SESSION_ID,
      status: "aborted",
      aborted: true,
    }),
    sendMessageAndResume: jest.fn(),
  };
  const queue = { add: jest.fn(async () => ({})) };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === AgentSessionService) return sessions;
      if (token === AgentApprovalsService) return approvals;
      if (token === AgentEventStreamService) return stream;
      if (token === getQueueToken(AGENT_QUEUE_NAME)) return queue;
      if (token === DataSource) return { query: jest.fn() };
      return {};
    }),
  } as unknown as ModuleRef;

  const port = createWorkbenchSessionInteractionPort(moduleRef);
  return { port, approvals, sessions, stream, queue, toolCalls, approval, session };
}

function decideInput(decision: WorkbenchDecideApprovalInput["decision"]): WorkbenchDecideApprovalInput {
  return {
    sessionId: SESSION_ID,
    approvalKey: KEY,
    decision,
    actor: "user:42",
    username: "alice",
  };
}

describe("工作台审批 — deny/withdraw 真实副作用", () => {
  it.each(["deny", "withdraw"] as const)(
    "%s：结算台账 + tool_call_status_changed + decision 字段",
    async (decision) => {
      const h = harness();
      await expect(h.port.decideApproval(decideInput(decision))).resolves.toBe(true);

      // ① 审批流转：denied + 显式 decision（withdraw 与 deny 同 status 不同 decision）
      expect(h.approvals.decide).toHaveBeenCalledTimes(1);
      expect(h.approvals.decide).toHaveBeenCalledWith(
        KEY,
        "denied",
        decision === "withdraw" ? "withdraw:user:42" : "alice",
        decision,
      );

      // ② tool_calls 台账真的从 awaiting_approval 翻到 denied
      expect(h.sessions.settleToolCallByApprovalId).toHaveBeenCalledTimes(1);
      expect(h.sessions.settleToolCallByApprovalId).toHaveBeenCalledWith(
        KEY,
        "denied",
        expect.stringContaining(KEY),
      );
      expect(h.toolCalls[0].status).toBe("denied");

      // ③ settled 事件真的发出（且只发一次，causedBySeq 指向 approval_decided）
      expect(h.sessions.tryAppendEvent).toHaveBeenCalledTimes(1);
      expect(h.sessions.findEventSeqByRef).toHaveBeenCalledWith(
        SESSION_ID,
        "approval_decided",
        { approvalKey: KEY, status: "denied" },
      );
      const event = (h.sessions.tryAppendEvent.mock.calls[0] as Any[])[1] as Any;
      expect(event.kind).toBe("tool_call_status_changed");
      expect(event.causedBySeq).toBe(7);
      expect(event.payload).toMatchObject({
        toolCallId: "tc-1",
        status: "denied",
      });

      // ④ 恢复入队仍然发生（与既有契约一致）
      expect(h.queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it("grant：不结算台账、不发 settled，decision=grant", async () => {
    const h = harness();
    await expect(h.port.decideApproval(decideInput("grant"))).resolves.toBe(true);
    expect(h.approvals.decide).toHaveBeenCalledWith(KEY, "granted", "alice", "grant");
    expect(h.sessions.settleToolCallByApprovalId).not.toHaveBeenCalled();
    expect(h.sessions.tryAppendEvent).not.toHaveBeenCalled();
  });

  it("建单人 grant 自己 ⇒ AGENT_APPROVAL_SELF_DENIED 且零副作用", async () => {
    const h = harness({ sessionCreatedBy: "user:42" });
    let error: unknown;
    try {
      await h.port.decideApproval(decideInput("grant"));
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({
      errorCode: "AGENT_APPROVAL_SELF_DENIED",
    });
    expect(h.approvals.decide).not.toHaveBeenCalled();
    expect(h.sessions.settleToolCallByApprovalId).not.toHaveBeenCalled();
    expect(h.sessions.tryAppendEvent).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("已处置 / 不存在 / 会话不匹配 ⇒ false，零副作用", async () => {
    const decided = harness({ approvalStatus: "granted" });
    await expect(decided.port.decideApproval(decideInput("deny"))).resolves.toBe(false);
    expect(decided.approvals.decide).not.toHaveBeenCalled();
    expect(decided.sessions.settleToolCallByApprovalId).not.toHaveBeenCalled();
    expect(decided.queue.add).not.toHaveBeenCalled();

    const missing = harness();
    missing.approvals.findByKey.mockResolvedValueOnce(null);
    await expect(missing.port.decideApproval(decideInput("deny"))).resolves.toBe(false);
    expect(missing.approvals.decide).not.toHaveBeenCalled();

    const mismatch = harness();
    mismatch.approvals.findByKey.mockResolvedValueOnce({ ...mismatch.approval, sessionId: "other" });
    await expect(mismatch.port.decideApproval(decideInput("deny"))).resolves.toBe(false);
    expect(mismatch.approvals.decide).not.toHaveBeenCalled();
  });
});

describe("工作台取消 — result.aborted", () => {
  it("终态会话 aborted=false ⇒ 端口返回 false（不是 Boolean(result)）", async () => {
    const h = harness({
      abortResult: { sessionId: SESSION_ID, status: "succeeded", aborted: false },
    });
    await expect(h.port.requestAbort(SESSION_ID, "user:42")).resolves.toBe(false);
  });

  it("非终态 aborted=true ⇒ true", async () => {
    const h = harness();
    await expect(h.port.requestAbort(SESSION_ID, "user:42")).resolves.toBe(true);
  });
});
