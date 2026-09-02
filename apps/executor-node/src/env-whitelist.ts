/** SEC-01: child-process environment whitelist shared by the task execution
 *  and deployment paths. Only these variables are forwarded to spawned
 *  processes — executor secrets (EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET and
 *  every other process.env entry) must never leak into user-controlled code.
 */

export const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'NODE_PATH', 'npm_config_cache', 'npm_config_prefix',
  'TMPDIR', 'TEMP', 'TMP',
  'USER', 'LOGNAME', 'SHELL',
  'SYSTEMROOT', 'WINDIR', // Windows compat
  'COMSPEC', 'PATHEXT', // Windows compat
]);

/** Names that must never be forwarded even if someone adds them to the
 *  whitelist later — defense in depth against secret leakage. */
const SECRET_ENV_DENYLIST = new Set([
  'EXECUTOR_SHARED_TOKEN',
  'EXECUTOR_SECRET',
]);

/** Build a sanitized environment from process.env: whitelist only, secrets
 *  always stripped. Additional task/deployment-provided variables are merged
 *  on top (they are explicit, caller-controlled values). */
export function buildChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_DENYLIST.has(k)) continue;
    if (ENV_WHITELIST.has(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (SECRET_ENV_DENYLIST.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}
