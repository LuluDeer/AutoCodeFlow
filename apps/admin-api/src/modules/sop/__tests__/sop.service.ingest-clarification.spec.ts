import { ForbiddenException } from "@nestjs/common";

import { SopService } from "../sop.service";

/**
 * B-1 + B-7：澄清上报的归属断言与轮次 CAS。
 *
 * B-1：澄清通道是跨执行器面——ingestClarification 只验 agent:sop 能力时，
 * 任何 agent:sop 机器都能往他人工单塞澄清；幂等键 dupe 查询全局命中还会把
 * 别人工单的 question/answer 整行读走。
 * B-7：clarificationRound 读改写无 CAS 时，并发澄清会产生同轮双复核会话、
 * maxRounds 并发多放一轮。
 */

interface AssignmentRow {
  id: string;
  sopId: string;
  sopVersion: string;
  targetExecutorId: string;
  status: string;
  clarificationRound: number;
  maxRounds: number;
  targetAgentSessionId: string | null;
  parentSessionId: string | null;
}

function harness(assignment: Partial<AssignmentRow> = {}) {
  const row: AssignmentRow = {
    id: "a1",
    sopId: "sop-1",
    sopVersion: "1.0.0",
    targetExecutorId: "e1",
    status: "in_progress",
    clarificationRound: 0,
    maxRounds: 5,
    targetAgentSessionId: null,
    parentSessionId: null,
    ...assignment,
  };
  const rows: AssignmentRow[] = [row];

  const assignments = {
    // findOne 返回**快照副本**（对齐 TypeORM 语义）——并发交错下 CAS 的
    // where 值来自读取时刻的快照，而不是可变引用的即时值
    findOne: jest.fn(async () => ({ ...row })),
    // CAS 语义：where 里的 clarificationRound（若有）必须与当前值一致
    update: jest.fn(
      async (
        where: { id: string; clarificationRound?: number },
        patch: Record<string, unknown>,
      ) => {
        if (row.id !== where.id) return { affected: 0 };
        if (
          Object.prototype.hasOwnProperty.call(where, "clarificationRound") &&
          row.clarificationRound !== where.clarificationRound
        ) {
          return { affected: 0 };
        }
        Object.assign(row, patch);
        return { affected: 1 };
      },
    ),
  };
  const clarificationRows: Array<Record<string, unknown>> = [];
  const clarifications = {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        clarificationRows.find((c) =>
          Object.entries(where).every(([k, v]) => c[k] === v),
        ) ?? null,
    ),
    create: jest.fn((v: unknown) => ({
      id: `clr-${clarificationRows.length + 1}`,
      ...(v as object),
    })),
    save: jest.fn(async (v: Record<string, unknown>) => {
      clarificationRows.push(v);
      return v;
    }),
    update: jest.fn(async () => undefined),
  };
  const createdSessions: Array<Record<string, unknown>> = [];
  const agentSessions = {
    create: jest.fn(async (v: Record<string, unknown>) => {
      const s = { id: `sess-${createdSessions.length + 1}`, ...v };
      createdSessions.push(s);
      return s;
    }),
  };
  const agentQueue = { add: jest.fn(async () => undefined) };
  const notifications = { notify: jest.fn(async () => undefined) };

  const service = Object.assign(Object.create(SopService.prototype), {
    assignments,
    clarifications,
    agentSessions,
    agentQueue,
    notifications,
    logger: { log: jest.fn(), warn: jest.fn() },
  }) as SopService;

  const baseInput = {
    assignmentId: "a1",
    executorId: "e1",
    question: "第 3 步弹窗点不动，怎么办？",
  };

  return {
    service,
    row,
    rows,
    clarificationRows,
    createdSessions,
    assignments,
    clarifications,
    agentQueue,
    baseInput,
  };
}

