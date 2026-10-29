import type { Repository } from "typeorm";

import {
  AGENT_APPROVAL_TTL_MS,
  AgentApprovalsService,
} from "../runtime/agent-approvals.service";
import type { AgentApproval } from "../entities/agent-approval.entity";

/**
 * PK-19：待审批单 TTL 收口。
 *
 * pending 单没有 TTL 时，没人点的审批会让会话永久 waiting_input（既不执行、
 * 也不失败），运营看板上永远挂着「待审批」。
 */
function harness(rows: Array<Partial<AgentApproval>>, affected = 1) {
  const repo = {
    find: jest.fn(async (_q?: unknown) => rows),
    update: jest.fn(async () => ({ affected })),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  };
  const svc = new AgentApprovalsService(
    repo as unknown as Repository<AgentApproval>,
  );
  return { svc, repo };
}

describe("AgentApprovalsService.expireStalePending（PK-19）", () => {
  it("只扫 status='pending' 且 createdAt < cutoff，条件写钉住 pending", async () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const cutoff = new Date(now.getTime() - AGENT_APPROVAL_TTL_MS);
    const { svc, repo } = harness([
      { id: "a1", sessionId: "s1" },
      { id: "a2", sessionId: "s2" },
    ]);

    const res = await svc.expireStalePending(cutoff, now);

    expect(res).toEqual({ expired: 2, sessionIds: ["s1", "s2"] });
    const findArg = (repo.find.mock.calls[0] as unknown[])[0] as {
      where: { status: string; createdAt: unknown };
    };
    expect(findArg.where.status).toBe("pending");
    expect(findArg.where.createdAt).toBeDefined();
    expect(repo.update).toHaveBeenCalledWith(
      { id: "a1", status: "pending" },
      {
        status: "expired",
        decidedBy: "system:approval-ttl",
        decidedAt: now,
      },
    );
  });

  it("并发下已被人工处置（affected=0）的单不计入、不覆盖人工结论", async () => {
    const { svc } = harness([{ id: "a1", sessionId: "s1" }], 0);
    const res = await svc.expireStalePending(new Date());
    expect(res).toEqual({ expired: 0, sessionIds: [] });
  });

  it("没有陈旧单时不产生任何写", async () => {
    const { svc, repo } = harness([]);
    const res = await svc.expireStalePending(new Date());
    expect(res).toEqual({ expired: 0, sessionIds: [] });
    expect(repo.update).not.toHaveBeenCalled();
  });
});
