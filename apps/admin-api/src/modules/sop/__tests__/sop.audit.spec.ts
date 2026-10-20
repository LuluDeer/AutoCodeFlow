/**
 * R41-A1（R34-A1 遗留②）：SOP 关键动作的**审计落库**。
 *
 * ## 为什么这档值得存在
 * 审计行是本仓**唯一可事后追溯的操作记录**（应用日志会轮转），前几轮的根因
 * 判断多次直接读审计行（哪把 API Key、谁改的通知配置、谁删的执行器）。SOP
 * 是产品核心流程（发布 → 指派 → 澄清 → 完成），此前**一条审计都不落**——
 * 出事时只能翻日志。这档把「每个写动作各落一条、且只落一条」钉成断言。
 *
 * ## 三条断言口径
 * ① **每个动作一条**：action / resource / resourceId / userId / ip 全断言，
 *    且**没有写动作的路径（幂等重放 / 并发让位）一条都不许落**——否则
 *    「发起过几次澄清」会被轮询/重试放大，审计面失去计量意义。
 * ② **detail 不含正文**：question / answer / result / changelog 是执行器与
 *    Agent 的不可信输出，只记长度。审计行长期保留且可 CSV 导出，正文落进去
 *    等于给不可信文本开一条持久外带通道。
 * ③ **审计失败不阻断业务，但必须 error 留痕**：静默吞掉等于审计形同虚设
 *    （既没有行、也没有日志能说明「审计坏了」）。
 */
import { SopService } from "../sop.service";
import { SopController } from "../sop.controller";
import { SopCollabController } from "../sop-collab.controller";

type Any = Record<string, any>;

/** FindOperator 语义（in / isNull / not）：条件 UPDATE 的 where 必须真实求值。 */
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && "type" in (expected as Any)) {
    const op = expected as Any;
    if (op.type === "in") return (op.value as unknown[]).includes(actual);
    if (op.type === "isNull") return actual === null || actual === undefined;
    if (op.type === "not") return !valueMatches(actual, op.child);
    throw new Error("fake 不支持的操作符: " + String(op.type));
  }
  return actual === expected;
}

function whereMatches(row: Any, where: Any): boolean {
  return Object.entries(where ?? {}).every(([k, v]) => valueMatches(row[k], v));
}

const SOP_ROW: Any = {
  id: "sop-1",
  slug: "daily-report",
  title: "日报",
  currentVersion: null,
  status: "draft",
  frontMatterJson: { acceptance: [{ kind: "command", run: "echo ok" }] },
  bodyMarkdown: "正文",
  createdBy: "user:7",
};

const VERSION_ROW: Any = {
  id: "ver-1",
  sopId: "sop-1",
  version: "1.0.0",
  contentHash: "abcdef0123456789abcdef",
  frontMatterJson: { acceptance: [{ kind: "command", run: "echo ok" }] },
  bodyMarkdown: "正文",
};

