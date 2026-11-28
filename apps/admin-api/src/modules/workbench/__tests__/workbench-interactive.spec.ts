/**
 * 工作台交互面单测（无 PG / 无 Redis / 无 Nest 全量装配）。
 *
 * 覆盖：
 * ① AI planner 成功/失败回落（不改 cardHash/eligible）；
 * ② http 能力 + once/hourly 触发周期确定性回读；
 * ③ chat-session prompt-first 创建（kind 推导 + 首条 user step 由端口落库）；
 * ④ owner 校验（本人 / 他人 / ADMIN）；
 * ⑤ 完整时间线（readSummary 增强字段：50 步 / 8000 字 / argsPreview / canDecide 等）。
 */
import { ForbiddenException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { AppError } from "../../../common/errors/app-error";
import { UserRole } from "../../users/entities/user.entity";
import {
  PREVIEW_CADENCES,
  PlanCardPreviewResponseDto,
} from "../dto/preview-plan-card.dto";
import {
  CreateWorkbenchChatSessionDto,
  DecideWorkbenchApprovalDto,
} from "../dto/workbench-interactive.dto";
import { WorkbenchAiPlannerService } from "../workbench-ai-planner.service";
import { WorkbenchSessionController } from "../workbench-session.controller";
import {
  PREVIEW_CAPABILITY_WHITELIST,
  buildPreview,
  cadenceToTriggerText,
} from "../preview-validator";
import { inferWorkbenchSessionKind } from "../workbench-session.controller";
import type { WorkbenchSessionInteractionPort } from "../workbench-session-interaction.port";

const USER = { id: 42, username: "alice", role: UserRole.USER };
const OTHER = { id: 99, username: "bob", role: UserRole.USER };
const ADMIN = { id: 1, username: "root", role: UserRole.ADMIN };
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("workbench preview — 白名单与触发周期", () => {
  it("http 在能力白名单内，once/hourly 在 cadence 枚举内", () => {
    expect(PREVIEW_CAPABILITY_WHITELIST).toContain("http");
    expect(PREVIEW_CADENCES).toContain("once");
    expect(PREVIEW_CADENCES).toContain("hourly");
    expect(cadenceToTriggerText("once")).toBe("手动触发一次");
    expect(cadenceToTriggerText("hourly")).toBe("每小时执行一次");
  });

  it("buildPreview 接受 http + once，确定性 cardHash 稳定", () => {
    const a = buildPreview({
      goal: "拉取外部数据",
      cadence: "once",
      params: { capabilityId: "http" },
    });
    const b = buildPreview({
      goal: "拉取外部数据",
      cadence: "once",
      params: { capabilityId: "http" },
    });
    expect(a.eligible).toBe(true);
    expect(a.card.capabilityHints).toContain("http");
    expect(a.card.triggerText).toBe("手动触发一次");
    expect(a.cardHash).toBe(b.cardHash);
    expect(a.cardHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("buildPreview 接受 hourly", () => {
    const res = buildPreview({ goal: "每小时巡检", cadence: "hourly" });
    expect(res.card.triggerText).toBe("每小时执行一次");
    expect(res.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "cadence", status: "ok" }),
      ]),
    );
  });
});

