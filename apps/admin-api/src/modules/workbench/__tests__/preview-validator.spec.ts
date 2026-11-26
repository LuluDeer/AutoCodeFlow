/**
 * N7 preview 单测（内存替身级）。
 *
 * 本机 @nestjs/* 12.x 为 ESM-only，而 ts-jest 以 CJS 装载，直接 import 装饰器
 * 会撞 "Must use import to load ES Module"。这里用 jest.mock 把框架边界替换成
 * 内存替身（装饰器和异常类均无真实行为），被测对象仍是真实控制器 + 真实纯函数。
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
    Ip: () => () => undefined,
    UseGuards: () => () => undefined,
    Injectable: () => () => undefined,
    Optional: () => () => undefined,
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

// SOP service 的内存替身：预览路径一个写方法都不该碰到。
jest.mock("../../sop/sop.service", () => ({
  SopService: class {
    draft() {
      return Promise.resolve({});
    }
    publish() {
      return Promise.resolve({});
    }
  },
}));

import { BadRequestException } from "@nestjs/common";

import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import {
  DOMAIN_EVENTS,
  EVENT_SCHEMA_VERSION,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SopService } from "../../sop/sop.service";
import {
  OUTPUT_BUDGET_DEFAULT_TURNS,
  OUTPUT_BUDGET_UNITS_CAP,
  outputBudgetFor,
} from "../context-budget";
import {
  PREVIEW_CAPABILITY_WHITELIST,
  PREVIEW_DEFAULT_MAX_TURNS,
  PREVIEW_MAX_TURNS_CAP,
  buildPreview,
  cadenceToTriggerText,
  computeCardHash,
  computePolicyGeneration,
  currentPolicySnapshot,
} from "../preview-validator";
import { PolicyGenerationService } from "../policy-generation.service";
import { WorkbenchController } from "../workbench.controller";

describe("Workbench preview — N7 确定性闸门（单测/内存替身）", () => {
  const controller = new WorkbenchController();
  let draftSpy: jest.SpyInstance;
  let publishSpy: jest.SpyInstance;

  beforeEach(() => {
    draftSpy = jest.spyOn(SopService.prototype, "draft");
    publishSpy = jest.spyOn(SopService.prototype, "publish");
  });

  afterEach(() => jest.restoreAllMocks());

  it("正常生成：返回固定五字段结构，hash/generation 均为 16 位十六进制", async () => {
    const res = await controller.preview({
      goal: "汇总昨日订单异常并推送日报",
      cadence: "daily",
    });

    expect(Object.keys(res).sort()).toEqual(
      ["card", "cardHash", "checks", "eligible", "policyGeneration"].sort(),
    );
    expect(res.eligible).toBe(true);
    expect(res.card.title).toContain("汇总昨日订单异常");
    expect(res.card.budget.maxTurns).toBeLessThanOrEqual(PREVIEW_MAX_TURNS_CAP);
    expect(res.cardHash).toMatch(/^[0-9a-f]{16}$/);
    expect(res.policyGeneration).toMatch(/^[0-9a-f]{16}$/);
    expect(res.policyGeneration).toBe(computePolicyGeneration());
    expect(res.checks.length).toBeGreaterThan(0);
  });

  it.each([
    ["daily", "每天"],
    ["weekly", "每周"],
    ["monthly", "每月 N 日"],
  ] as const)(
    "三种 cadence 业务语句：%s → %s",
    async (cadence, triggerText) => {
      expect(cadenceToTriggerText(cadence)).toBe(triggerText);
      const res = await controller.preview({ goal: "生成报表", cadence });
      expect(res.card.triggerText).toBe(triggerText);
      expect(res.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "cadence", status: "ok" }),
        ]),
      );
    },
  );

  it("未知 capabilityId → checks 里 fail 且 eligible:false", async () => {
    const res = await controller.preview({
      goal: "跑一个任务",
      cadence: "weekly",
      params: { capabilityId: "not-a-real-capability" },
    });

    expect(res.eligible).toBe(false);
    expect(res.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "capabilityId", status: "fail" }),
      ]),
    );
    expect(res.card.capabilityHints).toEqual(["not-a-real-capability"]);
  });

  it("白名单内 capabilityId → ok，hint 回显且 eligible 保持 true", async () => {
    const capabilityId = PREVIEW_CAPABILITY_WHITELIST[0];
    const res = await controller.preview({
      goal: "跑一个任务",
      cadence: "weekly",
      params: { capabilityId },
    });

    expect(res.eligible).toBe(true);
    expect(res.card.capabilityHints).toEqual([capabilityId]);
    expect(res.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "capabilityId", status: "ok" }),
      ]),
    );
  });

  it("预算超过中台上限 → 截断到 20 并记 warn", async () => {
    const res = await controller.preview({
      goal: "长任务",
      cadence: "daily",
      params: { maxTurns: "999" },
    });
    expect(res.card.budget.maxTurns).toBe(PREVIEW_MAX_TURNS_CAP);
    expect(res.eligible).toBe(true);
    expect(res.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "budget.maxTurns",
          status: "warn",
        }),
      ]),
    );
  });

  it("空 goal 拒绝：复用既有 VALIDATION_FAILED 错误码（400 形态）", async () => {
    for (const goal of ["", "   "]) {
      let caught: unknown;
      try {
        await controller.preview({ goal, cadence: "daily" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it("cardHash 稳定：同输入同 hash；键插入顺序不同仍同 hash", async () => {
    const input = {
      goal: "确定性的方案卡",
      cadence: "daily" as const,
      params: { capabilityId: "browser" },
    };
    const a = await controller.preview(input);
    const b = await controller.preview(input);
    expect(a.cardHash).toBe(b.cardHash);
    expect(computeCardHash(a.card)).toBe(a.cardHash);

    const reordered = {
      budget: a.card.budget,
      acceptanceText: a.card.acceptanceText,
      capabilityHints: a.card.capabilityHints,
      triggerText: a.card.triggerText,
      title: a.card.title,
    };
    expect(computeCardHash(reordered)).toBe(a.cardHash);

    const c = await controller.preview({ ...input, goal: "另一个方案卡" });
    expect(c.cardHash).not.toBe(a.cardHash);
  });

  it("不落库：preview 调完后 SOP service 的 draft/publish 零调用", async () => {
    await controller.preview({ goal: "不会落库", cadence: "monthly" });
    await controller.preview({
      goal: "失败卡也不落库",
      cadence: "daily",
      params: { capabilityId: "bogus" },
    });

    expect(draftSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("policyGeneration 确定性：同快照同值，16 位十六进制格式", async () => {
    const snapshot = currentPolicySnapshot();
    const a = computePolicyGeneration(snapshot);
    const b = computePolicyGeneration(snapshot);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);

    const first = await controller.preview({
      goal: "策略代际",
      cadence: "daily",
    });
    const second = await controller.preview({
      goal: "策略代际",
      cadence: "daily",
    });
    expect(first.policyGeneration).toBe(second.policyGeneration);
    expect(first.policyGeneration).toBe(a);
  });

  it("policyGeneration 随策略变更：版本/白名单/预算任一变化即换代际", () => {
    const base = currentPolicySnapshot();
    const gen = computePolicyGeneration(base);
    expect(computePolicyGeneration({ ...base, policyVersion: "2" })).not.toBe(
      gen,
    );
    expect(
      computePolicyGeneration({
        ...base,
        capabilityWhitelist: ["gui", "filesystem"],
      }),
    ).not.toBe(gen);
    expect(computePolicyGeneration({ ...base, maxTurnsCap: 5 })).not.toBe(gen);
  });
});

/** N14：注入真实 generation service，验能力写事件使 preview 代际即时翻新。 */
describe("Workbench preview — N14 运行时代际（单测/内存替身）", () => {
  it("emit capability.changed 后 preview 返回新 generation，格式仍是 16 hex", async () => {
    const bus = new DomainEventBus();
    const generation = new PolicyGenerationService(bus);
    const controller = new WorkbenchController(undefined, null, generation);
    const input = { goal: "在途策略失效", cadence: "daily" as const };

    const before = await controller.preview(input);
    expect(before.policyGeneration).toMatch(/^[0-9a-f]{16}$/);

    bus.emit(DOMAIN_EVENTS.CAPABILITY_CHANGED, {
      key: "browser",
      operation: "update",
      occurredAt: new Date().toISOString(),
      schemaVersion: EVENT_SCHEMA_VERSION,
    });

    const after = await controller.preview(input);
    expect(after.policyGeneration).toMatch(/^[0-9a-f]{16}$/);
    expect(after.policyGeneration).not.toBe(before.policyGeneration);
    expect(after.cardHash).toBe(before.cardHash);
  });
});

