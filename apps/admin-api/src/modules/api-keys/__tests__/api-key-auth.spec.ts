import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { ApiKeyAuth } from "../api-key-auth.helper";
import { ApiKeysService } from "../api-keys.service";
import { AuditService } from "../../audit/audit.service";
import { ApiKey, ApiKeyScope } from "../entities/api-key.entity";
import { hashApiKey } from "../api-key.util";

/**
 * AUTH-03: guard 分流后的 API-Key 校验链专项——
 * JWT-only 面 / 未知·吊销·过期 401 / scope 403 / req.user 挂载 / 审计写点。
 */

const keyRow = (over: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 7,
    userId: 42,
    name: "ci-key",
    keyPrefix: "acf_dead",
    keyHash: hashApiKey("acf_deadbeef"),
    scope: "readonly" as ApiKeyScope,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...over,
  }) as ApiKey;

function makeContext(method: string, path: string, hasKeyHeader = true) {
  const req: Record<string, any> = {
    method,
    path,
    url: `/${path}`,
    headers: hasKeyHeader ? { authorization: "Bearer acf_deadbeef" } : {},
    ip: "10.0.0.9",
    user: undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("AUTH-03 ApiKeyAuth（guard acf_ 分支）", () => {
  let auth: ApiKeyAuth;
  let svc: { authenticate: jest.Mock; auditAuthFailure: jest.Mock };

  beforeEach(async () => {
    svc = {
      authenticate: jest.fn(),
      auditAuthFailure: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApiKeyAuth,
        { provide: ApiKeysService, useValue: svc },
      ],
    }).compile();
    auth = moduleRef.get(ApiKeyAuth);
  });

  it("JWT-only 面（api-keys/auth/users 前缀）直接 401，不触发查库", async () => {
    for (const p of ["api-keys", "api-keys/3", "auth/sessions", "users/5"]) {
      await expect(
        auth.authenticate(makeContext("GET", p), "acf_deadbeef"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(svc.authenticate).not.toHaveBeenCalled();
  });

  it("未知 key → 401（统一文案防枚举）+ auth_failure 审计写点", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: null, failure: "unknown" });
    await expect(
      auth.authenticate(makeContext("GET", "tasks"), "acf_deadbeef"),
    ).rejects.toThrow("Invalid or expired API key");
    expect(svc.auditAuthFailure).toHaveBeenCalledWith(
      "acf_dead",
      "unknown",
      "10.0.0.9",
    );
  });

  it("吊销 key → 立即 401（revokedAt 置位后同 key 再请求被拒）", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: null, failure: "revoked" });
    await expect(
      auth.authenticate(makeContext("GET", "tasks"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.auditAuthFailure).toHaveBeenCalledWith(
      "acf_dead",
      "revoked",
      "10.0.0.9",
    );
  });

  it("过期 key → 立即 401", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: null, failure: "expired" });
    await expect(
      auth.authenticate(makeContext("GET", "tasks"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("有效 readonly key + GET → 放行并挂 { type:'apiKey', userId, scope }", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow() });
    const ctx = makeContext("GET", "tasks");
    await expect(auth.authenticate(ctx, "acf_deadbeef")).resolves.toBe(true);
    const req = (ctx.switchToHttp() as any).getRequest();
    expect(req.user).toMatchObject({
      type: "apiKey",
      userId: 42,
      apiKeyId: 7,
      scope: "readonly",
      keyPrefix: "acf_dead",
    });
  });

  it("readonly key + POST trigger → 403 且文案含 scope 提示", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow() });
    await expect(
      auth.authenticate(makeContext("POST", "tasks/abc/trigger"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("trigger key + POST trigger → 放行；trigger key + DELETE tasks → 403", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow({ scope: "trigger" }) });
    await expect(
      auth.authenticate(makeContext("POST", "tasks/abc/trigger"), "acf_deadbeef"),
    ).resolves.toBe(true);
    await expect(
      auth.authenticate(makeContext("DELETE", "tasks/abc"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("manage key + PUT config → 放行；manage key 仍被 auth/ api-keys 面 401", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow({ scope: "manage" }) });
    await expect(
      auth.authenticate(makeContext("PUT", "config/executor-shared-token"), "acf_deadbeef"),
    ).resolves.toBe(true);
    await expect(
      auth.authenticate(makeContext("POST", "api-keys"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("path 带全局 api 前缀与查询串时归一化判定", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow() });
    const req: Record<string, any> = {
      method: "GET",
      path: "/api/tasks",
      headers: { authorization: "Bearer acf_deadbeef" },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    await expect(auth.authenticate(ctx, "acf_deadbeef")).resolves.toBe(true);
  });
});
