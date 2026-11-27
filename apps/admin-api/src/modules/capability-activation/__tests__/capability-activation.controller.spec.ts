/**
 * N20：capability-activation controller 的 showback 子路由委托单测。
 *
 * 验收级别：单测（框架装饰器 mock，只验证路由方法把入参正确转交给 service；
 * 不证明 Nest 路由注册/JwtAuthGuard/RolesGuard 的真实运行）。
 */
jest.mock("@nestjs/common", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    Controller: deco,
    Get: deco,
    Post: deco,
    Put: deco,
    Body: deco,
    Query: deco,
    HttpCode: deco,
    Optional: deco,
    // AppError extends HttpException（PriceService 校验失败经它抛）；替身需提供基类
    HttpException: class HttpException extends Error {},
    SetMetadata: () => () => undefined,
  };
});
jest.mock("@nestjs/swagger", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
    ApiProperty: deco,
    ApiPropertyOptional: deco,
    ApiBearerAuth: deco,
    ApiOkResponse: deco,
    ApiOperation: deco,
    ApiTags: deco,
    ApiQuery: deco,
  };
});
jest.mock("../../../common/decorators/roles.decorator", () => ({
  Roles: () => () => undefined,
}));
jest.mock("../quota.service", () => ({
  QuotaService: class {},
}));
jest.mock("../capability-activation.service", () => ({
  CapabilityActivationService: class {},
  parametersDigest: () => "",
  stableStringify: () => "",
}));
jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin" },
}));
jest.mock("../entities/activation-log.entity", () => ({
  ACTIVATION_RESULTS: ["success", "failure", "blocked"],
  ACTIVATION_OUTCOMES: ["confirmed", "unconfirmed"],
}));
jest.mock("../../notification/notification.service", () => ({
  AlertChannel: { WEBHOOK: "webhook" },
  NotificationService: class {},
}));
// 裸 jest 无 reflect-metadata：pagination.dto 的 @Type 会炸，桩掉即可。
jest.mock("class-transformer", () => ({
  Type: () => () => undefined,
}));

// 成本归责依赖用轻量替身：本 spec 只测路由委托，不加载 PriceService 的
// SystemConfig→RedisLock 真依赖链（@nestjs/common 替身没有 Injectable 等）。
jest.mock("../price.service", () => ({
  PriceService: class {},
}));
jest.mock("../token-sample.port", () => ({
  TokenSamplePort: class {},
  createTokenSamplePort: () => ({}),
}));

import { CapabilityActivationController } from "../capability-activation.controller";
import type { CapabilityActivationService } from "../capability-activation.service";
import type { SetQuotaDto } from "../dto/quota.dto";
import type { QuotaService } from "../quota.service";

function makeController() {
  const svc = {
    record: jest.fn(),
    stats: jest.fn(),
    query: jest.fn(),
  };
  const quota = {
    upsert: jest.fn(),
    list: jest.fn(),
    status: jest.fn(),
  };
  const controller = new CapabilityActivationController(
    svc as unknown as CapabilityActivationService,
    quota as unknown as QuotaService,
  );
  return { controller, svc, quota };
}

describe("N20 · /capability-activation/quota* 路由委托", () => {
  const dto: SetQuotaDto = {
    scope: "project",
    target: "proj-a",
    softLimit: 10,
    hardLimit: 20,
    windowDays: 30,
  };

  it("PUT quota → quota.upsert(dto)", () => {
    const { controller, quota } = makeController();
    controller.upsertQuota(dto);
    expect(quota.upsert).toHaveBeenCalledWith(dto);
  });

  it("GET quota → quota.list()", () => {
    const { controller, quota } = makeController();
    controller.listQuotas();
    expect(quota.list).toHaveBeenCalledTimes(1);
  });

  it("GET quota-status → quota.status(windowDays)，缺省 30", () => {
    const { controller, quota } = makeController();
    controller.quotaStatus({ windowDays: 7 });
    controller.quotaStatus({});
    expect(quota.status.mock.calls).toEqual([[7], [30]]);
  });

  it("原 stats 路由仍委托 svc.stats（N20 未改既有口径）", () => {
    const { controller, svc } = makeController();
    controller.stats({ from: "2026-11-01T00:00:00.000Z" });
    expect(svc.stats).toHaveBeenCalledWith({
      from: "2026-11-01T00:00:00.000Z",
      to: undefined,
    });
  });
});
