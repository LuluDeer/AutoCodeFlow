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
import chalk from 'chalk';

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
 *
 * UX 打磨（本轮）：mode-less 兜底仍失败时只有两种现实解释——
 *  1. 配置文件损坏（conf 构造时反序列化，坏 JSON 直接抛裸 SyntaxError 堆栈，
 *     用户看不到任何可操作指引）；
 *  2. 存储位置读写不了（只读挂载等）。
 * 借 `deserialize` 钩子在 conf 抛出前把坏内容留证：确属损坏则备份坏内容、
 * 告警并携默认配置继续 CLI（凭据可从备份手工找回，或 acf login 重登）；
 * 否则抛出带指引的错误，替代 conf 内部堆栈。
 */
function createStore(): Conf<AcfConfig> {
  const base = {
    // ⚠ 刻意保持 'acf-cli'，**不随包名改成 '@autocodeflow/cli'**。
    // 这个值决定凭据文件的磁盘位置（如 ~/.config/acf-cli/config.json），
    // 而它是**用户机器上的持久状态**：改名会让既有用户下次运行时读不到旧配置，
    // 表现为"莫名掉登录"（access/refresh token 都还在旧目录里）。
    // 包名只是 npm 上的标识，与磁盘布局不必一致；新建目录带来的唯一收益是好看，
    // 代价却是每个已装用户重新登录一次。
    // 若将来确需迁移，必须配套"读旧目录 → 写新目录"的一次性搬迁，不能只改这里。
    projectName: 'acf-cli',
    ...(configDir ? { cwd: configDir } : {}),
    defaults: {
      apiUrl: 'http://localhost:3105',
      token: '',
      refreshToken: '',
    },
  };
  // conf 用 clearInvalidConfig 兜损坏时会「静默」返回空对象并在构造期把坏文件
  // 覆写成 defaults——凭据无提示丢失。因此不用它做常规路径，只在已留证坏内容
  // 之后的恢复存储上启用（那时覆写无妨，坏内容已在内存里）。
  let corruptRaw: string | null = null;
  const withDeserialize = {
    ...base,
    deserialize: (value: string): AcfConfig => {
      try {
        return JSON.parse(value) as AcfConfig;
      } catch {
        corruptRaw = value;
        throw new SyntaxError('config file is not valid JSON');
      }
    },
  };
  try {
    return new Conf<AcfConfig>({ ...withDeserialize, configFileMode: CONFIG_FILE_MODE });
  } catch {
    try {
      return new Conf<AcfConfig>(withDeserialize);
    } catch {
      if (corruptRaw === null) {
        // 反序列化没被触发 → 不是坏 JSON，而是存储位置本身读写不了。
        throw new Error(
          'Cannot initialize the CLI config store (permission or IO problem). ' +
            'Set ACF_CONFIG_DIR to a writable directory and retry.',
        );
      }
      // 损坏恢复：坏内容已留证；此时 conf 的常规构造必然再抛，改用
      // clearInvalidConfig 让这次构造成功（原文件被覆写也无妨），随后把
      // 留证内容写到 <path>.corrupt，用户随时可手工找回旧凭据。
      try {
        const recovered = new Conf<AcfConfig>({
          ...withDeserialize,
          configFileMode: CONFIG_FILE_MODE,
          clearInvalidConfig: true,
        });
        const backupPath = `${recovered.path}.corrupt`;
        try {
          fs.writeFileSync(backupPath, corruptRaw, { mode: CONFIG_FILE_MODE });
          process.stderr.write(
            chalk.yellow(
              `⚠ Config file is corrupted: ${recovered.path}\n` +
                '  (invalid JSON — the CLI cannot read its own credentials from it.)\n' +
                `  The previous content was preserved at ${backupPath}; inspect it if you need the old credentials.\n` +
                '  Continuing with default settings. Run "acf login" to sign in again.\n',
            ),
          );
        } catch {
          process.stderr.write(
            chalk.yellow(
              `⚠ Config file is corrupted: ${recovered.path} (invalid JSON), and the backup could not be written.\n` +
                '  Continuing with default settings. Run "acf login" to sign in again.\n',
            ),
          );
        }
        return recovered;
      } catch (err) {
        // 连恢复存储都建不出来（目录读写不了）：给出可操作指引而非裸堆栈。
        throw new Error(
          'Cannot initialize the CLI config store (permission or IO problem). ' +
            `Underlying error: ${err instanceof Error ? err.message : String(err)}. ` +
            'Set ACF_CONFIG_DIR to a writable directory and retry.',
        );
      }
    }
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