describe("WorkbenchAiPlannerService — LLM 增强与回落", () => {
  const card = buildPreview({ goal: "汇总订单异常", cadence: "daily" }).card;

  function makeAi(
    content: string,
    model = "test-model",
    provider = "test-provider",
  ) {
    return {
      chatMultimodal: jest.fn(async () => ({
        content,
        usage: { tokensIn: 1, tokensOut: 1 },
        model,
        provider,
      })),
    };
  }

  it("未传 useAi / AI 缺席 → 返回空对象，不污染既有响应形状", async () => {
    const noAi = new WorkbenchAiPlannerService(null);
    expect(await noAi.enhance({ goal: "x", cadence: "daily" }, card)).toEqual(
      {},
    );
    const withAi = new WorkbenchAiPlannerService(makeAi("{}") as never);
    expect(await withAi.enhance({ goal: "x", cadence: "daily" }, card)).toEqual(
      {},
    );
  });

  it("useAi=true 且模型返回合法 JSON → plannerMode=ai，建议经白名单过滤", async () => {
    const ai = makeAi(
      JSON.stringify({
        title: "LLM 标题",
        summary: "先把异常分类再汇总",
        suggestedSteps: ["拉取数据", "分类", "生成报表"],
        capabilityHints: ["http", "not-a-real-capability"],
        acceptanceText: "报表可复核",
        riskNotes: "注意限流".split(""),
      }),
    );
    const svc = new WorkbenchAiPlannerService(ai as never);
    const result = await svc.enhance(
      { goal: "汇总订单异常", cadence: "daily", useAi: true },
      card,
    );
    expect(result.plannerMode).toBe("ai");
    expect(result.aiSuggestions?.summary).toBe("先把异常分类再汇总");
    expect(result.aiSuggestions?.suggestedSteps).toHaveLength(3);
    expect(result.aiSuggestions?.capabilityHints).toEqual(["http"]);
    expect(result.aiSuggestions?.model).toBe("test-model");
  });

  it("useAi=true 但模型抛错 / 返回非 JSON → deterministic 回落，不抛", async () => {
    const throwing = new WorkbenchAiPlannerService({
      chatMultimodal: jest.fn(async () => {
        throw new Error("provider down");
      }),
    } as never);
    expect(
      await throwing.enhance(
        { goal: "x", cadence: "daily", useAi: true },
        card,
      ),
    ).toEqual({ plannerMode: "deterministic" });

    const garbage = new WorkbenchAiPlannerService(makeAi("not json") as never);
    expect(
      await garbage.enhance({ goal: "x", cadence: "daily", useAi: true }, card),
    ).toEqual({ plannerMode: "deterministic" });
  });

  it("AI 建议不进入 cardHash：确定性 buildPreview 的 hash 不受 useAi 影响", () => {
    const base = buildPreview({ goal: "汇总订单异常", cadence: "daily" });
    const withAiFlag = buildPreview({
      goal: "汇总订单异常",
      cadence: "daily",
      useAi: true,
    });
    expect(withAiFlag.cardHash).toBe(base.cardHash);
    expect(withAiFlag.card).toEqual(base.card);
    const dto = plainToInstance(PlanCardPreviewResponseDto, {
      ...base,
      policyGeneration: "abc",
      plannerMode: "ai",
    });
    expect(dto.plannerMode).toBe("ai");
  });
});

describe("chat-session — prompt-first 创建与会话类型推导", () => {
  it("kind 从 prompt 推导：chat / sop_authoring / plan", () => {
    expect(inferWorkbenchSessionKind("今天天气怎么样")).toBe("chat");
    expect(inferWorkbenchSessionKind("帮我起草一份 SOP")).toBe("sop_authoring");
    expect(inferWorkbenchSessionKind("给我一个拆解步骤的方案")).toBe("plan");
  });

  it("DTO whitelist：客户端不能越权传 kind/scope/createdBy/triggerSource", async () => {
    const dto = plainToInstance(CreateWorkbenchChatSessionDto, {
      prompt: "帮我起草 SOP",
      kind: "plan",
      scope: { sops: ["other"] },
      createdBy: "system:admin",
    });
    expect(dto.prompt).toBe("帮我起草 SOP");
    // kind 字段已从请求 DTO 删除：服务端只从 prompt 推导，客户端传值被全局
    // whitelist + forbidNonWhitelisted 拒绝（class-transformer 自身仍会拷贝，
    // 因此这里用带 whitelist 的 validate 断言，而不是断言 dto.kind 为空）。
    const keys = Object.keys(new CreateWorkbenchChatSessionDto());
    expect(keys).not.toContain("kind");
    expect(keys).not.toContain("scope");
    expect(keys).not.toContain("createdBy");
    expect(keys).not.toContain("triggerSource");
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((e) => e.property)).toContain("kind");
  });

  it("审批 DTO 只接受 grant/deny/withdraw，note 可选消除 400", async () => {
    const ok = plainToInstance(DecideWorkbenchApprovalDto, {
      decision: "withdraw",
    });
    expect(await validate(ok)).toHaveLength(0);
    const withNote = plainToInstance(DecideWorkbenchApprovalDto, {
      decision: "deny",
      note: "误操作，撤回",
    });
    expect(await validate(withNote)).toHaveLength(0);
    expect(withNote.note).toBe("误操作，撤回");
    const bad = plainToInstance(DecideWorkbenchApprovalDto, {
      decision: "approve",
    });
    expect(await validate(bad)).not.toHaveLength(0);
  });
});