/** N12：把 context-budget 的相对预算投影接进 buildPreview 的反证（单测/内存替身）。 */
describe("Workbench preview — N12 相对预算接线（单测/内存替身）", () => {
  const controller = new WorkbenchController();

  it("缺省预算：RU 取默认轮次投影，口径明确无 token 样本且不折算真实成本", async () => {
    const res = await controller.preview({
      goal: "默认相对预算",
      cadence: "daily",
    });

    expect(res.card.budget.maxTurns).toBe(PREVIEW_DEFAULT_MAX_TURNS);
    expect(res.card.budget.relativeUnits).toBe(OUTPUT_BUDGET_DEFAULT_TURNS * 4);
    expect(res.card.budget.relativeUnits).toBe(outputBudgetFor(res.card).units);
    expect(res.card.budget.budgetBasis).toContain("无 token 样本");
    expect(res.card.budget.budgetBasis).toContain("不折算真实成本");
    expect(res.card.budget.budgetBasis).toContain(
      "单位为相对预算单位（RU），不折算真实 token",
    );
  });

  it("改大 maxTurns：RU 按公式增长，N7 截断到 20 后不再放大且 warn 保留", async () => {
    const small = await controller.preview({
      goal: "预算增长",
      cadence: "daily",
      params: { maxTurns: "1" },
    });
    const mid = await controller.preview({
      goal: "预算增长",
      cadence: "daily",
      params: { maxTurns: "10" },
    });
    const huge = await controller.preview({
      goal: "预算增长",
      cadence: "daily",
      params: { maxTurns: "999" },
    });

    expect(small.card.budget.relativeUnits).toBe(4);
    expect(mid.card.budget.relativeUnits).toBe(40);
    expect(huge.card.budget.relativeUnits).toBe(PREVIEW_MAX_TURNS_CAP * 4);
    expect(huge.card.budget.relativeUnits).toBeLessThanOrEqual(
      OUTPUT_BUDGET_UNITS_CAP,
    );
    expect(huge.eligible).toBe(true);
    expect(huge.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "budget.maxTurns", status: "warn" }),
      ]),
    );
    for (const res of [small, mid, huge]) {
      expect(res.card.budget.relativeUnits).toBe(
        outputBudgetFor(res.card).units,
      );
    }
  });

  it("RU 总上限：三轮次加三能力触发 100 钳制，钳制理由进入预算口径", () => {
    const verdict = outputBudgetFor({
      budget: { maxTurns: 999 },
      capabilityHints: ["browser", "gui", "filesystem"],
    });

    expect(verdict.maxTurns).toBe(PREVIEW_MAX_TURNS_CAP);
    expect(verdict.units).toBe(OUTPUT_BUDGET_UNITS_CAP);
    expect(verdict.units).toBe(100);
    expect(verdict.clamped).toBe(true);
    expect(verdict.reasons).toContain(
      "相对预算 104 RU 超过上限 100 RU，已钳制为 100 RU",
    );

    const preview = buildPreview({
      goal: "钳制口径",
      cadence: "daily",
      params: { capabilityId: "browser", maxTurns: "999" },
    });
    expect(preview.card.budget.relativeUnits).toBe(
      outputBudgetFor(preview.card).units,
    );
    expect(preview.card.budget.budgetBasis).toContain(
      "maxTurns=20 在轮次上限 20 内",
    );
    expect(preview.card.budget.budgetBasis).toContain(
      "能力 browser 计入 1 项附加预算（每项 8 RU）",
    );
  });
});
