/**
 * R90 真断点：commit 的发布审批三态诚实回带（单测 / 内存替身级）。
 *
 * 与 commit.spec.ts 同款 Nest 隔框架边界：框架替身，被测 controller /
 * 重建逻辑 / front-matter 校验 / sopContentHash 全是真代码，releaseApproval
 * 端口用内存替身模拟「成功 / 抛错 / 缺席」三条出口。
 *
 * 判据是**返回码 + draft 落库副作用**，不是日志文本：
 *   · requestRelease 成功 ⇒ submitted（带 approvalKey，happy path 不变）；
 *   · requestRelease 抛错（端口未装配 / 指纹不可读） ⇒ failed，draft 仍落、无 key；
 *   · releaseApproval 端口缺席或 user.username 缺失 ⇒ not_requested（非异常）。
 * 且生产路径不再回带硬编码中文 `next`。
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

import { buildPreview, computePolicyGeneration } from "../preview-validator";
import { WorkbenchController } from "../workbench.controller";

describe("Workbench commit — 发布审批三态（R90 诚实状态）", () => {
  const draft = jest.fn(async (input: any) => ({ id: "sop-1", ...input }));
  const user = { id: 42, username: "alice" };
  const ip = "10.0.0.7";
  const base = {
    goal: "汇总昨日订单异常并推送日报",
    cadence: "daily" as const,
  };
  const GEN = computePolicyGeneration();
  const input = {
    ...base,
    expectedCardHash: buildPreview(base).cardHash,
    expectedPolicyGeneration: GEN,
  };

  // 构造函数：sops, activation, generation, quotaGate, rewindRunner, partProjection,
  // releaseApproval —— 前六个按极简装配传 null，只拨最后一个端口。
  const makeController = (releaseApproval: any = null): WorkbenchController =>
    new WorkbenchController(
      { draft } as any,
      null,
      null,
      null,
      null,
      null,
      releaseApproval,
    );

  beforeEach(() => {
    draft.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => jest.clearAllMocks());

  it("requestRelease 成功 ⇒ submitted，approvalKey 仅此时有，draft 照常落库", async () => {
    const requestRelease = jest.fn(async () => ({
      approvalKey: "apr-1111",
      sessionId: "sess-1",
    }));
    const controller = makeController({ requestRelease });

    const result = await controller.commit(input, user, ip);

    expect(result.approvalStatus).toBe("submitted");
    expect(result.approvalKey).toBe("apr-1111");
    expect(result.status).toBe("draft");
    expect(result.sopId).toBe("sop-1");
    expect(result.policyGeneration).toBe(GEN);
    expect(result.next).toBeUndefined();
    expect(requestRelease).toHaveBeenCalledWith(
      expect.objectContaining({ sopId: "sop-1", username: "alice" }),
    );
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("requestRelease 抛错（策略指纹不可读） ⇒ failed，draft 仍落、无 key、warn 留痕", async () => {
    const requestRelease = jest.fn(async () => {
      throw new Error(
        "release-approval: 当前策略指纹不可读，发布申请被拒绝（fail-closed）",
      );
    });
    const controller = makeController({ requestRelease });
    const warn = jest.spyOn((controller as any).logger, "warn");

    const result = await controller.commit(input, user, ip);

    expect(result.approvalStatus).toBe("failed");
    expect(result.approvalKey).toBeUndefined();
    expect(result.status).toBe("draft");
    expect(result.sopId).toBe("sop-1");
    expect(result.next).toBeUndefined();
    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledTimes(1); // draft 不回滚
    expect(warn).toHaveBeenCalled();
  });

  it("releaseApproval 端口缺席 ⇒ not_requested（非异常），draft 照常落库", async () => {
    const controller = makeController(null);

    const result = await controller.commit(input, user, ip);

    expect(result.approvalStatus).toBe("not_requested");
    expect(result.approvalKey).toBeUndefined();
    expect(result.sopId).toBe("sop-1");
    expect(result.next).toBeUndefined();
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("无 username（非 USER 上下文） ⇒ not_requested，且绝不申请审批", async () => {
    const requestRelease = jest.fn(async () => ({
      approvalKey: "apr-should-not-happen",
      sessionId: "sess-2",
    }));
    const controller = makeController({ requestRelease });

    const result = await controller.commit(input, { id: 42 }, ip);

    expect(result.approvalStatus).toBe("not_requested");
    expect(result.approvalKey).toBeUndefined();
    expect(requestRelease).not.toHaveBeenCalled();
    expect(draft).toHaveBeenCalledTimes(1);
  });
});