const ASSIGNMENT_ROW: Any = {
  id: "as-1",
  sopId: "sop-1",
  sopVersion: "1.0.0",
  targetExecutorId: "exec-1",
  status: "in_progress",
  clarificationRound: 0,
  maxRounds: 3,
  attempt: 0,
  pulledAt: null,
  lastProgressAt: null,
  resultJson: null,
  targetAgentSessionId: null,
  parentSessionId: null,
  lastReplyDeliveredAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/**
 * 服务 harness。
 *
 * auditService 语义（与 @Optional 装配一致）：
 *  · 缺省 → 一个可断言的 spy（生产装配形态）；
 *  · null → **完全缺席**（存量测试模块 / 未 imports AuditModule）。
 */
function harness(
  opts: {
    auditService?: { log: jest.Mock } | null;
    sop?: Any;
    version?: Any | null;
    assignment?: Any;
    clarification?: Any | null;
  } = {},
) {
  const sopRow: Any = { ...SOP_ROW, ...(opts.sop ?? {}) };
  const versionRow: Any = opts.version === undefined ? null : opts.version;
  const assignmentRow: Any = { ...ASSIGNMENT_ROW, ...(opts.assignment ?? {}) };
  const clarificationRow: Any =
    opts.clarification === undefined || opts.clarification === null
      ? null
      : { ...opts.clarification };

  const sops = {
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async ({ where }: Any) =>
      where.id === sopRow.id || where.slug === sopRow.slug
        ? { ...sopRow }
        : null,
    ),
    create: jest.fn((v: Any) => ({ id: "sop-new", ...v })),
    save: jest.fn(async (v: Any) => v),
  };
  const versions = {
    findOne: jest.fn(async () => (versionRow ? { ...versionRow } : null)),
    create: jest.fn((v: Any) => ({ id: "ver-new", ...v })),
    save: jest.fn(async (v: Any) => v),
  };
  const assignments = {
    findOne: jest.fn(async () => ({ ...assignmentRow })),
    create: jest.fn((v: Any) => ({ id: "as-new", ...v })),
    save: jest.fn(async (v: Any) => v),
    update: jest.fn(async (where: Any, patch: Any) => {
      if (!whereMatches(assignmentRow, where)) return { affected: 0 };
      Object.assign(assignmentRow, patch);
      return { affected: 1 };
    }),
  };
  const clarifications = {
    findOne: jest.fn(async () =>
      clarificationRow ? { ...clarificationRow } : null,
    ),
    find: jest.fn(async () =>
      clarificationRow ? [{ ...clarificationRow }] : [],
    ),
    create: jest.fn((v: Any) => ({ id: "cl-new", ...v })),
    save: jest.fn(async (v: Any) => v),
    update: jest.fn(async (where: Any, patch: Any) => {
      if (!clarificationRow || !whereMatches(clarificationRow, where))
        return { affected: 0 };
      Object.assign(clarificationRow, patch);
      return { affected: 1 };
    }),
  };

  const auditService =
    opts.auditService === undefined
      ? { log: jest.fn(async (_p: Any) => undefined) }
      : opts.auditService;
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = Object.assign(Object.create(SopService.prototype), {
    sops,
    versions,
    assignments,
    clarifications,
    executors: { getAgentCapabilities: jest.fn(async () => ["agent:sop"]) },
    notifications: { notify: jest.fn(async () => undefined) },
    agentSessions: { create: jest.fn(async () => ({ id: "sess-1" })) },
    agentQueue: { add: jest.fn(async () => undefined) },
    scheduler: { getStats: () => ({ isLeader: true }) },
    config: { get: () => undefined },
    auditService,
    logger,
  }) as Any;

  return {
    service: service as SopService,
    auditService,
    logger,
    sops,
    versions,
    assignments,
    clarifications,
    sopRow,
    versionRow,
    assignmentRow,
    clarificationRow,
  };
}

/** 断言「恰好一条审计」，返回那一条载荷。 */
const onlyOne = (auditService: { log: jest.Mock }): Any => {
  expect(auditService.log).toHaveBeenCalledTimes(1);
  return auditService.log.mock.calls[0][0];
};

const AUDIT = { userId: 7, ip: "10.0.0.9" };