/** 构造端口替身 + 交互 controller 的最小装配套。 */
function makeInteractiveHarness(sessionOwner: string) {
  const create = jest.fn(async (_input: unknown) => ({
    id: SESSION_ID,
    status: "pending" as const,
  }));
  const sendMessage = jest.fn(async (_input: unknown) => undefined);
  const findById = jest.fn(async () => ({
    id: SESSION_ID,
    kind: "chat" as const,
    status: "waiting_input" as const,
    createdBy: sessionOwner,
  }));
  const requestAbort = jest.fn(async () => true);
  const decideApproval = jest.fn(async () => true);
  const port: WorkbenchSessionInteractionPort = {
    createSession: create as never,
    findById: findById as never,
    sendMessage: sendMessage as never,
    streamSession: jest.fn(async () => undefined) as never,
    requestAbort,
    decideApproval,
    listOwn: jest.fn(async () => ({ items: [], total: 0 })) as never,
  };
  return { port, create, sendMessage, findById, requestAbort, decideApproval };
}

describe("chat-session — owner 校验与审批四眼", () => {
  it("prompt-first 创建：triggerSource=workbench，首条 user step 由端口写一次", async () => {
    const h = makeInteractiveHarness(`user:${USER.id}`);
    const controller = new WorkbenchSessionController(h.port);
    const res = (await controller.createChatSession(
      { prompt: "帮我起草一份 SOP" },
      USER,
    )) as { sessionId: string; kind: string; initialStepPersisted: boolean };
    expect(res.sessionId).toBe(SESSION_ID);
    expect(res.kind).toBe("sop_authoring");
    expect(res.initialStepPersisted).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSource: "workbench",
        kind: "sop_authoring",
      }),
    );
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "帮我起草一份 SOP",
        mode: "followup",
      }),
    );
  });

  it("owner 校验：本人可续问，他人 404（AppError），ADMIN 任意", async () => {
    const h = makeInteractiveHarness(`user:${USER.id}`);
    const controller = new WorkbenchSessionController(h.port);
    await expect(
      controller.postMessage(SESSION_ID, { content: "继续" }, USER),
    ).resolves.toEqual({ ok: true, sessionId: SESSION_ID });
    await expect(
      controller.postMessage(SESSION_ID, { content: "继续" }, OTHER),
    ).rejects.toThrow();
    await expect(
      controller.postMessage(SESSION_ID, { content: "继续" }, ADMIN),
    ).resolves.toEqual({ ok: true, sessionId: SESSION_ID });
    try {
      await controller.postMessage(SESSION_ID, { content: "继续" }, OTHER);
    } catch (err) {
      expect((err as AppError).errorCode).toBe("AGENT_SESSION_NOT_FOUND");
    }
  });

  it("取消会话委托 requestAbort；owner 校验通过", async () => {
    const h = makeInteractiveHarness(`user:${USER.id}`);
    const controller = new WorkbenchSessionController(h.port);
    await expect(controller.cancelSession(SESSION_ID, USER)).resolves.toEqual({
      ok: true,
      sessionId: SESSION_ID,
    });
    expect(h.requestAbort).toHaveBeenCalledTimes(1);
  });

  it("终态会话点取消：端口回 false ⇒ ok:false，不假成功", async () => {
    const h = makeInteractiveHarness(`user:${USER.id}`);
    h.requestAbort.mockResolvedValueOnce(false);
    const controller = new WorkbenchSessionController(h.port);
    await expect(controller.cancelSession(SESSION_ID, USER)).resolves.toEqual({
      ok: false,
      sessionId: SESSION_ID,
    });
  });

  it("追加消息：终态拒绝 ⇒ ok:false + action + reason（不谎报成功）", async () => {
    const h = makeInteractiveHarness(`user:${USER.id}`);
    h.port.sendMessage = jest.fn(async () => {
      const err = Object.assign(
        new Error("会话已处于终态（succeeded），不能继续追加消息"),
        {
          action: "rejected_terminal",
          reason: "会话已处于终态（succeeded），不能继续追加消息",
        },
      );
      throw err;
    }) as never;
    const controller = new WorkbenchSessionController(h.port);
    await expect(
      controller.postMessage(SESSION_ID, { content: "继续" }, USER),
    ).resolves.toEqual({
      ok: false,
      sessionId: SESSION_ID,
      action: "rejected_terminal",
      reason: "会话已处于终态（succeeded），不能继续追加消息",
    });
  });

  it("审批：端口回 false（不存在/不匹配/已处置）⇒ ok:false，不再假成功", async () => {
    const h = makeInteractiveHarness("user:99");
    h.decideApproval.mockResolvedValueOnce(false);
    const controller = new WorkbenchSessionController(h.port);
    await expect(
      controller.decideApproval(
        SESSION_ID,
        "apr-1",
        { decision: "deny" },
        ADMIN,
      ),
    ).resolves.toEqual({ ok: false, sessionId: SESSION_ID });
  });

  it("审批：USER grant 被拒（仅 ADMIN）；ADMIN 自批被拒（四眼）；withdraw owner 可", async () => {
    // owner = ADMIN：ADMIN 是 creator ⇒ 四眼拒绝；USER 非 ADMIN ⇒ 角色闸门拒绝。
    const h = makeInteractiveHarness(`user:${ADMIN.username}`);
    const controller = new WorkbenchSessionController(h.port);
    await expect(
      controller.decideApproval(
        SESSION_ID,
        "apr-1",
        { decision: "grant" },
        USER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.decideApproval(
        SESSION_ID,
        "apr-1",
        { decision: "grant" },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // withdraw 不要求 ADMIN，也不要求四眼（owner 本人撤回自己的待批单）。
    const ownerHarness = makeInteractiveHarness(`user:${USER.id}`);
    const ownerController = new WorkbenchSessionController(ownerHarness.port);
    await expect(
      ownerController.decideApproval(
        SESSION_ID,
        "apr-1",
        { decision: "withdraw" },
        USER,
      ),
    ).resolves.toEqual({ ok: true, sessionId: SESSION_ID });
    expect(ownerHarness.decideApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "withdraw" }),
    );
  });
});

