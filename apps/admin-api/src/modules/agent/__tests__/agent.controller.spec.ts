import { ConflictException } from "@nestjs/common";
import type { Queue } from "bullmq";

import { AgentController } from "../agent.controller";
import type { AgentSession } from "../entities/agent-session.entity";

/**
 * B-8：resume 的再入队防线——running 会话拒绝重复入队（jobId 带 Date.now()
 * 绕过 BullMQ 去重，双 worker 会双跑同一会话），终态会话仍按既有语义返回
 * ok:false。
 */
function harness(
  sessionRow: Partial<AgentSession> | null,
  opts: { hasPending?: boolean; reopen?: boolean } = {},
) {
  const sessions = {
    requireById: jest.fn(async () => sessionRow),
    create: jest.fn(),
    list: jest.fn(),
    budget: jest.fn(),
    // GAP-6：failed → pending 的条件重开（false 模拟「状态已变化」）
    reopenForResume: jest.fn(async () => opts.reopen ?? true),
  };
  const queue = {
    add: jest.fn(async () => undefined),
  } as unknown as Queue<unknown>;
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    {
      findByKey: jest.fn(async () => null),
      decide: jest.fn(async () => null),
      listForSession: jest.fn(async () => []),
      // 实施轮 #14：resume 前置校验（有 pending 审批单时拒绝绕过审批）
      hasPendingForSession: jest.fn(async () => opts.hasPending ?? false),
    } as never,
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

  // 实施轮 #14：审批必须先处置——否则「审批」从门退化成通知，会话在未
  // 批准状态下继续推理并重提同一工具。
  it("仍有 pending 审批单 → 409，不入队（审批不能被 resume 绕过）", async () => {
    const h = harness(
      { ...baseSession, status: "waiting_input" },
      { hasPending: true },
    );
    await expect(h.ctl.resume("s-1")).rejects.toThrow(ConflictException);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("GAP-6：failed → 先条件重开为 pending 再入队（否则 run() 对终态短路 = 静默 no-op）", async () => {
    const h = harness({ ...baseSession, status: "failed" });
    await expect(h.ctl.resume("s-1")).resolves.toEqual({ ok: true });
    expect(h.sessions.reopenForResume).toHaveBeenCalledWith("s-1");
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(h.sessions.reopenForResume.mock.invocationCallOrder[0]).toBeLessThan(
      (h.queue.add as unknown as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("GAP-6：重开竞态失败（状态已变化）→ ok:false，不入队", async () => {
    const h = harness({ ...baseSession, status: "failed" }, { reopen: false });
    const out = await h.ctl.resume("s-1");
    expect(out).toEqual({
      ok: false,
      reason: expect.stringContaining("状态已变化"),
    });
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("GAP-6：budget_exceeded → ok:false（预算是创建时快照，重开必然立刻再次触顶）", async () => {
    const h = harness({ ...baseSession, status: "budget_exceeded" });
    const out = await h.ctl.resume("s-1");
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("预算") });
    expect(h.sessions.reopenForResume).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("pending 仍放行入队（首跑 job 可能已丢，显式重排是合法动作）", async () => {
    const h = harness({ ...baseSession, status: "pending" });
    await expect(h.ctl.resume("s-1")).resolves.toEqual({ ok: true });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    expect(h.sessions.reopenForResume).not.toHaveBeenCalled();
  });
});
