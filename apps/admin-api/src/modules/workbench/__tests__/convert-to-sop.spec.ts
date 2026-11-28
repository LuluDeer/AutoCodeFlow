/**
 * 切片 E1（task-16）：POST /workbench/sessions/:id/convert-to-sop
 * —— workbench → SOP 直连的最后一条跳板（单测 / 内存替身级）。
 *
 * 框架不 mock（workbench-session.spec.ts 同款边界：真实 @nestjs/common /
 * 装饰器在 ts-jest 下可加载，WorkbenchController → SopService 真链为先例）；
 * SopService / AgentSessionService / AgentApprovalsService / AuditService /
 * ModuleRef 全部内存替身。
 *
 * 判据是**返回码 + draft 落库副作用 + audit 调用**，不是日志文本：
 *   · 映射正确：slug=goal 归一化、title=卡 title、front-matter 走
 *     buildDraftPayloadFromCard 契约、body 含 goal/cadence/steps/acceptance；
 *   · 审批未 consumed（granted/pending/缺单）⇒ 409 WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED；
 *   · 卡漂移 ⇒ 409 WORKBENCH_CONVERT_CARD_DRIFT；无 commit 锚点 ⇒ 409 NO_COMMIT；
 *   · 会话不存在 / 越权 ⇒ 404 AGENT_SESSION_NOT_FOUND（防枚举同码）；
 *   · slug 冲突 ⇒ -2 后缀；草稿恒 draft 且**绝不调 publish**；audit 写入。
 */
import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import { AgentSessionService } from "../../agent/runtime/agent-session.service";
import { AgentApprovalsService } from "../../agent/runtime/agent-approvals.service";
import { AuditService } from "../../audit/audit.service";
import { rebuildCardFromInput } from "../preview-validator";
import { ConvertToSopService } from "../convert-to-sop.service";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const GOAL = "Weekly status report";
/** commit 同源锚点：fixture 的 cardHash 必须等于真重建值，否则 ③ 闸会如实拒绝。 */
const CARD_HASH = rebuildCardFromInput({
  goal: GOAL,
  cadence: "weekly",
}).cardHash;
const SOURCE_SOP_ID = "sop-src-1";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    kind: "sop_authoring",
    status: "pending",
    createdBy: "user:42",
    contextJson: {
      goal: GOAL,
      sopId: SOURCE_SOP_ID,
      cardHash: CARD_HASH,
      policyGeneration: "0123456789abcdef",
    },
    ...overrides,
  };
}

