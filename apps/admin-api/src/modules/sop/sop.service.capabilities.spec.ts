import { SopService } from "./sop.service";

function harness(required: string[] = []) {
  const sop = {
    id: "sop-1",
    slug: "demo",
    title: "Demo",
    currentVersion: "1.0.0",
  };
  const version = {
    version: "1.0.0",
    contentHash: "hash",
    frontMatterJson: { acceptance: [], capabilities: required },
    bodyMarkdown: "Do the work",
  };
  const rows: any[] = [];
  const clarificationRows: any[] = [];
  const sops = { findOne: jest.fn().mockResolvedValue(sop) };
  const versions = { findOne: jest.fn().mockResolvedValue(version) };
  const assignments = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    find: jest.fn(async () => rows),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((candidate) =>
          Object.entries(where).every(([k, v]) => candidate[k] === v),
        ) ?? null,
    ),
    update: jest.fn(
      async (where: { id: string }, patch: Record<string, unknown>) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        const pulledAtCriteria = (where as { pulledAt?: unknown }).pulledAt;
        const expectedPulledAt =
          typeof pulledAtCriteria === "object" &&
          pulledAtCriteria !== null &&
          "type" in pulledAtCriteria &&
          pulledAtCriteria.type === "isNull"
            ? null
            : pulledAtCriteria;
        if (
          row &&
          Object.prototype.hasOwnProperty.call(where, "pulledAt") &&
          row.pulledAt !== expectedPulledAt
        ) {
          return { affected: 0 };
        }
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0 };
      },
    ),
  };
  const clarifications = {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      clarificationRows.filter((candidate) =>
        Object.entries(where).every(([k, v]) => candidate[k] === v),
      ),
    ),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        clarificationRows.find((candidate) =>
          Object.entries(where).every(([k, v]) => candidate[k] === v),
        ) ?? null,
    ),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })),
  };
  const executors = {
    getAgentCapabilities: jest.fn().mockResolvedValue(["agent:sop"]),
  };
  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    versions,
    assignments,
    clarifications,
    executors,
  }) as SopService;
  return {
    service,
    rows,
    clarificationRows,
    assignments,
    executors,
    clarifications,
  };
}

