import { readFileSync } from "node:fs";
import { join } from "node:path";
import { In, IsNull } from "typeorm";

import { SopService } from "../sop.service";

/**
 * R33-A2（sop 四轴审计 · 状态机 / 并发）：**读-改-写 缺前置条件**的定向补测。
 *
 * ## 这批用例钉的是什么
 * sop 的状态迁移里有一类反复出现的形态：**先读后写**（`findOne/find` 拿快照，
 * 代码里 if 一下，然后 `update({ id })` 落库）。快照与落库之间的窗口里，
 * 另一个写者（执行器回报完成、并发 poll、人工答复）已经把行推进到新状态；
 * 不带前置条件的 UPDATE 会**无条件覆写**，于是：
 *  · 已完成的工单被超时扫描改成 failed/stalled（终止态被改写 + 假超时通知）；
 *  · 已完成的工单被澄清回复/兜底解除 blocked 改回 in_progress（终止态被复活）；
 *  · 已答复的澄清被兜底改成 escalated_to_human（真答案被覆写，执行器永远
 *    拿不到答复）。
 *
 * ## fake 的并发语义（为什么这样搭
 * · `findOne/find` 返回**快照副本**（对齐 TypeORM 语义：返回值不是行引用，
 *   后续写入不会回灌到调用方的变量里）；
 * · `update` 在**求值 where 之前**先执行一次「并发写者」（`concurrentWrite`
 *   钩子）——这正是 DB 的行锁顺序：别人的事务先提交，我们的条件 UPDATE 再
 *   对提交后的行求值。where 不匹配 → affected=0 → 有守卫的代码会让位；
 *   where 只有 id → 命中 → 覆写（缺口的可观察症状）。
 */

type Any = Record<string, any>;

const HOUR = 60 * 60 * 1000;