describe("R41-A1 · 每个写动作各落一条审计（action / resource / resourceId / 主体）", () => {
  it("sop.draft · 起草（resource=sop，主体=userId+ip）", async () => {
    const h = harness();
    await h.service.draft({
      slug: "demo",
      title: "T",
      bodyMarkdown: "正文",
      createdBy: "user:7",
      audit: AUDIT,
    });
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.draft",
      resource: "sop",
      resourceId: "sop-new",
      userId: 7,
      ip: "10.0.0.9",
    });
    expect(row.detail).toMatchObject({ slug: "demo", actor: "user:7" });
  });

  it("sop.update · 编辑工作副本（只记改了哪些字段，不记字段内容）", async () => {
    const h = harness();
    await h.service.draft({
      slug: "daily-report",
      title: "日报",
      bodyMarkdown: "新正文",
      createdBy: "user:7",
      audit: AUDIT,
    });
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.update",
      resource: "sop",
      resourceId: "sop-1",
      userId: 7,
    });
    expect(row.detail.fields).toEqual(["bodyMarkdown"]);
    // 编辑路径上 createdBy 是**属主**不是操作者——把它当 actor 会指错人
    expect(row.detail.actor).toBeUndefined();
  });

  it("sop.publish · 发布（版本号 / hash / 发布者）", async () => {
    const h = harness();
    const r = await h.service.publish({
      sopId: "sop-1",
      bump: "patch",
      changelog: "补验收",
      publishedBy: "user:7",
      audit: AUDIT,
    });
    expect(r.version.version).toBe("1.0.0");
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.publish",
      resource: "sop",
      resourceId: "sop-1",
      userId: 7,
      ip: "10.0.0.9",
    });
    expect(row.detail).toMatchObject({
      slug: "daily-report",
      version: "1.0.0",
      bump: "patch",
      versionId: "ver-new",
      changelogLength: 3,
      actor: "user:7",
    });
    // hash 只留前 12 位（对账够用，不给审计行存全量指纹）
    expect(row.detail.contentHash).toHaveLength(12);
  });

  it("sop.assign · 指派/重派（resource=sop_assignment，答得出派给了哪台机器）", async () => {
    const h = harness({
      sop: { currentVersion: "1.0.0" },
      version: VERSION_ROW,
    });
    const saved = await h.service.assign({
      sopId: "sop-1",
      executorId: "exec-9",
      assignedBy: "user:7",
      audit: AUDIT,
    });
    expect(saved.id).toBe("as-new");
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.assign",
      resource: "sop_assignment",
      resourceId: "as-new",
      userId: 7,
    });
    expect(row.detail).toMatchObject({
      sopId: "sop-1",
      slug: "daily-report",
      version: "1.0.0",
      executorId: "exec-9",
      actor: "user:7",
    });
  });

  it("sop.clarify · 执行器发起澄清（无 userId，主体=executor:<id>）", async () => {
    const h = harness();
    const r = await h.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: "这台机器的默认端口是多少",
      audit: { ip: "1.1.1.1" },
    });
    expect(r.escalated).toBe(false);
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.clarify",
      resource: "sop_clarification",
      resourceId: "cl-new",
      userId: null,
      ip: "1.1.1.1",
    });
    expect(row.detail).toMatchObject({
      // R70-A1：resourceId 是澄清行 id，审计页深链要的是 SOP id
      sopId: "sop-1",
      assignmentId: "as-1",
      round: 1,
      escalated: false,
      questionLength: "这台机器的默认端口是多少".length,
      mediaRefs: 0,
      actor: "executor:exec-1",
    });
  });

  it("sop.clarify · maxRounds 触顶升级同样落一条（escalated=true）", async () => {
    const h = harness({
      assignment: { clarificationRound: 3, maxRounds: 3 },
    });
    const r = await h.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: "还能再问吗",
      audit: { ip: "1.1.1.1" },
    });
    expect(r.escalated).toBe(true);
    const row = onlyOne(h.auditService);
    expect(row.action).toBe("sop.clarify");
    expect(row.detail).toMatchObject({
      escalated: true,
      round: 4,
      sopId: "sop-1", // R70-A1：触顶升级路径同样可深链
    });
  });

  it("sop.reply · 答复澄清（resolution + 版本锚，主体=replyBy）", async () => {
    const h = harness({
      clarification: {
        id: "cl-1",
        assignmentId: "as-1",
        round: 2,
        resolution: null,
        answer: null,
        newSopVersion: null,
      },
      assignment: { status: "blocked" },
    });
    await h.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: "端口是 8002",
      replyBy: "user:7",
      audit: AUDIT,
    });
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.reply",
      resource: "sop_clarification",
      resourceId: "cl-1",
      userId: 7,
      ip: "10.0.0.9",
    });
    expect(row.detail).toMatchObject({
      sopId: "sop-1",
      assignmentId: "as-1",
      round: 2,
      resolution: "answered",
      answerLength: "端口是 8002".length,
      newSopVersion: null,
      actor: "user:7",
    });
  });

  it("sop_amended 答复：修订发版落两条（sop.publish 版本归属 + sop.reply 答复）", async () => {
    const h = harness({
      clarification: {
        id: "cl-1",
        assignmentId: "as-1",
        round: 2,
        resolution: null,
        answer: null,
        newSopVersion: null,
      },
      assignment: { status: "blocked" },
    });
    const r = await h.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "sop_amended",
      answer: "按修订版执行",
      amendedBodyMarkdown: "新正文",
      replyBy: "user:7",
      audit: AUDIT,
    });
    expect(r.newSopVersion).toBe("1.0.0");
    expect(h.auditService.log).toHaveBeenCalledTimes(2);
    const actions = h.auditService.log.mock.calls.map((c: Any[]) => c[0].action);
    expect(actions).toEqual(["sop.publish", "sop.reply"]);
    // 版本行也带上了本次答复的主体（「这个版本是谁发的」不只靠 actor 字符串）
    expect(h.auditService.log.mock.calls[0][0]).toMatchObject({
      action: "sop.publish",
      resourceId: "sop-1",
      userId: 7,
      ip: "10.0.0.9",
    });
  });

  it("sop.complete · 交付回报（status / attempt，主体=executor:<id>）", async () => {
    const h = harness();
    const r = await h.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "failed",
      result: { note: "x" },
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    expect(r.accepted).toBe(true);
    const row = onlyOne(h.auditService);
    expect(row).toMatchObject({
      action: "sop.complete",
      resource: "sop_assignment",
      resourceId: "as-1",
      userId: null,
      ip: "1.1.1.1",
    });
    expect(row.detail).toMatchObject({
      sopId: "sop-1",
      status: "failed",
      attempt: 1,
      actor: "executor:exec-1",
    });
    expect(row.detail.resultLength).toBe(JSON.stringify({ note: "x" }).length);
  });
});