function makeHarness(
  options: {
    session?: Record<string, unknown> | null;
    approvalRows?: Array<{ toolName: string; status: string; scope: string }>;
    reviewSession?: { id: string; contextJson: Record<string, unknown> } | null;
    existingSlugs?: string[];
    steps?: Array<{ seq: number; role: string; content: string | null }>;
  } = {},
) {
  const draft = jest.fn(async (input: Record<string, unknown>) => ({
    id: "sop-new-1",
    status: "draft",
    slug: input.slug,
    ...input,
  }));
  const publish = jest.fn(async () => {
    throw new Error("publish must never be called by convert-to-sop");
  });
  const sops = {
    getSop: jest.fn(async (id: string) => {
      if (id !== SOURCE_SOP_ID) {
        throw new AppError(ErrorCode.SOP_NOT_FOUND, { sopId: id });
      }
      return {
        id,
        slug: `workbench-${CARD_HASH.slice(0, 8)}`,
        title: "Weekly status report",
        status: "draft",
        createdBy: "user:42",
        frontMatterJson: {
          capabilities: ["http"],
          acceptance: [
            { kind: "platform", check: "task_status", expect: "success" },
          ],
        },
        bodyMarkdown: "# Weekly status report",
      };
    }),
    getBySlug: jest.fn(async (slug: string) => {
      const taken = options.existingSlugs ?? [];
      if (taken.includes(slug)) {
        return { slug };
      }
      throw new AppError(ErrorCode.SOP_NOT_FOUND, { sopId: slug });
    }),
    draft,
    publish,
  };
  const sessions = {
    findById: jest.fn(async () =>
      options.session === null ? null : makeSession(options.session ?? {}),
    ),
    list: jest.fn(async () => ({
      items:
        options.reviewSession === null
          ? []
          : [
              options.reviewSession ?? {
                id: REVIEW_ID,
                contextJson: { sopId: SOURCE_SOP_ID },
              },
            ],
      total: 1,
    })),
    listSteps: jest.fn(
      async () =>
        options.steps ?? [
          { seq: 1, role: "assistant", content: "读取项目列表并汇总状态" },
          { seq: 2, role: "user", content: "补充阻塞项说明" },
        ],
    ),
  };
  const approvals = {
    listForSession: jest.fn(
      async () =>
        options.approvalRows ?? [
          { toolName: "sop_publish", status: "consumed", scope: "once" },
        ],
    ),
  };
  const audit = {
    log: jest.fn(async (payload?: Record<string, unknown>) => void payload),
  };
  const moduleRef = {
    get: (token: unknown) => {
      if (token === AgentSessionService) return sessions;
      if (token === AgentApprovalsService) return approvals;
      if (token === AuditService) return audit;
      return null;
    },
  };
  const service = new ConvertToSopService(sops as never, moduleRef as never);
  const user = { id: 42, username: "alice", role: "user" };
  const call = (overrides: Record<string, unknown> = {}) =>
    service.convert({
      sessionId: SESSION_ID,
      user,
      cadence: "weekly",
      ip: "10.0.0.7",
      ...overrides,
    } as never);
  return {
    service,
    sops,
    sessions,
    approvals,
    audit,
    draft,
    publish,
    call,
    user,
  };
}

/** commit 同源重建：goal/cadence 与 fixture 一致 ⇒ cardHash 与锚点相同。 */
const SAME_CARD_INPUT = { cadence: "weekly" as const };