describe("SOP ingestClarification · 归属断言（B-1）", () => {
  it("他机工单 → 403（澄清归属由指派决定，能力闸不等于归属授权）", async () => {
    const h = harness();
    await expect(
      h.service.ingestClarification({ ...h.baseInput, executorId: "e-OTHER" }),
    ).rejects.toThrow(ForbiddenException);
    expect(h.clarificationRows).toHaveLength(0);
    expect(h.createdSessions).toHaveLength(0);
  });

  it("本机回归：归属一致时正常起复核会话并推进轮次", async () => {
    const h = harness();
    const out = await h.service.ingestClarification(h.baseInput);
    expect(out.escalated).toBe(false);
    expect(out.clarification).toMatchObject({ assignmentId: "a1", round: 1 });
    expect(h.createdSessions).toHaveLength(1);
    expect(h.row.clarificationRound).toBe(1);
    expect(h.row.status).toBe("blocked");
  });

  it("幂等命中限定在本指派内：他机工单的 clientClarificationId 不回显其内容", async () => {
    const h = harness();
    // 别的执行器在其工单 a-other 上已有的澄清（含问答明文）
    h.clarificationRows.push({
      id: "clr-victim",
      assignmentId: "a-other",
      clientClarificationId: "cc-shared",
      round: 2,
      question: "受害工单的问题",
      answer: "受害工单的答案",
      resolution: "answered",
    });

    // 攻击者（同属 agent:sop 面）用偷到的幂等键 + 自己可见的指派重放——
    // dupe 查询限定 assignmentId 后不再命中，走正常 ingest（随后归属断言
    // 或正常受理，但绝不把受害行的 question/answer 返回来）。
    const out = await h.service.ingestClarification({
      ...h.baseInput,
      clientClarificationId: "cc-shared",
    });
    expect(out.clarification).not.toMatchObject({
      question: "受害工单的问题",
    });
    expect(
      (out.clarification as unknown as Record<string, unknown>).answer,
    ).toBeUndefined();
  });

  it("幂等重放（同指派同幂等键）仍返回已有行——不产生重复澄清", async () => {
    const h = harness();
    const first = await h.service.ingestClarification({
      ...h.baseInput,
      clientClarificationId: "cc-1",
    });
    // 模拟复核已答复（save 存的是同一引用，就地补答复字段）
    (first.clarification as unknown as Record<string, unknown>).answer =
      "重启浏览器";
    (first.clarification as unknown as Record<string, unknown>).resolution =
      "answered";
    const second = await h.service.ingestClarification({
      ...h.baseInput,
      clientClarificationId: "cc-1",
    });
    expect(
      (second.clarification as unknown as Record<string, unknown>).answer,
    ).toBe("重启浏览器");
    expect(h.createdSessions).toHaveLength(1); // 没有第二条复核会话
  });
});

describe("SOP ingestClarification · 轮次推进 CAS（B-7）", () => {
  it("两次并发读同轮：只有一个胜者，败者重读后轮次连续（无双会话同轮）", async () => {
    const h = harness();
    // 并发交错：两个调用都先 findOne（读到同一行），随后 CAS 让败者重读。
    // fake 的 findOne/update 即时 resolve，microtask 交错恰好复现该窗口。
    const [r1, r2] = await Promise.all([
      h.service.ingestClarification(h.baseInput),
      h.service.ingestClarification(h.baseInput),
    ]);
    const rounds = [r1.clarification.round, r2.clarification.round].sort(
      (x, y) => x - y,
    );
    // 轮次连续：1 和 2——没有两条同轮澄清、也没有跳轮
    expect(rounds).toEqual([1, 2]);
    expect(h.row.clarificationRound).toBe(2);
    expect(h.createdSessions).toHaveLength(2);
    const sessionRounds = h.createdSessions.map(
      (s) => (s.context as Record<string, unknown>).round,
    );
    expect(sessionRounds.sort((x, y) => (x as number) - (y as number))).toEqual(
      [1, 2],
    );
  });

  it("CAS 失败重读后命中 maxRounds → 硬闸转人工，不超发复核会话", async () => {
    const h = harness({ clarificationRound: 4, maxRounds: 5 });
    // 第一笔把轮次推到 5（4 < 5，正常起会话）
    const first = await h.service.ingestClarification(h.baseInput);
    expect(first.escalated).toBe(false);
    // 第二笔与第一笔并发读到的仍是 4（模拟交错），CAS 失败后重读得 5 →
    // 5 >= 5 触顶转人工；绝不出现第 6 条复核会话
    h.assignments.findOne.mockImplementationOnce(async () => ({
      ...h.row,
      clarificationRound: 4,
    }));
    // update CAS 正常按当前值（5）判定——4 的写入必败
    const second = await h.service.ingestClarification(h.baseInput);
    expect(second.escalated).toBe(true);
    expect(h.createdSessions).toHaveLength(1);
    expect(h.row.clarificationRound).toBe(5);
  });

  it("CAS 反复失败（有限重试耗尽）→ Conflict，不无限循环", async () => {
    const h = harness();
    // 模拟持续并发竞争：CAS 永远失败（affected 0）
    h.assignments.update.mockImplementation(async () => ({ affected: 0 }));
    await expect(h.service.ingestClarification(h.baseInput)).rejects.toThrow(
      "并发冲突",
    );
    expect(h.createdSessions).toHaveLength(0);
  });
});