describe("R41-A1 · detail 不含正文（只记长度 / id）", () => {
  it("澄清问题 / 答复 / 交付结果 / changelog 的正文都不进审计行", async () => {
    const QUESTION = "QUESTION-BODY-MUST-NOT-BE-AUDITED";
    const ANSWER = "ANSWER-BODY-MUST-NOT-BE-AUDITED";
    const RESULT = "RESULT-BODY-MUST-NOT-BE-AUDITED";
    const CHANGELOG = "CHANGELOG-BODY-MUST-NOT-BE-AUDITED";
    const payloads: Any[] = [];

    const h1 = harness();
    await h1.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: QUESTION,
      context: { note: QUESTION },
      audit: { ip: "1.1.1.1" },
    });
    payloads.push(h1.auditService.log.mock.calls[0][0]);

    const h2 = harness({
      clarification: {
        id: "cl-1",
        assignmentId: "as-1",
        round: 1,
        resolution: null,
        answer: null,
        newSopVersion: null,
      },
      assignment: { status: "blocked" },
    });
    await h2.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: ANSWER,
      replyBy: "user:7",
      audit: AUDIT,
    });
    payloads.push(h2.auditService.log.mock.calls[0][0]);

    const h3 = harness();
    await h3.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "failed",
      result: { note: RESULT },
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    payloads.push(h3.auditService.log.mock.calls[0][0]);

    const h4 = harness();
    await h4.service.publish({
      sopId: "sop-1",
      changelog: CHANGELOG,
      publishedBy: "user:7",
      audit: AUDIT,
    });
    payloads.push(h4.auditService.log.mock.calls[0][0]);

    const serialized = JSON.stringify(payloads);
    for (const secret of [QUESTION, ANSWER, RESULT, CHANGELOG]) {
      expect(serialized).not.toContain(secret);
    }
    // 长度仍然在——「记长度不记正文」的承诺可被独立验证
    expect(payloads[0].detail.questionLength).toBe(QUESTION.length);
    expect(payloads[1].detail.answerLength).toBe(ANSWER.length);
    expect(payloads[2].detail.resultLength).toBeGreaterThan(0);
    expect(payloads[3].detail.changelogLength).toBe(CHANGELOG.length);
  });
});

