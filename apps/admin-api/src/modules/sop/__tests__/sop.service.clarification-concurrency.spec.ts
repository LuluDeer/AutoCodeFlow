import { In, Raw } from "typeorm";

import { SopService } from "../sop.service";

/**
 * R34-A1（sop 审计 · 轴 3 并发 / 澄清面）：**同一工单被两个复核会话同时处理**。
 *
 * ## 轴 1 与轴 3 的边界
 * 轴 1（commit d8f93647）收的是**指派状态机**的六个迁移点；这里只看**澄清行
 * 自身的写**。澄清行有两条写路径，都在「读快照 → 落库」之间开着窗口：
 *
 * ① `replyClarification`（复核 Agent / 人工答复）：先 `save(row)` 整行回写。
 *    两个会话同时答复同一行时，两个都通过幂等闸（读到 resolution 尚未落定），
 *    于是 **sop_amended 会发两个 patch 版本**，后到者的 answer 覆盖先到者的
 *    （先到的答复蒸发，执行器只能拿到后到者的）。
 * ② `ackClarificationReply`（执行器 ACK）：游标写入是「读快照 if 一下再
 *    `update({ id })`」——乱序 ACK 会让 `lastReplyDeliveredAt` **回退**，
 *    已消费的回复重新变成待投递（注释声称「只前进不后退」，代码没有那条谓词）。
 *
 * ## fake 的并发语义（与 sop.service.state-cas.spec.ts 同源）
 * findOne/find 返回**快照副本**；写入路径在求值 where **之前**执行一次
 * `concurrentWrite` 钩子（模拟「别人的事务先提交，我们的条件 UPDATE 再对提交
 * 后的行求值」）。钩子同时挂在 save 与 update 上：修复前写路径是 save、修复后
 * 是 update，同一用例在两侧都必须成立（否则反证不成立）。
 */

type Any = Record<string, any>;

const HOUR = 60 * 60 * 1000;

