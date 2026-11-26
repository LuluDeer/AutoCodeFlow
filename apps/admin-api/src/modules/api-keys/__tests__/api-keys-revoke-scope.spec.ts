/**
 * N19 接线反证：api-keys.service.revoke 后的能力停用联动判定。
 *
 * 验收级别：单测 / 真 Nest DI + 内存 repo 替身——证明联动判定被调用、
 * 审计留痕只记判定不停用能力、gate 缺席与幂等重吊销行为不变。
 */
import type { Provider } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ApiKeysService } from "../api-keys.service";
import { AuditService } from "../../audit/audit.service";
import { UsersService } from "../../users/users.service";
import { ApiKey } from "../entities/api-key.entity";
import {
  CAPABILITY_SCOPE_GATE,
  type CapabilityScopeGate,
} from "../../capability-activation/capability-scope.gate";

const repoMock = () => ({
  findOne: jest.fn(),
  update: jest.fn(async () => undefined),
  save: jest.fn(async (x) => x),
  create: jest.fn((x) => ({ id: 1, ...x })),
  find: jest.fn(async () => []),
  count: jest.fn(async () => 0),
  delete: jest.fn(async () => ({ affected: 1 })),
});
const auditMock = () => ({ log: jest.fn(async () => undefined) });
const usersMock = () => ({ findByIdOrNull: jest.fn(async () => null) });

async function svcWith(gate: CapabilityScopeGate | undefined) {
  const repo = repoMock();
  const audit = auditMock();
  const users = usersMock();
  const providers: Provider[] = [
    ApiKeysService,
    { provide: getRepositoryToken(ApiKey), useValue: repo },
    { provide: AuditService, useValue: audit },
    { provide: UsersService, useValue: users },
  ];
  if (gate) {
    providers.push({ provide: CAPABILITY_SCOPE_GATE, useValue: gate });
  }
  const moduleRef = await Test.createTestingModule({
    providers,
  }).compile();
  return { svc: moduleRef.get(ApiKeysService), repo, audit };
}

const activeRow = () => ({
  id: 9,
  userId: 42,
  name: "k",
  keyPrefix: "acf_aa",
  scope: "trigger",
  revokedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: new Date(0),
});

describe("N19 接线 · revoke 能力停用联动", () => {
  it("① revoke 写 revokedAt 后调用 shouldDisableOnRevoke(revokedAt)，判 true 写审计", async () => {
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    const { svc, repo, audit } = await svcWith(gate);
    repo.findOne.mockResolvedValueOnce(activeRow());

    const row = await svc.revoke(9, 42, "alice");

    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(gate.shouldDisableOnRevoke).toHaveBeenCalledTimes(1);
    expect(gate.shouldDisableOnRevoke).toHaveBeenCalledWith(row.revokedAt);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apikey.revoke.capability-disable-decision",
        resourceId: "9",
        detail: expect.objectContaining({
          shouldDisable: true,
          note: expect.stringContaining("真实停用由主控裁决是否接"),
        }),
      }),
    );
  });

  it("② 联动判定返回 false → 不写停用决策审计", async () => {
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => false),
    };
    const { svc, repo, audit } = await svcWith(gate);
    repo.findOne.mockResolvedValueOnce(activeRow());

    await svc.revoke(9, 42);

    expect(gate.shouldDisableOnRevoke).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apikey.revoke.capability-disable-decision",
      }),
    );
  });

  it("③ gate 缺席（@Optional）→ 跳过联动，revoke 行为逐字不变", async () => {
    const { svc, repo, audit } = await svcWith(undefined);
    repo.findOne.mockResolvedValueOnce(activeRow());

    const row = await svc.revoke(9, 42);

    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apikey.revoke", resourceId: "9" }),
    );
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apikey.revoke.capability-disable-decision",
      }),
    );
  });

  it("④ 幂等重吊销（已 revokedAt）→ 不重复触发联动判定", async () => {
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => true),
    };
    const { svc, repo, audit } = await svcWith(gate);
    repo.findOne.mockResolvedValueOnce({
      ...activeRow(),
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await svc.revoke(9, 42);

    expect(gate.shouldDisableOnRevoke).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("⑤ 联动判定抛错 → fail-open，不阻断 revoke 主链", async () => {
    const gate: CapabilityScopeGate = {
      canInvokeWithScope: jest.fn(() => true),
      shouldDisableOnRevoke: jest.fn(() => {
        throw new Error("gate down");
      }),
    };
    const { svc, repo } = await svcWith(gate);
    repo.findOne.mockResolvedValueOnce(activeRow());

    const row = await svc.revoke(9, 42);

    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(repo.update).toHaveBeenCalledWith(
      { id: 9 },
      { revokedAt: expect.any(Date) },
    );
  });
});
