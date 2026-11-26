/**
 * N14 scopedRules commit 第五闸反证（内存替身级）。
 * 独立文件——既有 commit.spec.ts 一字不改；沿用其 jest.mock 隔框架风格。
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
import { buildPreview, currentPolicySnapshot } from "../preview-validator";
import type { ScopedRule } from "../scoped-rules";
import {
  synthesizeCommitScopedRules,
  WorkbenchController,
} from "../workbench.controller";

describe("Workbench commit — N14 scopedRules 追加闸（反证）", () => {
  const base = {
    goal: "汇总昨日订单异常并推送日报",
    cadence: "daily" as const,
  };
  const user = { id: 42, username: "alice" };
  const ip = "10.0.0.7";

  type Opts = {
    /** currentGeneration() 依次返回值：第 1 次供第四闸，第 2 次供第五闸。 */
    generations?: string[];
    /** 注入当前策略快照的显式规则面（未来下发形态）。 */
    scopedRules?: readonly ScopedRule[];
    /** 令快照形状非法，触发构造失败降级路径。 */
    brokenSnapshot?: boolean;
  };

  const makeController = (opts: Opts = {}) => {
    const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
    const record = jest.fn(async (dto: any) => ({ id: "act-1", ...dto }));
    const currentGeneration = jest.fn();
    for (const gen of opts.generations ?? []) {
      currentGeneration.mockResolvedValueOnce(gen);
    }
    const controller = new WorkbenchController(
      { draft } as any,
      { record } as any,
      { currentGeneration } as any,
      null,
    );
    if (opts.scopedRules !== undefined || opts.brokenSnapshot) {
      jest.spyOn(controller, "currentPolicySnapshot").mockReturnValue(
        opts.brokenSnapshot
          ? ({ policyVersion: "1", capabilityWhitelist: "broken" } as any)
          : ({
              ...currentPolicySnapshot(),
              scopedRules: opts.scopedRules,
            } as any),
      );
    }
    return { controller, draft, record, currentGeneration };
  };

  const dtoFor = (
    input: typeof base & { params?: Record<string, string> },
    generation: string,
  ) => {
    const preview = buildPreview(input as any);
    return {
      ...input,
      expectedCardHash: preview.cardHash,
      expectedPolicyGeneration: generation,
    };
  };

  afterEach(() => jest.restoreAllMocks());

  it("① 代际切换 + 通配 allow（卡未绑定能力）⇒ VALIDATION_FAILED，draft 零调用", async () => {
    const { controller, draft, currentGeneration } = makeController({
      generations: ["gen-old", "gen-new"],
    });
    const dto = dtoFor(base, "gen-old");
    let caught: unknown;
    try {
      await controller.commit(dto as any, user, ip);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as AppError).errorCode).toBe(ErrorCode.VALIDATION_FAILED);
    expect(String((caught as AppError).params?.detail)).toContain("通配授权");
    // 第四闸读一次、第五闸再读一次——两次之间 bump 才是本闸的拦截窗口。
    expect(currentGeneration).toHaveBeenCalledTimes(2);
    expect(draft).not.toHaveBeenCalled();
  });

  it("② 显式 ask/deny 随代际切换保留（不属通配 allow）⇒ 放行落库", async () => {
    const { controller, draft } = makeController({
      generations: ["gen-old", "gen-new"],
      scopedRules: [
        { resource: "browser", action: "open", decision: "ask" },
        { resource: "filesystem", action: "write", decision: "deny" },
      ],
    });
    const dto = dtoFor(base, "gen-old");
    const result = await controller.commit(dto as any, user, ip);
    expect(result.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("②b 精确 allow 随旧代际作废但非通配覆盖 ⇒ 放行落库", async () => {
    const input = { ...base, params: { capabilityId: "browser" } };
    const { controller, draft } = makeController({
      generations: ["gen-old", "gen-new"],
    });
    const dto = dtoFor(input, "gen-old");
    const result = await controller.commit(dto as any, user, ip);
    expect(result.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("③ 代际未变 + 通配 allow ⇒ 正常放行（既有 commit 行为不回归）", async () => {
    const { controller, draft } = makeController({
      generations: ["gen-old", "gen-old"],
    });
    const dto = dtoFor(base, "gen-old");
    const result = await controller.commit(dto as any, user, ip);
    expect(result.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("④ 规则集构造失败 ⇒ warn 放行（fail-open，与判定为空区分）", async () => {
    const { controller, draft } = makeController({
      generations: ["gen-old", "gen-new"],
      brokenSnapshot: true,
    });
    const dto = dtoFor(base, "gen-old");
    const result = await controller.commit(dto as any, user, ip);
    expect(result.status).toBe("draft");
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("⑤ 合成规则集：未绑定能力=通配 allow；白名单内=精确 allow；白名单外=ask", () => {
    const snapshot = currentPolicySnapshot();
    expect(
      synthesizeCommitScopedRules({ capabilityHints: [] }, snapshot),
    ).toEqual([
      {
        resource: "*",
        action: "*",
        decision: "allow",
        layer: "plan-card/wildcard",
      },
    ]);
    expect(
      synthesizeCommitScopedRules(
        { capabilityHints: ["browser", "bogus"] },
        snapshot,
      ),
    ).toEqual([
      {
        resource: "browser",
        action: "invoke",
        decision: "allow",
        layer: "plan-card/capability",
      },
      {
        resource: "bogus",
        action: "invoke",
        decision: "ask",
        layer: "plan-card/capability",
      },
    ]);
  });
});