describe("R41-A1 · 审计失败策略（不阻断业务，但必须 error 留痕）", () => {
  it("审计抛错 → 发布仍成功（版本已落库），且 logger.error 有痕", async () => {
    const h = harness({
      auditService: {
        log: jest.fn(async () => {
          throw new Error("audit table is down");
        }),
      },
    });
    const r = await h.service.publish({
      sopId: "sop-1",
      publishedBy: "user:7",
      audit: AUDIT,
    });
    // 业务副作用照常完成
    expect(r.sop.currentVersion).toBe("1.0.0");
    expect(h.versions.save).toHaveBeenCalledTimes(1);
    // R47（ADR-026 规则 4）：发布只写 currentVersion/status 两列，不再整行 save
    expect(h.sops.save).not.toHaveBeenCalled();
    // R47：列级写 + currentVersion CAS（首发布时 WHERE 用 IS NULL 表达「还没有版本」）
    expect(h.sops.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sop-1", currentVersion: expect.anything() }),
      { currentVersion: "1.0.0", status: "published" },
    );
    // 不阻断 ≠ 静默：必须 error 级别留痕（含动作与错误原因）
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const line = String(h.logger.error.mock.calls[0][0]);
    expect(line).toContain("sop audit write failed");
    expect(line).toContain("sop.publish");
    expect(line).toContain("sop-1");
    expect(line).toContain("audit table is down");
  });

  it("审计缺席（@Optional / 未装配 AuditModule）→ 业务照常，且不刷 error", async () => {
    const h = harness({ auditService: null });
    const r = await h.service.publish({
      sopId: "sop-1",
      publishedBy: "user:7",
      audit: AUDIT,
    });
    expect(r.version.version).toBe("1.0.0");
    expect(h.logger.error).not.toHaveBeenCalled();
  });
});

describe("R41-A1 · 没有写动作的路径一条都不落（不放大计量）", () => {
  it("交付重放（attempt 不前进）→ accepted=false 且不落审计", async () => {
    const h = harness({ assignment: { attempt: 2 } });
    const r = await h.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "completed",
      result: {},
      attempt: 2,
      audit: { ip: "1.1.1.1" },
    });
    expect(r.accepted).toBe(false);
    expect(h.auditService.log).not.toHaveBeenCalled();
  });

  it("澄清已答复（工具重试幂等返回）→ 不落审计", async () => {
    const h = harness({
      clarification: {
        id: "cl-1",
        assignmentId: "as-1",
        round: 1,
        resolution: "answered",
        answer: "已答",
        newSopVersion: null,
      },
    });
    await h.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: "重复",
      replyBy: "user:7",
      audit: AUDIT,
    });
    expect(h.auditService.log).not.toHaveBeenCalled();
  });

  it("同 clientClarificationId 重放（幂等命中）→ 不落审计", async () => {
    const h = harness({
      clarification: {
        id: "cl-1",
        assignmentId: "as-1",
        clientClarificationId: "cc-1",
        round: 1,
        resolution: null,
      },
    });
    const r = await h.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      clientClarificationId: "cc-1",
      question: "重放",
      audit: { ip: "1.1.1.1" },
    });
    expect(r.clarification.id).toBe("cl-1");
    expect(h.auditService.log).not.toHaveBeenCalled();
  });

  it("并发让位（CAS 未命中）→ accepted=false 且不落审计", async () => {
    const h = harness();
    // 别人先把这一行推进到 completed：本次条件 UPDATE 的 status 谓词不再命中
    h.assignments.update.mockImplementationOnce(async () => ({ affected: 0 }));
    const r = await h.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "completed",
      result: {},
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    expect(r.accepted).toBe(false);
    expect(h.auditService.log).not.toHaveBeenCalled();
  });
});