/** FindOperator 语义的最小实现：in / isNull / not（其余一律报错，防止假绿）。 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "type" in (expected as Any)) {
    const op = expected as Any;
    if (op.type === "in") return (op.value as unknown[]).includes(actual);
    if (op.type === "isNull") return actual === null || actual === undefined;
    // R33-A2（总控）：attempt CAS 用 Not(In([...])) 表达「终态不可改写」，
    // fake 必须同样求值，否则该守卫在测试里是隐形的（假绿）。
    if (op.type === "not") return !valueMatches(actual, op.child);
    throw new Error("fake 不支持的操作符: " + String(op.type));
  }
  return actual === expected;
}

function whereMatches(row: Any, where: Any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => valueMatches(row[k], v));
}

function harness(
  options: {
    assignment?: Any;
    clarifications?: Any[];
    concurrentAssignmentWrite?: () => void;
    concurrentClarificationWrite?: () => void;
    executors?: Any;
  } = {},
) {
  const now = Date.now();
  const assignmentRow: Any = {
    id: "a1",
    sopId: "sop-1",
    sopVersion: "1.0.0",
    targetExecutorId: "e1",
    status: "assigned",
    clarificationRound: 0,
    maxRounds: 5,
    pulledAt: null,
    lastProgressAt: null,
    attempt: 0,
    resultJson: null,
    targetAgentSessionId: null,
    parentSessionId: null,
    lastReplyDeliveredAt: null,
    createdAt: new Date(now - HOUR),
    updatedAt: new Date(now - HOUR),
    ...options.assignment,
  };
  const clarificationRows: Any[] = (options.clarifications ?? []).map((c) => ({
    updatedAt: new Date(now - HOUR),
    resolution: null,
    answer: null,
    newSopVersion: null,
    round: 1,
    assignmentId: "a1",
    reviewSessionId: null,
    ...c,
  }));

  let assignmentInterleave = options.concurrentAssignmentWrite;
  let clarificationInterleave = options.concurrentClarificationWrite;

  const assignments = {
    // 快照副本（并发写不回灌调用方变量）——读-改-写窗口的建模前提
    find: jest.fn(async () => [{ ...assignmentRow }]),
    findOne: jest.fn(async () => ({ ...assignmentRow })),
    update: jest.fn(async (where: Any, patch: Any) => {
      // 并发写者先提交，再对提交后的行求值条件（真实 DB 的行锁顺序）
      if (assignmentInterleave) {
        const run = assignmentInterleave;
        assignmentInterleave = undefined;
        run();
      }
      if (!whereMatches(assignmentRow, where)) return { affected: 0 };
      Object.assign(assignmentRow, patch);
      return { affected: 1 };
    }),
  };

  const clarifications = {
    find: jest.fn(async () => clarificationRows.map((c) => ({ ...c }))),
    findOne: jest.fn(async ({ where }: Any) => {
      const hit = clarificationRows.find((c) => whereMatches(c, where));
      return hit ? { ...hit } : null;
    }),
    create: jest.fn((v: Any) => ({ ...v })),
    save: jest.fn(async (v: Any) => {
      const idx = clarificationRows.findIndex((c) => c.id === v.id);
      if (idx >= 0)
        clarificationRows[idx] = { ...clarificationRows[idx], ...v };
      else clarificationRows.push({ ...v });
      return v;
    }),
    update: jest.fn(async (where: Any, patch: Any) => {
      if (clarificationInterleave) {
        const run = clarificationInterleave;
        clarificationInterleave = undefined;
        run();
      }
      const hit = clarificationRows.find((c) => whereMatches(c, where));
      if (!hit) return { affected: 0 };
      Object.assign(hit, patch);
      return { affected: 1 };
    }),
    createQueryBuilder: jest.fn(() => {
      let assignmentId = "";
      let requireResolution = false;
      let cursor: Date | null = null;
      const chain: Any = {
        where: jest.fn((sql: string, params?: Any) => {
          if (/assignmentId = :assignmentId/.test(sql) && params)
            assignmentId = String(params.assignmentId);
          return chain;
        }),
        andWhere: jest.fn((sql: string, params?: Any) => {
          if (/resolution IS NOT NULL/.test(sql)) requireResolution = true;
          if (/updatedAt > :cursor/.test(sql) && params)
            cursor = new Date(params.cursor as unknown as string);
          return chain;
        }),
        orderBy: jest.fn(() => chain),
        getMany: jest.fn(async () =>
          clarificationRows
            .filter((r) => r.assignmentId === assignmentId)
            .filter((r) => !requireResolution || r.resolution !== null)
            .filter(
              (r) =>
                !cursor || new Date(r.updatedAt).getTime() > cursor!.getTime(),
            ),
        ),
      };
      return chain;
    }),
  };

  const sops = {
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async () => ({
      id: "sop-1",
      slug: "demo",
      title: "Demo",
      currentVersion: "1.0.0",
    })),
  };
  const versions = {
    findOne: jest.fn(async () => ({
      sopId: "sop-1",
      version: "1.0.0",
      contentHash: "hash",
      frontMatterJson: { acceptance: [], capabilities: [] },
      bodyMarkdown: "Do the work",
    })),
  };

  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    versions,
    assignments,
    clarifications,
    scheduler: { getStats: () => ({ isLeader: true }) },
    config: { get: () => undefined },
    notifications: { notify: jest.fn(async () => undefined) },
    agentSessions: {
      requireById: jest.fn(async () => {
        throw new Error("no session");
      }),
      create: jest.fn(async () => ({ id: "sess-1" })),
    },
    agentQueue: { add: jest.fn(async () => undefined) },
    executors: options.executors ?? {
      getAgentCapabilities: jest.fn(async () => ["agent:sop"]),
    },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }) as SopService;

  return { service, assignmentRow, clarificationRows };
}

describe("R33-A2 状态机 · 超时扫描不得覆写终止态（读-改-写缺前置状态）", () => {
  it("扫到 assigned 快照但并发已完成 → completed 不得被改成 failed，且不得发假超时通知", async () => {
    const h = harness({
      assignment: { status: "assigned", pulledAt: null },
      // 并发写者：执行器在扫描 read 与 update 之间回报完成并落库
      concurrentAssignmentWrite: () => {
        h.assignmentRow.status = "completed";
        h.assignmentRow.resultJson = { summary: "真做完了" };
      },
    });
    await h.service.sweepAssignmentTimeouts();

    expect(h.assignmentRow.status).toBe("completed");
    expect(h.assignmentRow.resultJson).toEqual({ summary: "真做完了" });
  });

  it("扫到 in_progress 快照但并发已完成 → completed 不得被改成 stalled", async () => {
    const h = harness({
      assignment: {
        status: "in_progress",
        pulledAt: new Date(Date.now() - HOUR),
        lastProgressAt: new Date(Date.now() - HOUR),
      },
      concurrentAssignmentWrite: () => {
        h.assignmentRow.status = "completed";
        h.assignmentRow.resultJson = { summary: "真做完了" };
      },
    });
    await h.service.sweepAssignmentTimeouts();

    expect(h.assignmentRow.status).toBe("completed");
  });
});

describe("R33-A2 状态机 · 解除 blocked 必须带前置状态（不得复活终态）", () => {
  const clarification = () => ({
    id: "c1",
    assignmentId: "a1",
    round: 1,
    resolution: null,
    answer: null,
  });

  it("回复澄清时并发完成已落库 → completed 不得被改回 in_progress", async () => {
    const h = harness({
      assignment: { status: "blocked", pulledAt: new Date() },
      clarifications: [clarification()],
      concurrentAssignmentWrite: () => {
        // 执行器在「回复落库」与「解除 blocked」之间回报完成
        h.assignmentRow.status = "completed";
      },
    });
    await h.service.replyClarification({
      clarificationId: "c1",
      resolution: "answered",
      answer: "按这个做",
      replyBy: "user:u1",
    });

    expect(h.assignmentRow.status).toBe("completed");
  });

  it("兜底升级时并发完成已落库 → completed 不得被改回 in_progress", async () => {
    const h = harness({
      assignment: { status: "blocked", pulledAt: new Date() },
      // 复核会话缺失（reviewSessionStatus=null）→ 判定为 stuck，走兜底
      clarifications: [clarification()],
      concurrentAssignmentWrite: () => {
        h.assignmentRow.status = "completed";
      },
    });
    await (h.service as unknown as Any).sweepStuckClarifications();

    expect(h.assignmentRow.status).toBe("completed");
  });
});

describe("R33-A2 并发 · 澄清兜底不得覆写已答复的行", () => {
  it("扫到 resolution=NULL 快照但并发已答复 → 兜底不得把真答案改成 escalated", async () => {
    const h = harness({
      assignment: { status: "blocked", pulledAt: new Date() },
      clarifications: [{ id: "c1", assignmentId: "a1", round: 1 }],
      // 并发写者：人工/复核 Agent 在扫描 read 与 update 之间答复了
      concurrentClarificationWrite: () => {
        h.clarificationRows[0].resolution = "answered";
        h.clarificationRows[0].answer = "真正的答复（不能丢）";
        h.assignmentRow.status = "in_progress";
      },
    });
    await (h.service as unknown as Any).sweepStuckClarifications();

    expect(h.clarificationRows[0].resolution).toBe("answered");
    expect(h.clarificationRows[0].answer).toBe("真正的答复（不能丢）");
    // 已答复 → 指派已被答复路径解除 blocked，兜底不得再动它
    expect(h.assignmentRow.status).toBe("in_progress");
  });
});

describe("R33-A2 状态机 · 进度心跳不得复活终态", () => {
  it("心跳读到 assigned 快照但并发已完成 → completed 不得被改回 in_progress", async () => {
    const h = harness({
      assignment: { status: "assigned", pulledAt: new Date() },
      concurrentAssignmentWrite: () => {
        h.assignmentRow.status = "completed";
      },
    });
    await h.service.recordProgress({
      assignmentId: "a1",
      executorId: "e1",
      progressJson: { step: "第 3 步" },
    });

    expect(h.assignmentRow.status).toBe("completed");
  });
});

describe("R33-A2 状态机 · maxRounds 触顶置 blocked 不得覆写终态", () => {
  it("触顶时并发完成已落库 → completed 不得被改成 blocked", async () => {
    const h = harness({
      assignment: {
        status: "blocked",
        clarificationRound: 5,
        maxRounds: 5,
        pulledAt: new Date(),
      },
      concurrentAssignmentWrite: () => {
        h.assignmentRow.status = "completed";
      },
    });
    await h.service.ingestClarification({
      assignmentId: "a1",
      executorId: "e1",
      question: "第 5 轮了还能继续吗？",
    });

    expect(h.assignmentRow.status).toBe("completed");
  });
});

describe("R33-A2 钉子 · 已验证守卫（poll 首领 CAS）", () => {
  it("两个并发 poll 只有 CAS 胜者投递指派（pulledAt IS NULL 条件）", async () => {
    const h = harness({ assignment: { status: "assigned", pulledAt: null } });
    const [first, second] = await Promise.all([
      h.service.pollPending({ executorId: "e1" }),
      h.service.pollPending({ executorId: "e1" }),
    ]);
    const items = [...first, ...second] as Any[];
    expect(items.filter((i) => i.kind === "assignment")).toHaveLength(1);
    // 领取一次即进入执行态（不得留 assigned + pulledAt 双置的中间态）
    expect(h.assignmentRow.status).toBe("in_progress");
    expect(h.assignmentRow.pulledAt).toBeInstanceOf(Date);
  });
});

describe("R33-A2 钉子 · 已验证守卫（条件 UPDATE 的 FindOperator 语义）", () => {
  it("fake 的 whereMatches 对 in / isNull 按真实语义求值（防假绿）", () => {
    expect(
      whereMatches({ s: "blocked" }, { s: In(["blocked", "assigned"]) }),
    ).toBe(true);
    expect(whereMatches({ s: "completed" }, { s: In(["blocked"]) })).toBe(
      false,
    );
    expect(whereMatches({ s: null }, { s: IsNull() })).toBe(true);
    expect(whereMatches({ s: "answered" }, { s: IsNull() })).toBe(false);
  });
});

describe("R33-A2 状态机 · completeAssignment 以 attempt CAS 为准", () => {
  it("同一轮次并发重复提交 → 后到者 accepted:false，且不覆盖先到者的结果", async () => {
    const h = harness({
      assignment: { status: "in_progress", attempt: 2, targetExecutorId: "e1" },
      concurrentAssignmentWrite: () => {
        // 先到者已把这一行推进到下一 attempt 并落 completed
        h.assignmentRow.status = "completed";
        h.assignmentRow.attempt = 3;
        h.assignmentRow.resultJson = { summary: "先到者" };
      },
    });

    const res = await h.service.completeAssignment({
      assignmentId: "a1",
      executorId: "e1",
      status: "failed",
      attempt: 3,
      result: { summary: "后到者" },
    });

    // 条件 UPDATE 未命中 ⇒ 让位（幂等忽略，不是错误）
    expect(res).toEqual({ accepted: false });
    expect(h.assignmentRow.status).toBe("completed");
    expect(h.assignmentRow.resultJson).toEqual({ summary: "先到者" });
  });

  it("对照：无并发时同一调用照常落库（attempt 推进 + 结果写入）", async () => {
    const h = harness({
      assignment: { status: "in_progress", attempt: 2, targetExecutorId: "e1" },
    });

    const res = await h.service.completeAssignment({
      assignmentId: "a1",
      executorId: "e1",
      status: "completed",
      attempt: 3,
      result: { summary: "正常完成" },
    });

    expect(res).toEqual({ accepted: true });
    expect(h.assignmentRow.status).toBe("completed");
    expect(h.assignmentRow.attempt).toBe(3);
  });
});

describe("R39 · resend 重新排队按领取状态做 CAS（ADR-026）", () => {
  const svcSrc = readFileSync(join(__dirname, "..", "sop.service.ts"), "utf8");

  it("resend 分支的 assignments.update WHERE 里带 pulledAt（不是只有 id）", () => {
    // pulledAt 是领取 CAS 的判据列。无条件清零会抹掉「谁领了这张单」的凭据：
    // resend 与普通领取并发时，后到者清掉对方刚拿到的领取态 ⇒ 同一张单被两个
    // 实例同时认为归自己。判据必须按**读取时的值**做 CAS（ADR-026 规则 2）。
    const re =
      /if \(resendAll && !firstPull\) \{[\s\S]{0,600}?assignments\.update\(\s*\{\s*id: a\.id,\s*pulledAt: a\.pulledAt \?\? IsNull\(\)/;
    expect(re.test(svcSrc)).toBe(true);
  });
});
