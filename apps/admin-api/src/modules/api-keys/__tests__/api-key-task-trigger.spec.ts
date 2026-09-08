import { Test } from "@nestjs/testing";
import { ForbiddenException, UnauthorizedException, ExecutionContext } from "@nestjs/common";
import { ApiKeyAuth } from "../api-key-auth.helper";
import { ApiKeysService } from "../api-keys.service";
import { ApiKey, ApiKeyScope } from "../entities/api-key.entity";
import { hashApiKey } from "../api-key.util";
import { parseApiKeyScopes } from "../entities/api-key.entity";

/**
 * NF-01（迁移 1790000000005）：`task:trigger` 扩展域 guard 分流专项——
 * 在 AUTH-03 既有 ApiKeyAuth 校验链上叠加：
 *   - JWT 路径零改动（本分支只接 acf_ 前缀凭据，JWT 走 passport-jwt）；
 *   - 有效 key + task:trigger 词表 + POST tasks/<id>/trigger → 放行；
 *   - 无 task:trigger 词表的 readonly key 同端点 → 403（scope 提示）；
 *   - 无效 key → 401（防枚举统一文案）。
 */

const keyRow = (over: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 7,
    userId: 42,
    name: "ci-key",
    keyPrefix: "acf_dead",
    keyHash: hashApiKey("acf_deadbeef"),
    scope: "readonly" as ApiKeyScope,
    scopes: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...over,
  }) as ApiKey;

function makeContext(method: string, path: string) {
  const req: Record<string, any> = {
    method,
    path,
    url: `/${path}`,
    headers: { authorization: "Bearer acf_deadbeef" },
    ip: "10.0.0.9",
    user: undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("NF-01 ApiKeyAuth — task:trigger 扩展域分流", () => {
  let auth: ApiKeyAuth;
  let svc: { authenticate: jest.Mock; auditAuthFailure: jest.Mock };

  beforeEach(async () => {
    svc = {
      authenticate: jest.fn(),
      auditAuthFailure: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [ApiKeyAuth, { provide: ApiKeysService, useValue: svc }],
    }).compile();
    auth = moduleRef.get(ApiKeyAuth);
  });

  it("有效 key + scopes 含 task:trigger + POST tasks/<id>/trigger → 放行并挂 apiKey 主体", async () => {
    svc.authenticate.mockResolvedValue({
      apiKey: keyRow({ scopes: "task:trigger" }),
    });
    const ctx = makeContext("POST", "tasks/abc-123/trigger");
    await expect(auth.authenticate(ctx, "acf_deadbeef")).resolves.toBe(true);
    const req = (ctx.switchToHttp() as any).getRequest();
    expect(req.user).toMatchObject({
      type: "apiKey",
      userId: 42,
      apiKeyId: 7,
      scope: "readonly",
    });
  });

  it("有效 key 无 task:trigger 词表（纯 readonly）+ 同端点 → 403（scope 提示文案）", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: keyRow({ scopes: null }) });
    await expect(
      auth.authenticate(makeContext("POST", "tasks/abc-123/trigger"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("无效 key（未知/吊销）→ 401 统一文案（防枚举）+ auth_failure 审计", async () => {
    svc.authenticate.mockResolvedValue({ apiKey: null, failure: "revoked" });
    await expect(
      auth.authenticate(
        makeContext("POST", "tasks/abc-123/trigger"),
        "acf_deadbeef",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.auditAuthFailure).toHaveBeenCalledWith(
      "acf_dead",
      "revoked",
      "10.0.0.9",
    );
  });

  it("task:trigger 不扩写面：同 key POST tasks（非 trigger 端点）仍 403；批量触发仍 403", async () => {
    svc.authenticate.mockResolvedValue({
      apiKey: keyRow({ scopes: "task:trigger" }),
    });
    await expect(
      auth.authenticate(makeContext("POST", "tasks"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // 批量触发不在 isTaskTriggerPath 白名单（batch 非 task id）
    await expect(
      auth.authenticate(
        makeContext("POST", "tasks/batch/trigger"),
        "acf_deadbeef",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("task:trigger 不扩管理面：DELETE tasks/:id 与 JWT-only 面（api-keys）照旧拒绝", async () => {
    svc.authenticate.mockResolvedValue({
      apiKey: keyRow({ scopes: "task:trigger" }),
    });
    await expect(
      auth.authenticate(makeContext("DELETE", "tasks/abc-123"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      auth.authenticate(makeContext("GET", "api-keys"), "acf_deadbeef"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("NF-01 parseApiKeyScopes 词表解析", () => {
  it("null/空串/多空格/多词：词表解析健壮且与 util 导出一致", () => {
    expect(parseApiKeyScopes(null)).toEqual([]);
    expect(parseApiKeyScopes(undefined)).toEqual([]);
    expect(parseApiKeyScopes("")).toEqual([]);
    expect(parseApiKeyScopes("  task:trigger  ")).toEqual(["task:trigger"]);
    expect(parseApiKeyScopes("task:trigger   manage")).toEqual([
      "task:trigger",
      "manage",
    ]);
  });
});
