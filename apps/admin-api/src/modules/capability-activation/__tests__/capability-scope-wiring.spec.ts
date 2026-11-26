/**
 * N19 接线反证：capability-activation.service.record 的 scope 闸。
 *
 * 验收级别：单测 / 内存替身——证明 scope 判拒零 save、缺席兼容、内部调用
 * （无 key 上下文）放行；不代表真 PG 持久化与 Nest DI 集成。
 *
 * 与本目录既有 spec 同款：jest.mock 掉 Nest/TypeORM 框架边界。裸 jest 下
 * @nestjs/common 是 ESM，必须 mock。
 */
jest.mock("@nestjs/common", () => {
  const deco =
    () =>
    (..._args: unknown[]): void =>
      undefined;
  return {
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

import { CapabilityActivationService } from "../capability-activation.service";
import type { CapabilityScopeGate } from "../capability-scope.gate";

function makeRepo() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    create: jest.fn((dto: Record<string, unknown>) => ({ ...dto })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      rows.push(row);
      return row;
    }),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(),
  };
}

function svcOf(
  repo: ReturnType<typeof makeRepo>,
  scopeGate?: CapabilityScopeGate,
): CapabilityActivationService {
  // 第 2 参（quota gate）保持 undefined，第 3 参才是 scope gate——验证
  // 「追加到末尾」的定位参数兼容：既有装配不因新参数静默错位。
  return new CapabilityActivationService(
    repo as never,
    undefined as never,
    scopeGate as never,
  );
}

const dto = { capabilityKey: "finance-export", parameters: { a: 1 } };

describe("N19 接线 · record scope 闸", () => {
  it("① gate 判拒（携带 scope）→ 抛 API_KEY_SCOPE_DENIED，零 save 零 create", async () => {
    const repo = makeRepo();
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => false),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    await expect(
      svcOf(repo, gate).record(dto, ["readonly"]),
    ).rejects.toMatchObject({
      errorCode: "API_KEY_SCOPE_DENIED",
      params: { reason: expect.stringContaining("readonly + trigger") },
    });
    expect(gate.canInvokeWithScope).toHaveBeenCalledWith(["readonly"]);
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(0);
  });

  it("② gate 放行（携带 scope）→ 正常落库一行", async () => {
    const repo = makeRepo();
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    const saved = await svcOf(repo, gate).record(dto, ["readonly", "trigger"]);
    expect(saved.result).toBe("success");
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(1);
  });

  it("③ 内部调用（无 key 上下文/不传 scope）→ 不触发 gate，行为逐字不变", async () => {
    const repo = makeRepo();
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => false),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    const saved = await svcOf(repo, gate).record(dto);
    expect(saved.result).toBe("success");
    expect(gate.canInvokeWithScope).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it("④ gate 缺席（@Optional）→ 即使传 scope 也放行，跳过判定", async () => {
    const repo = makeRepo();
    const saved = await svcOf(repo).record(dto, ["readonly"]);
    expect(saved.result).toBe("success");
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.rows).toHaveLength(1);
  });

  it("⑤ manage 词经 Gate 放行语义：判定输入是调用方词集原样透传", async () => {
    const repo = makeRepo();
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    await svcOf(repo, gate).record(dto, "manage");
    expect(gate.canInvokeWithScope).toHaveBeenCalledWith("manage");
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});
