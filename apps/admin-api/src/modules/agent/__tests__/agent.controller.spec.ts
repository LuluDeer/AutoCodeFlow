import { ConflictException } from "@nestjs/common";
import type { Queue } from "bullmq";

import { AgentController } from "../agent.controller";
import type { AgentSession } from "../entities/agent-session.entity";

/**
 * B-8：resume 的再入队防线——running 会话拒绝重复入队（jobId 带 Date.now()
 * 绕过 BullMQ 去重，双 worker 会双跑同一会话），终态会话仍按既有语义返回
 * ok:false。
 */
function harness(sessionRow: Partial<AgentSession> | null) {
  const sessions = {
    requireById: jest.fn(async () => sessionRow),
    create: jest.fn(),
    list: jest.fn(),
    budget: jest.fn(),
  };
  const queue = {
    add: jest.fn(async () => undefined),
  } as unknown as Queue<unknown>;
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    queue as never,
  );
  return { ctl, sessions, queue };
}

const baseSession = {
  id: "s-1",
  kind: "incident",
  triggerSource: "cron",
  status: "waiting_input",
} as Partial<AgentSession>;

describe("AgentController · resume 状态防线（B-8）", () => {
  it("running 会话 → 409 Conflict，不入队", async () => {
    const h = harness({ ...baseSession, status: "running" });
    await expect(h.ctl.resume("s-1")).rejects.toThrow(ConflictException);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("终态（succeeded/aborted）→ ok:false（既有语义不变），不入队", async () => {
    for (const status of ["succeeded", "aborted"] as const) {
      const h = harness({ ...baseSession, status });
      const out = await h.ctl.resume("s-1");
      expect(out).toEqual({
        ok: false,
        reason: expect.stringContaining(status),
      });
      expect(h.queue.add).not.toHaveBeenCalled();
    }
  });

  it("挂起态（waiting_input）→ 正常入队（reason=resume:manual）", async () => {
    const h = harness({ ...baseSession, status: "waiting_input" });
    await expect(h.ctl.resume("s-1")).resolves.toEqual({ ok: true });
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      { sessionId: "s-1", reason: "resume:manual" },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it("failed/budget_exceeded/pending 仍放行入队（运行时的终态幂等闸兜底）", async () => {
    for (const status of ["failed", "budget_exceeded", "pending"] as const) {
      const h = harness({ ...baseSession, status });
      await expect(h.ctl.resume("s-1")).resolves.toEqual({ ok: true });
      expect(h.queue.add).toHaveBeenCalledTimes(1);
    }
  });
});
