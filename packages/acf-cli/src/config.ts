#!/usr/bin/env node
/**
 * Persistent config store for the ACF CLI.
 * Stores API URL and tokens in the user's config directory.
 *
 * SEC-NEW-4 (SEC-01 v2 / N-SEC01-v2-1): the on-disk store holds BOTH the
 * short-lived access token and the long-lived refresh token, so at-rest
 * protection matters. Node has no cross-platform OS keyring (unlike Electron's
 * safeStorage — see ADR-012; acf-cli is plain Node, not Electron), so the CLI
 * cannot encrypt at rest without pulling a native keytar dependency. The chosen
 * minimum posture — explicitly allowed by docs/SEC-01-复审报告.md §四 — is:
 *   1. the config file is created with 0600 (owner read/write only), and any
 *      legacy group/world-readable file is repaired to 0600 on load;
 *   2. credentials can be injected per-invocation via ACF_TOKEN /
 *      ACF_REFRESH_TOKEN (URL via ACF_API_URL) without ever touching disk —
 *      the recommended mode for CI / cron (see README "CLI 工具 (acf)").
 */
import Conf from 'conf';
import * as fs from 'fs';

interface AcfConfig {
  apiUrl: string;
  token: string;
  refreshToken: string;
}

/** Owner-only (rw-------). Mirrors the private-credential intent of ADR-012. */
const CONFIG_FILE_MODE = 0o600;

/**
 * Optional config-directory override (absolute path). Confined to tests and
 * air-gapped CI, where ~/.config may be read-only or shared; unset in normal
 * interactive use so conf keeps resolving the platform default directory.
 */
const configDir = process.env.ACF_CONFIG_DIR;

/**
 * Construct the config store. conf applies `configFileMode` while *writing* the
 * defaults-bearing file at construction time; on platforms where that chmod is
 * unsupported or momentarily blocked (Windows ACL semantics, parallel-load disk
 * contention in tests, read-only mounts) the constructor can throw. Fall back to
 * a mode-less store rather than crashing the CLI — `hardenConfigPermissions()`
 * repairs the on-disk mode separately when the platform allows it.
 */
function createStore(): Conf<AcfConfig> {
  const base = {
    projectName: 'acf-cli',
    ...(configDir ? { cwd: configDir } : {}),
    defaults: {
      apiUrl: 'http://localhost:3105',
      token: '',
      refreshToken: '',
    },
  };
  try {
    return new Conf<AcfConfig>({ ...base, configFileMode: CONFIG_FILE_MODE });
  } catch {
    return new Conf<AcfConfig>(base);
  }
}

const store = createStore();

/** Absolute path of the on-disk config file (diagnostics / tests / showConfig). */
export function getConfigPath(): string {
  return store.path;
}

/**
 * SEC-NEW-4: best-effort hardening of an existing config file to owner-only
 * permissions. conf applies `configFileMode` when it *writes*, but it never
 * rewrites a file it only *reads* — so installs created before this change keep
 * their 0666/0644 mode unless we chmod once here (the store constructor does
 * write a defaults-bearing file, so a fresh install is already 0600).
 * Never throws: the chmod can legitimately fail (Windows ACL semantics,
 * read-only mounts) and must not break the CLI. Credentials are never moved or
 * deleted by this repair — only the file mode changes.
 */
export function hardenConfigPermissions(): void {
  try {
    if (!fs.existsSync(store.path)) return;
    if ((fs.statSync(store.path).mode & 0o777) !== CONFIG_FILE_MODE) {
      fs.chmodSync(store.path, CONFIG_FILE_MODE);
    }
  } catch {
    // best-effort: leave the file as-is when the platform refuses the chmod.
  }
}

// Run once at module load so every CLI invocation repairs a stale mode.
hardenConfigPermissions();

export function getApiUrl(): string {
  return process.env.ACF_API_URL || store.get('apiUrl');
}

export function getToken(): string {
  return process.env.ACF_TOKEN || store.get('token');
}

export function getRefreshToken(): string {
  return process.env.ACF_REFRESH_TOKEN || store.get('refreshToken');
}

export function setApiUrl(url: string): void {
  store.set('apiUrl', url);
}

export function setToken(token: string): void {
  store.set('token', token);
}

export function setRefreshToken(token: string): void {
  store.set('refreshToken', token);
}

/**
 * BUG-13: 刷新彻底失败（refresh token 也已过期/被轮换掉）时清除本地凭据，
 * 后续请求返回到「未登录」状态——避免拿着必死 token 反复打 401。
 * apiUrl 保留（用户环境不丢）。
 */
export function clearAuth(): void {
  store.set('token', '');
  store.set('refreshToken', '');
}

export function showConfig(): void {
  console.log('API URL :', getApiUrl());
  console.log('Token   :', getToken() ? '[set]' : '[not set]');
  console.log('Refresh :', getRefreshToken() ? '[set]' : '[not set]');
  console.log('Config file:', store.path);
}
