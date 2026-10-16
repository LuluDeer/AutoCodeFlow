import { ExecutionContext, Injectable } from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上。
import { AppError } from "../../common/errors/app-error";
import {
  ApiKeyAuthFacade,
  extractBearerCredential,
  isJwtOnlyPath,
  normalizeApiPath,
} from "../../common/guards/jwt-auth.guard";
import { isApiKeyUser } from "../../common/interfaces/auth-user.interface";
import { ApiKeysService } from "./api-keys.service";
import { scopeAllows, isTaskTriggerPath } from "./api-key-scope.util";
import { parseApiKeyScopes } from "./entities/api-key.entity";

/**
 * AUTH-03: API-Key authentication + scope enforcement, injected into the
 * global JwtAuthGuard as the `acf_`-prefix branch.
 *
 * Validation chain (all failures are 401 with a uniform message — no
 * oracle distinguishing unknown keys from revoked/expired ones on the wire;
 * the precise reason goes to the audit log only):
 *   1. JWT-only surface check (api-keys/auth/users) → 401, never a scope
 *      question — a leaked key cannot manage credentials.
 *   2. sha256 lookup (unknown → fail).
 *   3. revokedAt set → fail (revocation is immediate).
 *   4. expiresAt past → fail.
 *   5. scope enforcement over method+path (readonly/trigger/manage) → 403
 *      with a scope-naming message (this one IS distinguishable, by design:
 *      the credential itself is valid).
 *   6. success → req.user = { type:'apiKey', userId, keyPrefix, apiKeyId,
 *      scope }; lastUsedAt throttled-refresh + audit handled by the service.
 */
@Injectable()
export class ApiKeyAuth implements ApiKeyAuthFacade {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  async authenticate(
    context: ExecutionContext,
    credential: string,
  ): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const ip = typeof req?.ip === "string" ? req.ip : null;
    const path = normalizeApiPath(req);

    // 1. JWT-only surfaces — API Keys are refused before any lookup.
    if (isJwtOnlyPath(path)) {
      throw new AppError("API_KEY_JWT_ONLY_SURFACE");
    }

    const { apiKey, failure } =
      await this.apiKeysService.authenticate(credential);
    if (!apiKey) {
      try {
        await this.apiKeysService.auditAuthFailure(
          credential.slice(0, 8),
          failure ?? "unknown",
          ip,
        );
      } catch {
        // audit is fail-open inside the service; double guard here anyway
      }
      // Uniform 401 — no oracle for unknown vs expired vs revoked.
      throw new AppError("API_KEY_INVALID");
    }

    // 5. Scope enforcement (method × path matrix, pure decision layer).
    const method = req?.method ?? "GET";
    let verdict = scopeAllows(apiKey.scope, { method, path });
    // NF-01: `task:trigger` extra scope — a narrow domain layered on top of
    // the legacy matrix. It ONLY lifts a denial that falls on a single-task
    // trigger POST (tasks/<id>/trigger); it never widens reads (already
    // open to every scope) or any other write.
    if (
      !verdict.allowed &&
      method.toUpperCase() === "POST" &&
      isTaskTriggerPath(path) &&
      parseApiKeyScopes(apiKey.scopes).includes("task:trigger")
    ) {
      verdict = { allowed: true };
    }
    if (!verdict.allowed) {
      // `verdict.reason` 由 api-key-scope.util 生成的**已成型中文说明**
      // （含 method/path 与所需 scope，是该 util 的既有对外文案）。此处作为
      // 参数原样透传：码负责可翻译的「权限不足」外壳，具体所需 scope 属
      // 结构化诊断信息，且 util 归另一 workstream 所有，不在此改写其文案。
      throw new AppError("API_KEY_SCOPE_DENIED", { reason: verdict.reason });
    }

    req.user = {
      type: "apiKey" as const,
      userId: apiKey.userId,
      keyPrefix: apiKey.keyPrefix,
      apiKeyId: apiKey.id,
      scope: apiKey.scope,
    };
    return true;
  }
}

export { isApiKeyUser, extractBearerCredential };