describe("ConvertToSopService — workbench 会话转 SOP 草稿（切片 E1）", () => {
  it("映射正确：slug=goal 归一化、title=卡 title、body 含 goal/cadence/steps/acceptance，audit 写入，绝不 publish", async () => {
    const h = makeHarness();
    const result = await h.call(SAME_CARD_INPUT);

    expect(result.status).toBe("draft");
    expect(result.published).toBe(false);
    expect(result.slug).toBe("weekly-status-report");
    expect(result.sopId).toBe("sop-new-1");
    expect(result.deeplink).toBe("/sops?sop=sop-new-1");

    expect(h.draft).toHaveBeenCalledTimes(1);
    const input = h.draft.mock.calls[0][0] as Record<string, unknown>;
    expect(input.slug).toBe("weekly-status-report");
    // 卡 title 是 buildPreview 的确定性标题（带「方案卡：」前缀），转换逐字沿用。
    expect(input.title).toBe("方案卡：Weekly status report");
    expect(input.createdBy).toBe("user:42");
    expect(input.applicationId).toBeNull();
    const body = String(input.bodyMarkdown);
    expect(body).toContain("## 目标");
    expect(body).toContain(GOAL);
    expect(body).toContain("cadence: weekly");
    expect(body).toContain("读取项目列表并汇总状态");
    expect(body).toContain("## 方案卡留痕");
    expect(body).toContain(`cardHash: ${CARD_HASH}`);
    // front-matter 是 buildDraftPayloadFromCard 同源 YAML：白名单外的
    // capabilityHints 不进 front-matter（goal 未命中能力词 ⇒ 只有 acceptance）。
    expect(String(input.frontMatterYaml)).toContain("acceptance:");
    expect(String(input.frontMatterYaml)).toContain("task_status");
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.audit.log).toHaveBeenCalledTimes(1);
    const auditPayload = h.audit.log.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(auditPayload.action).toBe("workbench.convert_to_sop");
    expect(auditPayload.resource).toBe("workbench");
    expect(auditPayload.userId).toBe(42);
  });

  it("审批未 consumed（granted）⇒ 409 WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED，且绝不落草稿", async () => {
    const h = makeHarness({
      approvalRows: [
        { toolName: "sop_publish", status: "granted", scope: "once" },
      ],
    });
    await expect(h.call(SAME_CARD_INPUT)).rejects.toMatchObject({
      errorCode: "WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED",
    });
    expect(h.draft).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("审批单不存在（无 sop_review 会话）⇒ 同码 409", async () => {
    const h = makeHarness({ reviewSession: null });
    await expect(h.call(SAME_CARD_INPUT)).rejects.toMatchObject({
      errorCode: "WORKBENCH_CONVERT_APPROVAL_NOT_CONSUMED",
    });
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("卡漂移（cadence 改动 ⇒ 重建 hash ≠ 锚点）⇒ 409 WORKBENCH_CONVERT_CARD_DRIFT", async () => {
    const h = makeHarness();
    await expect(h.call({ cadence: "daily" })).rejects.toMatchObject({
      errorCode: "WORKBENCH_CONVERT_CARD_DRIFT",
    });
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("无 commit 锚点（prompt-first 会话）⇒ 409 WORKBENCH_CONVERT_NO_COMMIT", async () => {
    const h = makeHarness({
      session: { contextJson: { prompt: "帮我写周报" } },
    });
    await expect(h.call(SAME_CARD_INPUT)).rejects.toMatchObject({
      errorCode: "WORKBENCH_CONVERT_NO_COMMIT",
    });
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("会话不存在 / 非本人（USER）⇒ 404 AGENT_SESSION_NOT_FOUND（防枚举同码）", async () => {
    const missing = makeHarness({ session: null });
    await expect(missing.call(SAME_CARD_INPUT)).rejects.toMatchObject({
      errorCode: "AGENT_SESSION_NOT_FOUND",
    });

    const otherOwner = makeHarness({
      session: { createdBy: "user:99" },
    });
    await expect(otherOwner.call(SAME_CARD_INPUT)).rejects.toMatchObject({
      errorCode: "AGENT_SESSION_NOT_FOUND",
    });
    expect(otherOwner.draft).not.toHaveBeenCalled();
  });

  it("ADMIN 可代转他人会话；新草稿仍归属当前操作用户", async () => {
    const h = makeHarness({ session: { createdBy: "user:99" } });
    const result = await h.call({
      ...SAME_CARD_INPUT,
      user: { id: 7, username: "root", role: "admin" },
    });
    expect(result.status).toBe("draft");
    expect(
      (h.draft.mock.calls[0][0] as Record<string, unknown>).createdBy,
    ).toBe("user:7");
    expect((h.draft.mock.calls[0][0] as Record<string, unknown>).slug).toBe(
      "weekly-status-report",
    );
  });

  it("slug 冲突 ⇒ 自动 -2 后缀，不覆盖既有草稿", async () => {
    const h = makeHarness({ existingSlugs: ["weekly-status-report"] });
    const result = await h.call(SAME_CARD_INPUT);
    expect(result.slug).toBe("weekly-status-report-2");
    expect((h.draft.mock.calls[0][0] as Record<string, unknown>).slug).toBe(
      "weekly-status-report-2",
    );
  });

  it("纯中文 goal ⇒ slug 回落 cardHash 前缀（sop slug 契约 ^[a-z0-9][a-z0-9-]{0,127}$）", async () => {
    const cnGoal = "每周汇总项目状态";
    // 锚点用「该 goal+cadence 的真重建 hash」——与 commit 写入 context 的口径一致。
    const real = {
      cardHash: rebuildCardFromInput({ goal: cnGoal, cadence: "weekly" })
        .cardHash,
    };
    const h = makeHarness({
      session: {
        contextJson: {
          goal: cnGoal,
          sopId: SOURCE_SOP_ID,
          cardHash: real.cardHash,
        },
      },
    });
    const result = await h.call({ cadence: "weekly" });
    expect(result.slug).toBe(`workbench-${real.cardHash.slice(0, 8)}`);
  });
});