describe("R41-A1 · 控制器的「谁、从哪来」透传", () => {
  function controllerHarness() {
    const sops = {
    update: jest.fn(async () => ({ affected: 1 })),
      getAssignment: jest.fn(async (id: string) => ({
        assignment: { id },
        clarifications: [{ id: "cl-1" }],
      })),
      replyClarification: jest.fn(async (_o: Any) => ({ ok: true })),
    };
    const ctl = new SopController(sops as never, {} as never, {} as never);
    return { ctl, sops };
  }

  it("humanReply：userId 来自 CurrentUser，ip 来自 @Ip()（审计行的两个主体列）", async () => {
    const h = controllerHarness();
    await h.ctl.humanReply(
      "as-1",
      "cl-1",
      { resolution: "answered", answer: "ok" } as never,
      { id: 7 },
      "10.0.0.9",
    );
    expect(h.sops.replyClarification).toHaveBeenCalledWith(
      expect.objectContaining({ audit: { userId: 7, ip: "10.0.0.9" } }),
    );
  });

  it("非数字 subject id → userId=null（不把 NaN 写进可被 userId 过滤的列）", async () => {
    const h = controllerHarness();
    await h.ctl.humanReply(
      "as-1",
      "cl-1",
      { resolution: "answered", answer: "ok" } as never,
      { id: "admin-7" },
    );
    expect(h.sops.replyClarification).toHaveBeenCalledWith(
      expect.objectContaining({ audit: { userId: null, ip: null } }),
    );
  });

  it("执行器协作面：clarify / complete 透传 audit.ip（本面无登录用户）", async () => {
    const executor = { id: "exec-1", address: "office-pc-07:8002" };
    const executors = {
      validateTokenByAddress: jest.fn(async () => true),
      findByAddress: jest.fn(async () => executor),
      resolveCredentialExecutorId: jest.fn(async () => executor.id),
      findOne: jest.fn(async () => executor),
      getAgentCapabilities: jest.fn(async () => ["agent:sop"]),
      updateCapabilities: jest.fn(async () => undefined),
    };
    const sops = {
    update: jest.fn(async () => ({ affected: 1 })),
      ingestClarification: jest.fn(async () => ({
        clarification: { id: "cl-1", clientClarificationId: "cc-1", round: 1 },
        escalated: false,
      })),
      completeAssignment: jest.fn(async () => ({ accepted: true })),
    };
    const ctl = new SopCollabController(
      executors as never,
      sops as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    await ctl.clarify(
      {
        address: "office-pc-07:8002",
        assignmentId: "as-1",
        question: "?",
      } as never,
      "Bearer t",
      "10.1.2.3",
    );
    expect(sops.ingestClarification).toHaveBeenCalledWith(
      expect.objectContaining({ audit: { ip: "10.1.2.3" } }),
    );
    await ctl.complete(
      "as-1",
      { address: "office-pc-07:8002", status: "failed" } as never,
      "Bearer t",
      "10.1.2.4",
    );
    expect(sops.completeAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ audit: { ip: "10.1.2.4" } }),
    );
  });
});