describe("SOP Agent capability lease at assignment and poll", () => {
  it("requires agent:sop and every published SOP capability at assignment", async () => {
    const h = harness(["gui"]);
    h.executors.getAgentCapabilities.mockResolvedValueOnce([]);
    await expect(
      h.service.assign({
        sopId: "sop-1",
        executorId: "e1",
        assignedBy: "test",
      }),
    ).rejects.toThrow("有效 Agent 能力");
    h.executors.getAgentCapabilities.mockResolvedValueOnce([
      "agent:sop",
      "browser",
    ]);
    await expect(
      h.service.assign({
        sopId: "sop-1",
        executorId: "e1",
        assignedBy: "test",
      }),
    ).rejects.toThrow("有效 Agent 能力");
    expect(h.assignments.save).not.toHaveBeenCalled();

    h.executors.getAgentCapabilities.mockResolvedValueOnce([
      "agent:sop",
      "gui",
    ]);
    await h.service.assign({
      sopId: "sop-1",
      executorId: "e1",
      assignedBy: "test",
    });
    expect(h.assignments.save).toHaveBeenCalledTimes(1);
  });

  it("delivers one assignment per poll and leaves the others unclaimed", async () => {
    const h = harness();
    h.rows.push(
      {
        id: "a1",
        sopId: "sop-1",
        sopVersion: "1.0.0",
        status: "assigned",
        pulledAt: null,
        maxRounds: 5,
        clarificationRound: 0,
      },
      {
        id: "a2",
        sopId: "sop-1",
        sopVersion: "1.0.0",
        status: "assigned",
        pulledAt: null,
        maxRounds: 5,
        clarificationRound: 0,
      },
    );

    const first = (await h.service.pollPending({ executorId: "e1" })) as Array<{
      kind: string;
      assignmentId: string;
    }>;
    expect(first.map((item) => item.assignmentId)).toEqual(["a1"]);
    expect(h.rows[0].pulledAt).toBeInstanceOf(Date);
    expect(h.rows[1].pulledAt).toBeNull();
    expect(h.clarifications.createQueryBuilder).not.toHaveBeenCalled();

    const second = (await h.service.pollPending({
      executorId: "e1",
    })) as Array<{ kind: string; assignmentId: string }>;
    expect(second.map((item) => item.assignmentId)).toEqual(["a2"]);
    expect(h.rows[1].pulledAt).toBeInstanceOf(Date);
  });

  it("requeues undelivered resend assignments for later polls", async () => {
    const h = harness();
    h.rows.push(
      {
        id: "a1",
        sopId: "sop-1",
        sopVersion: "1.0.0",
        status: "in_progress",
        pulledAt: new Date(),
        maxRounds: 5,
        clarificationRound: 0,
      },
      {
        id: "a2",
        sopId: "sop-1",
        sopVersion: "1.0.0",
        status: "in_progress",
        pulledAt: new Date(),
        maxRounds: 5,
        clarificationRound: 0,
      },
    );

    const first = (await h.service.pollPending({
      executorId: "e1",
      resendAssignments: true,
    })) as Array<{ assignmentId: string }>;
    expect(first.map((item) => item.assignmentId)).toEqual(["a1"]);
    expect(h.rows[1].pulledAt).toBeNull();

    const second = (await h.service.pollPending({
      executorId: "e1",
    })) as Array<{ assignmentId: string }>;
    expect(second.map((item) => item.assignmentId)).toEqual(["a2"]);
  });

  it("claims one unpulled assignment once across concurrent polls", async () => {
    const h = harness();
    h.rows.push({
      id: "a1",
      sopId: "sop-1",
      sopVersion: "1.0.0",
      status: "assigned",
      pulledAt: null,
    });
    const results = await Promise.all([
      h.service.pollPending({ executorId: "e1" }),
      h.service.pollPending({ executorId: "e1" }),
    ]);
    expect(
      results.flat().filter((item: any) => item.kind === "assignment"),
    ).toHaveLength(1);
  });

  it("does not claim GUI work when the current Agent lease lacks gui", async () => {
    const h = harness(["gui"]);
    h.rows.push({
      id: "a1",
      sopId: "sop-1",
      sopVersion: "1.0.0",
      status: "assigned",
      pulledAt: null,
    });
    const items = await h.service.pollPending({ executorId: "e1" });
    expect(items).toEqual([]);
    expect(h.assignments.update).not.toHaveBeenCalled();
  });

  it("delivers replied clarifications at least once and advances the cursor only on ack", async () => {
    // P7d 双端 ACK：resolution 落定的回复随 poll 投递（投递不推游标 = 至少
    // 一次），执行器消费落盘后经 ackClarificationReply 确认才推进游标。
    const h = harness();
    h.rows.push({
      id: "a1",
      sopId: "sop-1",
      sopVersion: "1.0.0",
      status: "in_progress",
      pulledAt: new Date(),
      targetExecutorId: "e1",
      lastReplyDeliveredAt: null,
    });
    const repliedAt = new Date("2026-01-02T00:00:00.000Z");
    h.clarificationRows.push({
      id: "clr-1",
      assignmentId: "a1",
      round: 1,
      resolution: "answered",
      answer: "在页面右上角",
      updatedAt: repliedAt,
    });

    const first = (await h.service.pollPending({
      executorId: "e1",
    })) as Array<{ kind: string; clarificationId: string; answer: string }>;
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("clarification_reply");
    expect(first[0].clarificationId).toBe("clr-1");
    expect(first[0].answer).toBe("在页面右上角");

    // ACK 前：游标不动，回复随每次 poll 重发（至少一次投递）
    expect(await h.service.pollPending({ executorId: "e1" })).toHaveLength(1);
    expect(h.rows[0].lastReplyDeliveredAt).toBeNull();

    await h.service.ackClarificationReply({
      assignmentId: "a1",
      executorId: "e1",
      clarificationId: "clr-1",
    });
    expect(h.rows[0].lastReplyDeliveredAt).toEqual(repliedAt);
    // ACK 后：不再投递
    expect(await h.service.pollPending({ executorId: "e1" })).toEqual([]);
  });

  it("ack rejects cross-executor confirmation and unresolved clarifications", async () => {
    const h = harness();
    h.rows.push({
      id: "a1",
      sopId: "sop-1",
      sopVersion: "1.0.0",
      status: "blocked",
      pulledAt: new Date(),
      targetExecutorId: "e1",
      lastReplyDeliveredAt: null,
    });
    h.clarificationRows.push({
      id: "clr-1",
      assignmentId: "a1",
      round: 1,
      resolution: null,
      updatedAt: new Date(),
    });
    // 未回复的澄清不可确认
    await expect(
      h.service.ackClarificationReply({
        assignmentId: "a1",
        executorId: "e1",
        clarificationId: "clr-1",
      }),
    ).rejects.toThrow("尚未回复");
    // 别人的机器不能推游标
    h.clarificationRows[0].resolution = "answered";
    await expect(
      h.service.ackClarificationReply({
        assignmentId: "a1",
        executorId: "e2",
        clarificationId: "clr-1",
      }),
    ).rejects.toThrow("不属于该执行器");
    expect(h.rows[0].lastReplyDeliveredAt).toBeNull();
  });
});
