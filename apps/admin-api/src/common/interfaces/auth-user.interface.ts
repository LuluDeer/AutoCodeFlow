import { UserRole } from "../../modules/users/entities/user.entity";
import { ApiKeyScope } from "../../modules/api-keys/entities/api-key.entity";

/**
 * Shape of the authenticated user injected into request by JwtStrategy.validate().
 * Matches the User entity fields returned by UsersService.findById().
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  /**
   * A-2（R3-A 审计）: 会话 id —— 该 access token 所属登录会话的 refresh
   * jti（签发侧 generateTokens 写入 sid claim，validate() 透传到 req.user）。
   * 会话管理端点（listSessions / revokeOtherSessions）据此识别「当前设备」；
   * sse_ticket 与存量无 sid claim 的旧令牌为 undefined（消费侧按 null 处理，
   * fail-safe 语义不变）。
   */
  sid?: string;
}

/**
 * AUTH-03: shape of the authenticated principal injected by the API-Key
 * branch of JwtAuthGuard. Distinct `type` marker so controllers/RolesGuard
 * can tell machine credentials from interactive JWT sessions.
 */
export interface ApiKeyUser {
  type: "apiKey";
  userId: number;
  /** Display prefix of the key, for audit trails. */
  keyPrefix: string;
  apiKeyId: number;
  scope: ApiKeyScope;
}

/** req.user union across both auth paths (JWT session vs API Key). */
export type RequestUser = AuthUser | ApiKeyUser;

/** Type guard: is this principal a limited API Key (machine credential)? */
export function isApiKeyUser(user: unknown): user is ApiKeyUser {
  return (
    !!user &&
    typeof user === "object" &&
    (user as { type?: unknown }).type === "apiKey"
  );
}
