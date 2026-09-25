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
  const sops = { findOne: jest.fn().mockResolvedValue(sop) };
  const versions = { findOne: jest.fn().mockResolvedValue(version) };
  const assignments = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => value),
    find: jest.fn(async () => rows),
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
  return { service, rows, assignments, executors, clarifications };
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

  it("does not advance clarification reply cursors before Host supports ACK", async () => {
    const h = harness();
    h.rows.push({
      id: "a1",
      sopId: "sop-1",
      sopVersion: "1.0.0",
      status: "blocked",
      pulledAt: new Date(),
      lastReplyDeliveredAt: null,
    });
    expect(await h.service.pollPending({ executorId: "e1" })).toEqual([]);
    expect(h.rows[0].lastReplyDeliveredAt).toBeNull();
    expect(h.assignments.update).not.toHaveBeenCalled();
  });
});
