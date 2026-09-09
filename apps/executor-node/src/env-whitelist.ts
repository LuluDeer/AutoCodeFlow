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
  // R-04 (windows-findings): Windows home/identity vars. A detached Windows
  // deployment (scheduled task / service) has no HOME — without USERPROFILE/
  // HOMEDRIVE+HOMEPATH the child's os.homedir()/pathlib.Path.home() degrade
  // to '~', breaking pip/npm caches, git config, and getpass.getuser()
  // (KeyError: USERNAME). Same disclosure class as the already-forwarded
  // USER/LOGNAME/HOME on POSIX — these are paths, not secrets.
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData',
]);

/** Names that must never be forwarded even if someone adds them to the
 *  whitelist later — defense in depth against secret leakage. */
const SECRET_ENV_DENYLIST = new Set([
  'EXECUTOR_SHARED_TOKEN',
  'EXECUTOR_SECRET',
  // N23: HMAC source secret for per-execution callback tokens. The child
  // only ever receives the derived, execution-bound, expiring token
  // (AUTOFLOW_CALLBACK_TOKEN, injected explicitly in execute.ts).
  'EXECUTION_CALLBACK_SECRET',
]);

/** Build a sanitized environment from process.env: whitelist only, secrets
 *  always stripped. Additional task/deployment-provided variables are merged
 *  on top (they are explicit, caller-controlled values).
 *
 *  W-20 (windows CI, first windows-latest run): Windows environment blocks
 *  are case-INsensitive and the OS/launchers spell these keys their own way
 *  (`Path`, `Temp`, `ComSpec`, `APPDATA`…). An exact-key whitelist match
 *  silently dropped them, so the child received no PATH under the canonical
 *  name — every PATH-dependent task (npm/git/node resolution) broke on real
 *  Windows hosts, and the CI run proved it where Git-Bash had masked it.
 *  On win32 we therefore match case-insensitively and re-forward under the
 *  whitelist's canonical (upper-case) spelling. POSIX envs are
 *  case-sensitive — exact matching preserved there. */
export function buildChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const win32 = process.platform === 'win32';
  const canonical = (k: string): string | undefined => {
    if (!win32) return ENV_WHITELIST.has(k) ? k : undefined;
    const up = k.toUpperCase();
    for (const w of ENV_WHITELIST) {
      if (w.toUpperCase() === up) return w;
    }
    return undefined;
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_DENYLIST.has(win32 ? k.toUpperCase() : k)) continue;
    const key = canonical(k);
    if (key !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (SECRET_ENV_DENYLIST.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}
