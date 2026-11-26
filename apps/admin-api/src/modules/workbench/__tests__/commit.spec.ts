/**
 * N7 commit 单测（内存替身级）。
 *
 * 本机 @nestjs/* 12.x 为 ESM-only，而 ts-jest 以 CJS 装载——沿用第一轮
 * preview-validator.spec.ts 的 jest.mock 隔框架风格：框架边界替换成内存替身，
 * 被测控制器、重建逻辑、front-matter 校验全是真实代码。
 */
jest.mock("@nestjs/common", () => {
  class HttpError extends Error {
    response?: unknown;
    status?: number;
    constructor(response?: unknown, status?: number) {
      super(
        typeof response === "object" && response && "message" in response
          ? String((response as { message?: unknown }).message)
          : undefined,
      );
      this.response = response;
      this.status = status;
    }
    getResponse() {
      return this.response;
    }
    getStatus() {
      return this.status;
    }
  }
  const exceptions = [
    "BadGatewayException",
    "BadRequestException",
    "ConflictException",
    "ForbiddenException",
    "GatewayTimeoutException",
    "GoneException",
    "HttpException",
    "InternalServerErrorException",
    "MethodNotAllowedException",
    "NotAcceptableException",
    "NotFoundException",
    "NotImplementedException",
    "PayloadTooLargeException",
    "PreconditionFailedException",
    "RequestTimeoutException",
    "ServiceUnavailableException",
    "UnauthorizedException",
    "UnprocessableEntityException",
    "UnsupportedMediaTypeException",
  ];
  const out: Record<string, unknown> = {};
  for (const name of exceptions) out[name] = HttpError;
  return {
    ...out,
    Controller: () => () => undefined,
    Post: () => () => undefined,
    Body: () => () => undefined,
    Inject: () => () => undefined,
    Ip: () => () => undefined,
    Optional: () => () => undefined,
    Injectable: () => () => undefined,
    UseGuards: () => () => undefined,
    Logger: class {
      log() {}
      warn() {}
      error() {}
    },
  };
});

jest.mock("@nestjs/swagger", () => ({
  ApiTags: () => () => undefined,
  ApiBearerAuth: () => () => undefined,
  ApiOkResponse: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiProperty: () => () => undefined,
  ApiPropertyOptional: () => () => undefined,
}));

jest.mock("../../../common/decorators/roles.decorator", () => ({
  Roles: () => () => undefined,
}));

jest.mock("../../../common/decorators/current-user.decorator", () => ({
  CurrentUser: () => () => undefined,
}));

jest.mock("../../../common/guards/jwt-auth.guard", () => ({
  JwtAuthGuard: class {},
}));

jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin", USER: "user" },
}));

jest.mock("../../sop/sop.service", () => ({
  SopService: class {},
}));

import { BadRequestException } from "@nestjs/common";