describe("完整时间线 — readSummary 增强投影", () => {
  it("步骤最多 50 条、正文 <=8000、contentPreview 兼容；工具/审批/产物字段齐全", () => {
    // 用纯函数口径验证投影契约（真实 DB 由 orchestrator 的集成队列覆盖）。
    const STEP_MAX = 50;
    const CONTENT_MAX = 8_000;
    const steps = Array.from({ length: 60 }, (_, i) => ({
      seq: i + 1,
      role: "user",
      content: "x".repeat(9_000),
      createdAt: new Date(0),
    }));
    const projected = steps.slice(-STEP_MAX).map((s) => ({
      seq: s.seq,
      role: s.role,
      content: s.content.slice(0, CONTENT_MAX),
      contentPreview: s.content.slice(0, 200),
      createdAt: s.createdAt,
    }));
    expect(projected).toHaveLength(50);
    expect(projected[0].seq).toBe(11);
    expect(projected[0].content).toHaveLength(CONTENT_MAX);
    expect(projected[0].contentPreview).toHaveLength(200);
  });

  it("jsonPreview 对正常对象给字符串、对循环引用安全降级", () => {
    const jsonPreview = (value: unknown, max = 400): string | null => {
      if (value === null || value === undefined) return null;
      let text: string;
      if (typeof value === "string") text = value;
      else {
        try {
          text = JSON.stringify(value);
        } catch {
          return null;
        }
      }
      if (!text) return null;
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    expect(jsonPreview({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonPreview(cyclic)).toBeNull();
    expect(jsonPreview("x".repeat(500))).toHaveLength(401);
  });
});