// ── R56：系统动作（cron 扫描）也留痕 ──────────────────────────────────────
// R41-A1 当时把 cron 三类扫描整体排除，理由是「系统动作无操作人 + 5 分钟一次会刷量」。
// 刷量只存在于「每次扫描都记」；这里只记**真正发生了状态迁移**的那几次（affected===1 之后），
// 量级由业务事件决定而不是由 cron 频率决定 ⇒ 不需要去重。下面两条把这个分界钉住。
describe("R56 · 超时扫描的审计（只在真迁移时落账）", () => {
  const staleRow = () => ({
    id: "as-1",
    sopId: "sop-1",
    sopVersion: "1.0.0",
    targetExecutorId: "e1",
    status: "assigned",
    pulledAt: null,
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    lastProgressAt: null,
    resultJson: null,
  });

  it("真的置 failed 才落一条 sop.timeout.unclaimed（userId=null，actor=system:sweep）", async () => {
    const h = harness();
    const row = staleRow();
    (h.assignments as Any).find = jest.fn(async () => [row]);
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 1 }));
    (h.service as Any).notifyTimeout = jest.fn(() => Promise.resolve());

    await h.service.sweepAssignmentTimeouts();

    const logged = (h.auditService.log as jest.Mock).mock.calls
      .map((c: Any[]) => c[0])
      .filter((p: Any) => p.action === "sop.timeout.unclaimed");
    expect(logged).toHaveLength(1);
    expect(logged[0].userId).toBeNull();
    expect(logged[0].resource).toBe("sop_assignment");
    expect(logged[0].resourceId).toBe("as-1");
    expect(logged[0].detail.actor).toBe("system:sweep");
    expect(logged[0].detail.to).toBe("failed");
  });

  it("条件写未命中（别人先推进了）→ 不落账（否则每 5 分钟刷一条假记录）", async () => {
    const h = harness();
    (h.assignments as Any).find = jest.fn(async () => [staleRow()]);
    (h.assignments as Any).update = jest.fn(async () => ({ affected: 0 }));
    (h.service as Any).notifyTimeout = jest.fn(() => Promise.resolve());

    await h.service.sweepAssignmentTimeouts();

    const logged = (h.auditService.log as jest.Mock).mock.calls
      .map((c: Any[]) => c[0])
      .filter((p: Any) => p.action === "sop.timeout.unclaimed");
    expect(logged).toHaveLength(0);
  });
});

