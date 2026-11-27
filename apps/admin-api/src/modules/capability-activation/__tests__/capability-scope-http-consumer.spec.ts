/**
 * N19 消费者级反证（HTTP consumer boundary，单测/内存替身级）。
 *
 * 与 capability-scope-wiring.spec.ts 的分工：wiring 证明 service.record 收 scope
 * 后判拒零 save；本文件证明 **controller.record 真的把 ApiKeyUser.scope 喂给
 * service** ——绕过全局 guard，直接构造 req.user 调 controller，断言 repo 副作用。
 *
 * 端到端 HTTP 层 api-key-scope.util 已先行拦 readonly/trigger，gate 在真实
 * HTTP 链路上冗余；因此反证刻意落在 controller 边界：不经过 guard，闸本身
 * 是否有牙在此可证。
 *
 * 验收级别：单测 / 内存替身（真 controller + 真 service.record + 真 gate 纯实现，
 * 假 repo + 假 Nest 装饰器边界）；不证明 Nest 路由注册、guard 栈与真 PG 持久化。
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
    Req: deco,
    HttpCode: deco,
    SetMetadata: () => () => undefined,
    Injectable: deco,
    Inject: deco,
    Optional: deco,
    Logger: class {
      warn(): void {}
      log(): void {}
    },
  };
});
jest.mock("@nestjs/typeorm", () => ({
  InjectRepository: () => () => undefined,
}));
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
jest.mock("../../../common/decorators/write-guard.decorator", () => ({
  WriteGuard: () => () => undefined,
}));
jest.mock("../../../common/interfaces/auth-user.interface", () => ({
  // 真 type guard 逻辑（复制自 auth-user.interface.ts:42），使断言与生产判据同型。
  isApiKeyUser: (user: unknown): boolean =>
    !!user &&
    typeof user === "object" &&
    (user as { type?: unknown }).type === "apiKey",
}));
jest.mock("../../../common/errors/app-error", () => ({
  AppError: class extends Error {
    readonly errorCode: string;
    readonly params: Record<string, unknown> | null;
    constructor(code: string, params?: Record<string, unknown> | null) {
      super(`${code}: ${params?.reason ?? params?.detail ?? ""}`);
      this.errorCode = code;
      this.params = params ?? null;
    }
  },
}));
jest.mock("../../../common/errors/error-codes", () => ({
  ErrorCode: { RATE_LIMITED: "RATE_LIMITED" },
}));
jest.mock("../quota.service", () => ({ QuotaService: class {} }));
jest.mock("../../users/entities/user.entity", () => ({
  UserRole: { ADMIN: "admin", USER: "user" },
}));
jest.mock("../entities/activation-log.entity", () => ({
  ACTIVATION_RESULTS: ["success", "failure", "blocked"],
  ACTIVATION_OUTCOMES: ["confirmed", "unconfirmed"],
  CapabilityActivationLog: class {},
}));
jest.mock("../../notification/notification.service", () => ({
  AlertChannel: { WEBHOOK: "webhook" },
  NotificationService: class {},
}));
// 裸 jest 无 reflect-metadata：pagination.dto 的 @Type 会炸，桩掉即可。
jest.mock("class-transformer", () => ({ Type: () => () => undefined }));

import { CapabilityActivationController } from "../capability-activation.controller";
import { CapabilityActivationService } from "../capability-activation.service";
import { capabilityScopeGate } from "../capability-scope.gate";
import type { CapabilityScopeGate } from "../capability-scope.gate";
import type { CreateActivationDto } from "../dto/create-activation.dto";

type Row = Record<string, unknown>;

function makeRepo() {
  const rows: Row[] = [];
  return {
    rows,
    create: jest.fn((dto: Record<string, unknown>): Row => ({ ...dto })),
    save: jest.fn(async (row: Row): Promise<Row> => {
      rows.push(row);
      return row;
    }),
    findAndCount: jest.fn(async (): Promise<[Row[], number]> => [[], 0]),
    createQueryBuilder: jest.fn(),
  };
}

/** 真 gate 纯实现 + spy 包装：既能断言「闸被调用/跳过」，判定仍走生产函数。 */
function gateWithSpy() {
  return {
    canInvokeWithScope: jest.fn(capabilityScopeGate.canInvokeWithScope),
    shouldDisableOnRevoke: jest.fn(capabilityScopeGate.shouldDisableOnRevoke),
  } satisfies CapabilityScopeGate;
}

function makeController(gate: CapabilityScopeGate) {
  const repo = makeRepo();
  const svc = new CapabilityActivationService(
    repo as never,
    undefined as never, // quota gate 缺席 → fail-open，本文件只测 scope 闸
    gate as never,
  );
  const controller = new CapabilityActivationController(svc, {} as never);
  return { controller, repo };
}

const dto = {
  capabilityKey: "finance-export",
  parameters: { a: 1 },
} as unknown as CreateActivationDto;

const keyUser = (scope: "readonly" | "trigger" | "manage") => ({
  type: "apiKey" as const,
  userId: 1,
  keyPrefix: "acf_n19",
  apiKeyId: 7,
  scope,
});
const jwtUser = {
  id: 2,
  username: "jwt-user",
  email: "jwt@example.com",
  role: "user",
  isActive: true,
};
const reqOf = (user: unknown) => ({ user }) as never;

describe("N19 · controller.record 把 ApiKeyUser.scope 喂进 scope gate", () => {
  it("① API Key scope=readonly → API_KEY_SCOPE_DENIED，repo 零 insert", async () => {
    const gate = gateWithSpy();
    const { controller, repo } = makeController(gate);
    await expect(
      controller.record(dto, reqOf(keyUser("readonly"))),
    ).rejects.toMatchObject({
      errorCode: "API_KEY_SCOPE_DENIED",
      params: { reason: expect.stringContaining("readonly + trigger") },
    });
    expect(gate.canInvokeWithScope).toHaveBeenCalledWith("readonly");
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(0);
  });

  it("② API Key scope=trigger → API_KEY_SCOPE_DENIED，repo 零 insert", async () => {
    const gate = gateWithSpy();
    const { controller, repo } = makeController(gate);
    await expect(
      controller.record(dto, reqOf(keyUser("trigger"))),
    ).rejects.toMatchObject({ errorCode: "API_KEY_SCOPE_DENIED" });
    expect(gate.canInvokeWithScope).toHaveBeenCalledWith("trigger");
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(0);
  });

  it("③ API Key scope=manage → repo 恰好 1 行，capabilityKey 匹配", async () => {
    const gate = gateWithSpy();
    const { controller, repo } = makeController(gate);
    const saved = await controller.record(dto, reqOf(keyUser("manage")));
    expect(gate.canInvokeWithScope).toHaveBeenCalledWith("manage");
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(1);
    expect(saved.capabilityKey).toBe(dto.capabilityKey);
    expect(repo.rows[0].capabilityKey).toBe(dto.capabilityKey);
  });

  it("④ JWT 会话主体（非 ApiKeyUser）→ 闸被跳过，repo 1 行（主链不回归）", async () => {
    const gate = gateWithSpy();
    const { controller, repo } = makeController(gate);
    const saved = await controller.record(dto, reqOf(jwtUser));
    expect(gate.canInvokeWithScope).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(1);
    expect(saved.capabilityKey).toBe(dto.capabilityKey);
  });
});
