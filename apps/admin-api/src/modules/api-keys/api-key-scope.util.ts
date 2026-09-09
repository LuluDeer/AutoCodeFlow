import { ApiKeyScope } from "./entities/api-key.entity";

/**
 * AUTH-03: scope enforcement matrix — pure decision layer so tests can drive
 * every method × scope combination without HTTP.
 *
 * - `readonly`: all GET/HEAD/OPTIONS.
 * - `trigger`: readonly + POST task trigger endpoints
 *   (`/tasks/:id/trigger`, `/tasks/batch/trigger`).
 * - `manage`: everything else (all non-excluded writes).
 *
 * Exclusions are enforced BEFORE the guard even runs: the ApiKey branch of
 * JwtAuthGuard refuses to authenticate on JWT-only surfaces (see
 * JWT_ONLY_API_KEY_PATHS in jwt-auth.guard.ts), so no scope here can ever
 * reach /api-keys management or /auth/* endpoints.
 */

/** Write methods an API Key may attempt at all (beyond read methods). */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ScopeRequest {
  method: string;
  /** Normalized request path with the global `api` prefix stripped
   *  (e.g. `tasks/<uuid>/trigger`). Query string must be removed. */
  path: string;
}

/** POST paths an API Key with `trigger` scope may call. */
export const TRIGGER_PATHS: readonly string[] = ["tasks/batch/trigger"];

/** True when path matches `tasks/<id>/trigger` (any task id shape). */
export function isTaskTriggerPath(path: string): boolean {
  // `batch` is not a task id — the batch trigger is whitelisted explicitly.
  return /^tasks\/(?!batch\b)[^/]+\/trigger$/.test(path);
}

/**
 * Decide whether an API-Key-authenticated request is allowed by its scope.
 * Returns `true` (allow) or a Chinese denial reason carrying the required
 * scope (surfaced as the 403 message by the guard).
 */
export function scopeAllows(
  scope: ApiKeyScope,
  req: ScopeRequest,
): { allowed: boolean; reason?: string } {
  const method = req.method.toUpperCase();
  const path = req.path.replace(/^\/+|\/+$/g, "");

  // Read methods: every scope may pass.
  if (!WRITE_METHODS.has(method)) return { allowed: true };

  // From here on this is a write.
  if (scope === "manage") return { allowed: true };

  const isTriggerWrite =
    method === "POST" &&
    (TRIGGER_PATHS.includes(path) || isTaskTriggerPath(path));
  if (!isTriggerWrite) {
    // Non-trigger write.
    if (scope === "readonly") {
      return {
        allowed: false,
        reason: `当前 API Key scope 为 readonly（只读），不允许 ${method} 写操作；需要 manage 或 trigger（仅限任务触发）`,
      };
    }
    // trigger scope hitting a non-trigger write.
    return {
      allowed: false,
      reason: `当前 API Key scope 为 trigger（只读+任务触发），不允许 ${method} ${path} 写操作；需要 manage`,
    };
  }

  // Trigger write with trigger scope: allowed.
  if (scope === "trigger") return { allowed: true };

  // Trigger write with readonly scope.
  return {
    allowed: false,
    reason: `当前 API Key scope 为 readonly（只读），不允许 ${method} 写操作；需要 manage 或 trigger（仅限任务触发）`,
  };
}