/** FindOperator 语义的最小实现：in / isNull / not / raw（其余一律报错，防假绿）。 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "type" in (expected as Any)) {
    const op = expected as Any;
    if (op.type === "in") return (op.value as unknown[]).includes(actual);
    if (op.type === "isNull") return actual === null || actual === undefined;
    if (op.type === "not") return !valueMatches(actual, op.child);
    // ACK 游标的条件写用 Or(IsNull(), LessThan(stamp)) 表达「本次推进的合法
    // 起始状态」——fake 必须按真实语义求值，否则该守卫在测试里是隐形的。
    if (op.type === "or")
      return (op.value as unknown[]).some((v) => valueMatches(actual, v));
    if (op.type === "and")
      return (op.value as unknown[]).every((v) => valueMatches(actual, v));
    if (op.type === "lessThan") {
      if (actual === null || actual === undefined) return false;
      return (
        new Date(actual as string).getTime() <
        new Date(op.value as string).getTime()
      );
    }
    if (op.type === "raw") {
      // Raw 谓词：只能在 fake 里按值手工求值，见 rawCursorAllows 的用例侧断言。
      throw new Error("fake 的 raw 谓词必须走 update 专用求值");
    }
    throw new Error("fake 不支持的操作符: " + String(op.type));
  }
  return actual === expected;
}

function whereMatches(row: Any, where: Any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === "object" && (v as Any).type === "raw") {
      // R34-A1：ACK 游标用 Raw 表达「(IS NULL OR < :stamp)」——fake 按同一语义求值。
      const stamp = new Date((v as Any).parameters?.stamp ?? 0).getTime();
      const cur = row[k] ? new Date(row[k]).getTime() : null;
      return cur === null || cur < stamp;
    }
    return valueMatches(row[k], v);
  });
}

const AMENDED_YAML = "acceptance:\n  - kind: command\n    run: echo amended\n";

function harness(
  options: {
    assignment?: Any;
    clarifications?: Any[];
    /** 在任意一次澄清行写入之前执行的并发写者（只执行一次）。 */
    concurrentClarificationWrite?: () => void;
    /** 在任意一次指派行写入（条件写求值）之前执行的并发写者（只执行一次）。 */
    concurrentAssignmentWrite?: () => void;
    sop?: Any;
  } = {},
) {
  const now = Date.now();
  const assignmentRow: Any = {
    id: "a1",
    sopId: "sop-1",
    sopVersion: "1.0.0",
    targetExecutorId: "e1",
    status: "blocked",
    clarificationRound: 1,
    maxRounds: 5,
    pulledAt: new Date(now - HOUR),
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
    clientClarificationId: null,
    reviewSessionId: null,
    ...c,
  }));

  let interleave = options.concurrentClarificationWrite;
  const runInterleave = () => {
    if (!interleave) return;
    const run = interleave;
    interleave = undefined;
    run();
  };

  let assignmentInterleave = options.concurrentAssignmentWrite;
  const runAssignmentInterleave = () => {
    if (!assignmentInterleave) return;
    const run = assignmentInterleave;
    assignmentInterleave = undefined;
    run();
  };

  const assignments = {
    find: jest.fn(async () => [{ ...assignmentRow }]),
    findOne: jest.fn(async () => ({ ...assignmentRow })),
    update: jest.fn(async (where: Any, patch: Any) => {
      runAssignmentInterleave();
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
    // 模拟 repo.save 的整行回写：调用方手里的陈旧快照会盖掉别人刚写的列
    save: jest.fn(async (v: Any) => {
      runInterleave();
      const idx = clarificationRows.findIndex((c) => c.id === v.id);
      if (idx >= 0) clarificationRows[idx] = { ...clarificationRows[idx], ...v };
      else clarificationRows.push({ ...v });
      return v;
    }),
    update: jest.fn(async (where: Any, patch: Any) => {
      runInterleave();
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

  /** sop 主表：save 落库、findOne 返回快照（publish 的二次读取才能看见前一次写）。 */
  const sopStore: Any = {
    id: "sop-1",
    slug: "demo",
    title: "Demo",
    status: "published",
    currentVersion: "1.0.0",
    frontMatterJson: { acceptance: [{ kind: "command", run: "echo old" }] },
    bodyMarkdown: "Old body",
    createdBy: "user:owner-1",
    ...options.sop,
  };
  const sops = {
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async () => ({ ...sopStore })),
    save: jest.fn(async (v: Any) => {
      Object.assign(sopStore, v);
      return v;
    }),
  };
  const versionRows: Any[] = [
    { sopId: "sop-1", version: "1.0.0", contentHash: "old-hash" },
  ];
  const versions = {
    findOne: jest.fn(async ({ where }: Any) => {
      const hit = versionRows.find(
        (v) => v.sopId === where.sopId && v.version === where.version,
      );
      return hit ? { ...hit } : null;
    }),
    create: jest.fn((v: Any) => ({ ...v })),
    save: jest.fn(async (v: Any) => {
      const row = { ...v, id: "v-" + (versionRows.length + 1) };
      versionRows.push(row);
      return row;
    }),
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
    executors: { getAgentCapabilities: jest.fn(async () => ["agent:sop"]) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }) as SopService;

  return {
    service,
    assignmentRow,
    clarificationRows,
    sops,
    versions,
    versionRows,
    clarifications,
  };
}

describe("R34-A1 轴3 · 两个复核会话同时答复同一澄清", () => {
  it("后到者不得覆盖先到者的答复（answer / resolution 归先到者）", async () => {
    const h = harness({
      clarifications: [
        { id: "c1", assignmentId: "a1", round: 1, resolution: "escalated_to_human" },
      ],
      concurrentClarificationWrite: () => {
        // 另一个人工/复核会话在我们读取快照之后先提交了答复
        h.clarificationRows[0].resolution = "answered";
        h.clarificationRows[0].answer = "先到者的答复";
      },
    });

    await h.service.replyClarification({
      clarificationId: "c1",
      resolution: "answered",
      answer: "后到者的答复",
      replyBy: "user:u2",
    });

    expect(h.clarificationRows[0].answer).toBe("先到者的答复");
    expect(h.clarificationRows[0].resolution).toBe("answered");
  });

  it("并发 sop_amended → 后到者不得再发一个版本（同一澄清只修订一次）", async () => {
    const h = harness({
      clarifications: [
        { id: "c1", assignmentId: "a1", round: 1, resolution: null },
      ],
      concurrentClarificationWrite: () => {
        // 另一个复核会话已经把这一轮答复成 sop_amended 并发出版本 1.0.1
        h.clarificationRows[0].resolution = "sop_amended";
        h.clarificationRows[0].answer = "先到者已修订";
        h.clarificationRows[0].newSopVersion = "1.0.1";
      },
    });

    await h.service.replyClarification({
      clarificationId: "c1",
      resolution: "sop_amended",
      answer: "后到者的修订",
      amendedFrontMatterYaml: AMENDED_YAML,
      amendedBodyMarkdown: "Amended body",
      replyBy: "user:u2",
    });

    // 后到者既不再发版，也不覆盖先到者的版本锚与答案
    expect(h.versions.save).not.toHaveBeenCalled();
    expect(h.clarificationRows[0].newSopVersion).toBe("1.0.1");
    expect(h.clarificationRows[0].answer).toBe("先到者已修订");
  });

  it("对照：无并发时答复照常落库（answer + resolution + 解除 blocked）", async () => {
    const h = harness({
      clarifications: [{ id: "c1", assignmentId: "a1", round: 1 }],
    });

    const out = await h.service.replyClarification({
      clarificationId: "c1",
      resolution: "answered",
      answer: "按这个做",
      replyBy: "user:u1",
    });

    expect(out).toEqual({ ok: true, newSopVersion: undefined });
    expect(h.clarificationRows[0].answer).toBe("按这个做");
    expect(h.clarificationRows[0].resolution).toBe("answered");
    expect(h.assignmentRow.status).toBe("in_progress");
  });

  it("对照：sop_amended 无并发 → 发一个 patch 版本，且澄清行记住版本锚", async () => {
    const h = harness({
      clarifications: [{ id: "c1", assignmentId: "a1", round: 1 }],
    });

    const out = await h.service.replyClarification({
      clarificationId: "c1",
      resolution: "sop_amended",
      answer: "补全了 acceptance",
      amendedFrontMatterYaml: AMENDED_YAML,
      amendedBodyMarkdown: "Amended body",
      replyBy: "user:u1",
    });

    expect(h.versionRows.filter((v) => v.version === "1.0.1")).toHaveLength(1);
    expect(out.newSopVersion).toBe("1.0.1");
    expect(h.clarificationRows[0].newSopVersion).toBe("1.0.1");
    expect(h.clarificationRows[0].resolution).toBe("sop_amended");
  });
});

describe("R34-A1 轴3 · 澄清回复的投递游标（ACK 必须单调前进）", () => {
  it("乱序 ACK 不得让游标回退（已消费的回复不得重新变成待投递）", async () => {
    const older = new Date(Date.now() - 2 * HOUR);
    const newer = new Date(Date.now() - HOUR);
    const h = harness({
      // 读到的快照还没有游标——另一个 ACK（更新的那一轮）在我们落库前先提交了
      assignment: { lastReplyDeliveredAt: null },
      concurrentAssignmentWrite: () => {
        h.assignmentRow.lastReplyDeliveredAt = newer;
      },
      clarifications: [
        {
          id: "c-old",
          assignmentId: "a1",
          round: 1,
          resolution: "answered",
          answer: "旧的一轮",
          updatedAt: older,
        },
      ],
    });

    await h.service.ackClarificationReply({
      assignmentId: "a1",
      executorId: "e1",
      clarificationId: "c-old",
    });

    // 游标已推进到 newer：更旧的 ACK 必须被条件谓词拒掉，不能回退
    expect(new Date(h.assignmentRow.lastReplyDeliveredAt).getTime()).toBe(
      newer.getTime(),
    );
  });

  it("对照：游标缺省时 ACK 照常推进", async () => {
    const stamp = new Date(Date.now() - HOUR);
    const h = harness({
      clarifications: [
        {
          id: "c1",
          assignmentId: "a1",
          round: 1,
          resolution: "answered",
          answer: "答复",
          updatedAt: stamp,
        },
      ],
    });

    await h.service.ackClarificationReply({
      assignmentId: "a1",
      executorId: "e1",
      clarificationId: "c1",
    });

    expect(new Date(h.assignmentRow.lastReplyDeliveredAt).getTime()).toBe(
      stamp.getTime(),
    );
  });
});

describe("R34-A1 轴3 · 半成品 sop_amended 不得投递给执行器", () => {
  it("resolution=sop_amended 但 newSopVersion 尚未落库 → poll 不投递", async () => {
    const h = harness({
      clarifications: [
        {
          id: "c1",
          assignmentId: "a1",
          round: 1,
          resolution: "sop_amended",
          answer: "正在修订",
          newSopVersion: null,
          updatedAt: new Date(),
        },
      ],
    });

    const items = (await h.service.pollPending({ executorId: "e1" })) as Any[];
    expect(items.filter((i) => i.kind === "clarification_reply")).toHaveLength(0);
  });
});