// ── R70-A1：澄清类 / 交付类审计行也能深链回 SOP ────────────────────────────
// R65 给审计页加了 SOP 深链（`/sops?sop=<sopId>`）：`sop` 用 resourceId 直接拼，
// `sop_assignment` / `sop_clarification` 用 `detail.sopId`。但 R41 落账时这几类
// detail 里只有 assignmentId，于是**澄清行在审计页不可点** —— 深链静默失效
// （`resourceIdHref` 拿不到 sopId 就返回 null：宁可不点，也不跳到空页）。
// 下面把「这几条审计行的 detail 里必须带 sopId」钉成契约，并且钉住
// **不许多查一次库**（assignment 行本来就在作用域内，sopId 是它的列）。
describe("R70-A1 · 澄清/交付审计行的 detail 带 sopId（审计页深链的输入）", () => {
  /** 与 admin-web `resourceIdHref` 同一读法：detail.sopId 必须是非空字符串。 */
  const deepLinkSopId = (detail: Any): string | null => {
    const v = detail?.sopId;
    return typeof v === "string" && v ? v : null;
  };

  const openClarification = {
    id: "cl-1",
    assignmentId: "as-1",
    round: 2,
    resolution: null,
    answer: null,
    newSopVersion: null,
  };

  it("sop.clarify（上报）/ sop.reply（答复）/ sop.complete（交付）三类都可深链", async () => {
    const h1 = harness();
    await h1.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: "q",
      audit: { ip: "1.1.1.1" },
    });
    const ingested = onlyOne(h1.auditService);

    const h2 = harness({
      clarification: { ...openClarification },
      assignment: { status: "blocked" },
    });
    await h2.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: "a",
      replyBy: "user:7",
      audit: AUDIT,
    });
    const replied = onlyOne(h2.auditService);

    const h3 = harness();
    await h3.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "failed",
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    const completed = onlyOne(h3.auditService);

    expect([ingested.action, replied.action, completed.action]).toEqual([
      "sop.clarify",
      "sop.reply",
      "sop.complete",
    ]);
    for (const row of [ingested, replied, completed]) {
      expect(deepLinkSopId(row.detail)).toBe("sop-1");
    }
    // resourceId 仍是「这一行自己的 id」——深链靠 detail 分流，把它换成 sopId
    // 会让审计行指错对象（「谁答了哪条澄清」变成「答了哪个 SOP」）。
    expect(ingested.resourceId).toBe("cl-new");
    expect(replied.resourceId).toBe("cl-1");
    expect(completed.resourceId).toBe("as-1");
  });

  it("最大轮次触顶升级（sop.clarify, escalated=true）同样带 sopId", async () => {
    const h = harness({ assignment: { clarificationRound: 3, maxRounds: 3 } });
    await h.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: "q",
      audit: { ip: "1.1.1.1" },
    });
    const row = onlyOne(h.auditService);
    expect(row.detail.escalated).toBe(true);
    expect(deepLinkSopId(row.detail)).toBe("sop-1");
  });

  it("兜底升级（sop.clarification.escalated）也带 sopId——同类行不能继续不可点", async () => {
    const h = harness({
      // 行必须真实存在：harness 的条件 UPDATE 要能在这一行上命中
      // （resolution IS NULL → escalated_to_human），否则扫描会走「让位」分支。
      clarification: {
        ...openClarification,
        createdAt: new Date(0),
        reviewSessionId: null,
      },
    });
    (h.clarifications as Any).find = jest.fn(async () => [
      {
        id: "cl-1",
        assignmentId: "as-1",
        round: 1,
        createdAt: new Date(0),
        reviewSessionId: null,
      },
    ]);
    await (h.service as Any).sweepStuckClarifications();

    const logged = (h.auditService.log as jest.Mock).mock.calls
      .map((c: Any[]) => c[0])
      .filter((p: Any) => p.action === "sop.clarification.escalated");
    expect(logged).toHaveLength(1);
    expect(deepLinkSopId(logged[0].detail)).toBe("sop-1");
  });

  it("补 sopId 不为审计多打一次库（复用作用域内的 assignment 行）", async () => {
    const h = harness({
      clarification: { ...openClarification },
      assignment: { status: "blocked" },
    });
    await h.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: "a",
      replyBy: "user:7",
      audit: AUDIT,
    });
    expect(h.assignments.findOne).toHaveBeenCalledTimes(1);

    const h2 = harness();
    await h2.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "failed",
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    expect(h2.assignments.findOne).toHaveBeenCalledTimes(1);
    // 交付回报完全不需要读澄清表——sopId 是 assignment 行自带的列
    expect(h2.clarifications.findOne).not.toHaveBeenCalled();
  });

  it("带上 sopId 之后 detail 仍然不含正文（R41-A1 的硬约束不破）", async () => {
    const QUESTION = "R70-QUESTION-BODY";
    const ANSWER = "R70-ANSWER-BODY";
    const RESULT = "R70-RESULT-BODY";
    const payloads: Any[] = [];

    const h1 = harness();
    await h1.service.ingestClarification({
      assignmentId: "as-1",
      executorId: "exec-1",
      question: QUESTION,
      audit: { ip: "1.1.1.1" },
    });
    payloads.push(h1.auditService.log.mock.calls[0][0]);

    const h2 = harness({
      clarification: { ...openClarification },
      assignment: { status: "blocked" },
    });
    await h2.service.replyClarification({
      clarificationId: "cl-1",
      resolution: "answered",
      answer: ANSWER,
      replyBy: "user:7",
      audit: AUDIT,
    });
    payloads.push(h2.auditService.log.mock.calls[0][0]);

    const h3 = harness();
    await h3.service.completeAssignment({
      assignmentId: "as-1",
      executorId: "exec-1",
      status: "failed",
      result: { note: RESULT },
      attempt: 1,
      audit: { ip: "1.1.1.1" },
    });
    payloads.push(h3.auditService.log.mock.calls[0][0]);

    const serialized = JSON.stringify(payloads);
    for (const secret of [QUESTION, ANSWER, RESULT]) {
      expect(serialized).not.toContain(secret);
    }
    // 仍是「只记长度」
    expect(payloads[0].detail.questionLength).toBe(QUESTION.length);
    expect(payloads[1].detail.answerLength).toBe(ANSWER.length);
    expect(payloads[2].detail.resultLength).toBeGreaterThan(0);
    // 且 sopId 只是 id：答复行的 detail 键集合被钉死，免得日后有人顺手
    // 把 slug / body / 题目正文加进来。
    expect(Object.keys(payloads[1].detail).sort()).toEqual(
      [
        "actor",
        "answerLength",
        "assignmentId",
        "newSopVersion",
        "resolution",
        "round",
        "sopId",
      ].sort(),
    );
  });
});

