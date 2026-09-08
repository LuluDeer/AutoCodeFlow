import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  API_KEY_AUTH_FACADE,
  ApiKeyAuthFacade,
  extractBearerCredential,
  isJwtOnlyPath,
  normalizeApiPath,
} from "../../common/guards/jwt-auth.guard";
import { isApiKeyUser } from "../../common/interfaces/auth-user.interface";
import { ApiKeysService } from "./api-keys.service";
import { scopeAllows } from "./api-key-scope.util";

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
      throw new UnauthorizedException(
        "API Keys are not accepted on credential management endpoints; use a user JWT",
      );
    }

    const { apiKey, failure } = await this.apiKeysService.authenticate(credential);
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
      throw new UnauthorizedException("Invalid or expired API key");
    }

    // 5. Scope enforcement (method × path matrix, pure decision layer).
    const verdict = scopeAllows(apiKey.scope, {
      method: req?.method ?? "GET",
      path,
    });
    if (!verdict.allowed) {
      throw new ForbiddenException(verdict.reason);
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