import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import {
  DOMAIN_EVENTS,
  EVENT_SCHEMA_VERSION,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import {
  parseFrontMatterYaml,
  validateFrontMatter,
} from "../../sop/sop-frontmatter";
import {
  buildPreview,
  computePolicyGeneration,
  currentPolicySnapshot,
} from "../preview-validator";
import { PolicyGenerationService } from "../policy-generation.service";
import { WorkbenchController } from "../workbench.controller";

describe("Workbench commit — 确认→落库（单测/内存替身）", () => {
  const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
  const record = jest.fn(async (dto: any) => ({ id: "act-1", ...dto }));
  const controller = new WorkbenchController(
    { draft } as any,
    { record } as any,
  );
  // 生产快照恒定：所有"应成功"的 commit 回读同一个 generation。
  const GEN = computePolicyGeneration();
  const user = { id: 42, username: "alice" };
  const ip = "10.0.0.7";
  const base = {
    goal: "汇总昨日订单异常并推送日报",
    cadence: "daily" as const,
  };

  beforeEach(() => {
    draft.mockClear();
    record.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  it("hash 不匹配 → VALIDATION_FAILED，且零落库", async () => {
    let caught: unknown;
    try {
      await controller.commit(
        {
          ...base,
          expectedCardHash: "0000000000000000",
          expectedPolicyGeneration: GEN,
        },
        user,
        ip,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(draft).not.toHaveBeenCalled();
  });

  it("eligible=false（未命中能力白名单）即便 hash 正确也拒绝落库", async () => {
    const input = { ...base, params: { capabilityId: "bogus" } };
    const { cardHash } = buildPreview(input);
    let caught: unknown;
    try {
      await controller.commit(
        {
          ...input,
          expectedCardHash: cardHash,
          expectedPolicyGeneration: GEN,
        },
        user,
        ip,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(draft).not.toHaveBeenCalled();
  });

  it("正常落库：Spy draft 验 slug/title/front-matter/audit 齐全", async () => {
    const input = {
      ...base,
      params: { capabilityId: "browser", maxTurns: "7" },
    };
    const preview = buildPreview(input);
    const res = await controller.commit(
      {
        ...input,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    const slug = `workbench-${preview.cardHash.slice(0, 8)}`;
    expect(res).toEqual({
      sopId: "sop-1",
      slug,
      status: "draft",
      next: "请在 SOP 页面审阅并发布",
    });
    expect(draft).toHaveBeenCalledTimes(1);

    const arg = draft.mock.calls[0][0];
    expect(arg.slug).toBe(slug);
    expect(arg.title).toBe(preview.card.title);
    expect(arg.applicationId).toBeNull();
    expect(arg.createdBy).toBe("user:42");
    expect(arg.audit).toEqual({
      userId: 42,
      username: "alice",
      ip: "10.0.0.7",
    });

    // front-matter 过草稿级真实校验，能力域来自 card，不编造字段
    const frontMatter = validateFrontMatter(
      parseFrontMatterYaml(arg.frontMatterYaml),
      { strict: false },
    );
    expect(frontMatter.capabilities).toEqual(["browser"]);
    expect(frontMatter.acceptance).toEqual([
      { kind: "platform", check: "task_status", expect: "success" },
    ]);
    // trigger/acceptance/hash 作为业务语句落 body（front-matter 没有 trigger 键）
    expect(arg.bodyMarkdown).toContain(preview.card.triggerText);
    expect(arg.bodyMarkdown).toContain(preview.card.acceptanceText);
    expect(arg.bodyMarkdown).toContain(`cardHash: ${preview.cardHash}`);
  });

  it("重复 commit 同输入 → 同 slug，走 draft 覆盖语义（不另开 slug）", async () => {
    const preview = buildPreview(base);
    const dto = {
      ...base,
      expectedCardHash: preview.cardHash,
      expectedPolicyGeneration: GEN,
    };
    const a = await controller.commit(dto, user, ip);
    const b = await controller.commit(dto, user, ip);

    expect(a.slug).toBe(b.slug);
    expect(a.slug).toMatch(/^workbench-[0-9a-f]{8}$/);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft.mock.calls[0][0].slug).toBe(draft.mock.calls[1][0].slug);
  });

  it("commit 成功后记一条能力激活（验 key/sessionId/parameters/result）", async () => {
    const input = {
      ...base,
      params: { capabilityId: "browser", maxTurns: "7" },
    };
    const preview = buildPreview(input);
    const res = await controller.commit(
      {
        ...input,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0];
    expect(arg.capabilityKey).toBe("workbench.commit");
    expect(arg.capabilityVersion).toBe("1.0.0");
    expect(arg.sessionId).toBe(res.sopId);
    expect(arg.sessionId).toBe("sop-1");
    expect(arg.parameters).toMatchObject({
      goal: input.goal,
      cadence: input.cadence,
      capabilityIds: preview.card.capabilityHints,
      cardHash: preview.cardHash,
    });
    expect(arg.userId).toBe(42);
    expect(arg.username).toBe("alice");
    expect(arg.result).toBe("success");
  });

  it("activation.record 抛异常 → commit 仍成功且只 warn（fail-open）", async () => {
    const preview = buildPreview(base);
    const failingRecord = jest.fn(async () => {
      throw new Error("activation db down");
    });
    const failing = new WorkbenchController(
      { draft } as any,
      { record: failingRecord } as any,
    );
    const warn = jest
      .spyOn((failing as any).logger, "warn")
      .mockImplementation(() => undefined);

    const res = await failing.commit(
      {
        ...base,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    expect(res).toEqual({
      sopId: "sop-1",
      slug: `workbench-${preview.cardHash.slice(0, 8)}`,
      status: "draft",
      next: "请在 SOP 页面审阅并发布",
    });
    expect(failingRecord).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("activation db down");
    warn.mockRestore();
  });

  it("@Optional 缺席（极简装配）→ commit 不崩、照常落库", async () => {
    const preview = buildPreview(base);
    const bare = new WorkbenchController({ draft } as any);

    const res = await bare.commit(
      {
        ...base,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    expect(res.status).toBe("draft");
    expect(res.sopId).toBe("sop-1");
    expect(draft).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("generation 匹配（回传 preview 返回值）→ 正常落库", async () => {
    const preview = await controller.preview(base);
    expect(preview.policyGeneration).toBe(GEN);
    const res = await controller.commit(
      {
        ...base,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: preview.policyGeneration,
      },
      user,
      ip,
    );
    expect(res.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("generation 不匹配 → VALIDATION_FAILED 且 sops.draft 零调用", async () => {
    const preview = buildPreview(base);
    let caught: unknown;
    try {
      await controller.commit(
        {
          ...base,
          expectedCardHash: preview.cardHash,
          expectedPolicyGeneration: "0000000000000000",
        },
        user,
        ip,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect((caught as AppError).params).toMatchObject({
      detail: "方案卡生成后能力策略已变更，请重新预览后再提交",
    });
    expect(draft).not.toHaveBeenCalled();
  });

  it("preview→commit 之间策略变更（spy 快照注入）→ 旧 generation 被拒", async () => {
    const input = { ...base, params: { capabilityId: "browser" } };
    const snapshotA = currentPolicySnapshot();
    const snapshotB = {
      ...snapshotA,
      policyVersion: "2",
      capabilityWhitelist: ["gui"] as const,
      maxTurnsCap: 5,
    };
    const genA = computePolicyGeneration(snapshotA);
    const genB = computePolicyGeneration(snapshotB);
    expect(genB).not.toBe(genA);

    // preview 时读到策略 A，commit 时策略已收紧为 B ⇒ 旧卡作废。
    const read = jest
      .spyOn(controller, "currentPolicySnapshot")
      .mockReturnValueOnce(snapshotA)
      .mockReturnValueOnce(snapshotB);

    const preview = await controller.preview(input);
    expect(preview.policyGeneration).toBe(genA);

    let caught: unknown;
    try {
      await controller.commit(
        {
          ...input,
          expectedCardHash: preview.cardHash,
          expectedPolicyGeneration: preview.policyGeneration,
        },
        user,
        ip,
      );
    } catch (err) {
      caught = err;
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect((caught as AppError).params).toMatchObject({
      detail: "方案卡生成后能力策略已变更，请重新预览后再提交",
    });
    expect(draft).not.toHaveBeenCalled();
  });
});

/** N20 硬阈第四闸（单测/内存替身）：超限 fail-close 在 draft 落库之前。 */
describe("Workbench commit — N20 硬阈值第四闸（单测/内存替身）", () => {
  const base = {
    goal: "汇总昨日订单异常并推送日报",
    cadence: "daily" as const,
  };
  const GEN = computePolicyGeneration();
  const user = { id: 42, username: "alice" };
  const ip = "10.0.0.7";

  const withGate = (decision: any) => {
    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const record = jest.fn(async (dto: any) => ({ id: "act-1", ...dto }));
    const evaluateHardLimit = jest.fn(async () => decision);
    const controller = new WorkbenchController(
      { draft } as any,
      { record } as any,
      null,
      { evaluateHardLimit } as any,
    );
    return { controller, draft, record, evaluateHardLimit };
  };

  it("gate blocked → 429 RATE_LIMITED，sops.draft 与 activation.record 零调用", async () => {
    const { controller, draft, record, evaluateHardLimit } = withGate({
      blocked: true,
      matched: {
        scope: "capability",
        target: "workbench.commit",
        usage: 1,
        hardLimit: 1,
        windowDays: 30,
      },
    });
    const input = { ...base, params: { projectId: "proj-1" } };
    const preview = buildPreview(input);
    let caught: unknown;
    try {
      await controller.commit(
        {
          ...input,
          expectedCardHash: preview.cardHash,
          expectedPolicyGeneration: GEN,
        },
        user,
        ip,
      );
    } catch (err) {
      caught = err;
    }

    expect((caught as AppError).errorCode).toBe(ErrorCode.RATE_LIMITED);
    expect((caught as any).getStatus()).toBe(429);
    expect((caught as AppError).params).toMatchObject({
      detail: expect.stringContaining("workbench.commit"),
    });
    expect(evaluateHardLimit).toHaveBeenCalledTimes(1);
    expect(evaluateHardLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityKey: "workbench.commit",
        capabilityVersion: "1.0.0",
        projectId: "proj-1",
      }),
    );
    // 第四闸在 draft 之前 ⇒ 两个副作用都不发生（不再是「超限仍 201 仍落库」）
    expect(draft).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("gate 放行 → 正常落 draft 并记 success 激活", async () => {
    const { controller, draft, record, evaluateHardLimit } = withGate({
      blocked: false,
    });
    const preview = buildPreview(base);
    const res = await controller.commit(
      {
        ...base,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    expect(res.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0][0] as any).result).toBe("success");
    expect(evaluateHardLimit).toHaveBeenCalledTimes(1);
  });

  it("gate 缺席 → 跳过第四闸，照常落库（兼容极简装配）", async () => {
    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const bare = new WorkbenchController({ draft } as any);
    const preview = buildPreview(base);
    const res = await bare.commit(
      {
        ...base,
        expectedCardHash: preview.cardHash,
        expectedPolicyGeneration: GEN,
      },
      user,
      ip,
    );

    expect(res.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });
});

/** N14 端到端（单测级）：capability 写事件 → 在途旧卡被拒、重预览后放行。 */
describe("Workbench commit — N14 在途策略即时失效（单测/内存替身）", () => {
  it("preview 得 gen-A → emit capability.changed → A 被拒、重新 preview 得 gen-B 成功", async () => {
    const bus = new DomainEventBus();
    const generation = new PolicyGenerationService(bus);
    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const controller = new WorkbenchController(
      { draft } as any,
      null,
      generation,
    );
    const input = {
      goal: "汇总昨日订单异常并推送日报",
      cadence: "daily" as const,
    };
    const user = { id: 42, username: "alice" };

    const cardA = await controller.preview(input);
    const genA = cardA.policyGeneration;

    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, {
      key: "browser",
      operation: "update",
      occurredAt: new Date().toISOString(),
      schemaVersion: EVENT_SCHEMA_VERSION,
    });

    let caught: unknown;
    try {
      await controller.commit(
        {
          ...input,
          expectedCardHash: cardA.cardHash,
          expectedPolicyGeneration: genA,
        },
        user,
        "10.0.0.7",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect((caught as AppError).params).toMatchObject({
      detail: "方案卡生成后能力策略已变更，请重新预览后再提交",
    });
    expect(draft).not.toHaveBeenCalled();

    const cardB = await controller.preview(input);
    expect(cardB.policyGeneration).not.toBe(genA);
    const res = await controller.commit(
      {
        ...input,
        expectedCardHash: cardB.cardHash,
        expectedPolicyGeneration: cardB.policyGeneration,
      },
      user,
      "10.0.0.7",
    );
    expect(res.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });
});

/** N14+ 持久化端到端（单测级）：DB bump 换代际 → 旧 gen 被拒、重预览后放行。 */
describe("Workbench commit — N14+ 持久化代际失效（单测/内存替身）", () => {
  it("preview 得 gen-A → bump 写 DB 到 v+1 → A 被拒、重新 preview 得 gen-B 成功", async () => {
    let stored = "0";
    const store = {
      findOne: jest.fn(async () => ({ value: stored })),
      upsert: jest.fn(async (dto: { value: string }) => {
        stored = dto.value;
        return { value: stored };
      }),
    };
    const broadcast = { publishInvalidate: jest.fn(async () => {}) };
    const generation = new PolicyGenerationService(
      null,
      store as any,
      broadcast as any,
    );
    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const controller = new WorkbenchController(
      { draft } as any,
      null,
      generation,
    );
    const input = {
      goal: "汇总昨日订单异常并推送日报",
      cadence: "daily" as const,
    };
    const user = { id: 42, username: "alice" };

    const cardA = await controller.preview(input);
    const genA = cardA.policyGeneration;
    expect(store.findOne).toHaveBeenCalledTimes(1);

    // 能力写操作 → 持久化 bump（模拟另一进程改了能力后 bump DB）
    await generation.bump("capability.update");
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ value: "1", valueType: "number" }),
    );
    expect(broadcast.publishInvalidate).toHaveBeenCalled();

    let caught: unknown;
    try {
      await controller.commit(
        {
          ...input,
          expectedCardHash: cardA.cardHash,
          expectedPolicyGeneration: genA,
        },
        user,
        "10.0.0.7",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(draft).not.toHaveBeenCalled();

    const cardB = await controller.preview(input);
    expect(cardB.policyGeneration).not.toBe(genA);
    const res = await controller.commit(
      {
        ...input,
        expectedCardHash: cardB.cardHash,
        expectedPolicyGeneration: cardB.policyGeneration,
      },
      user,
      "10.0.0.7",
    );
    expect(res.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });
});
