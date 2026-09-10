import Store from 'electron-store';
import * as os from 'os';
import { app } from 'electron';
import * as path from 'path';
import { decryptToken, encryptToken, isValueEncrypted } from './token-crypto';

export interface AppConfig {
  configured: boolean;
  adminApiUrl: string;
  executorName: string;
  executorHost: string;
  executorPort: number;
  executorAddressPublic: string;
  executorToken: string;
  workDir: string;
  maxConcurrentTasks: number;
  autoStart: boolean;
  autoStartExecutor: boolean;
  /** DSK-04：系统通知开关（任务终态/执行器离线时弹系统通知）。 */
  notifyEnabled: boolean;
  logLevel: 'info' | 'debug' | 'error';
}

const schema = {
  configured: { type: 'boolean', default: false },
  adminApiUrl: { type: 'string', default: '' },
  executorName: { type: 'string', default: os.hostname() },
  executorHost: { type: 'string', default: '0.0.0.0' },
  executorPort: { type: 'number', default: 8002 },
  executorAddressPublic: { type: 'string', default: '' },
  executorToken: { type: 'string', default: '' },
  workDir: { type: 'string', default: '' },
  maxConcurrentTasks: { type: 'number', default: 10 },
  autoStart: { type: 'boolean', default: false },
  autoStartExecutor: { type: 'boolean', default: true },
  // DSK-04：系统通知默认开启（用户可在设置页关闭）
  notifyEnabled: { type: 'boolean', default: true },
  logLevel: { type: 'string', default: 'info' },
} as const;

/**
 * Config-page fields that reference the token but must never receive the
 * real secret back over IPC (SEC-NEW-1: the renderer is an untrusted
 * display layer — it may keep editing other fields without re-typing the
 * token). The renderer sends these sentinel values back on save and they
 * are mapped to "keep the stored token" instead of overwriting it.
 */
export const TOKEN_MASK = '******';
const TOKEN_MASKS = new Set([TOKEN_MASK, '']);

export class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    this.store = new Store<AppConfig>({ schema: schema as any });
    // 初始化 workDir 默认值
    if (!this.store.get('workDir')) {
      this.store.set('workDir', path.join(app.getPath('userData'), 'tasks'));
    }
    this.migratePlaintextToken();
  }

  /**
   * SEC-NEW-1 / ADR-012: one-shot lazy migration of the legacy plaintext
   * token. Encrypt-in-place on startup; if encryption is unavailable or
   * fails, keep the plaintext usable (fail-safe) and retry next launch —
   * never drop a working credential because of a migration problem.
   */
  private migratePlaintextToken(): void {
    const current = this.store.get('executorToken') as string;
    // '' and already-encrypted values need no migration.
    if (!current || isValueEncrypted(current)) return;
    const enc = encryptToken(current);
    if (enc !== null) {
      // electron-store writes are atomic (temp file + rename): the
      // plaintext is replaced by the envelope in one step, no dual-field
      // compat window (ADR-012 rejected the two-truth variant).
      this.store.set('executorToken', enc);
    }
    // enc === null → safeStorage unavailable/failed: plaintext stays, the
    // once-per-launch warn was already emitted by token-crypto.
  }

  /**
   * Raw read of the FULL config (encrypted token envelope intact). Main
   * process only — IPC reads must use getAllMasked(); consumers that need
   * the usable secret use getDecryptedToken() via resolveToken().
   */
  getAll(): AppConfig {
    return this.store.store as AppConfig;
  }

  /**
   * SEC-NEW-1: write path. A plaintext token arriving here is encrypted
   * before it hits the store; a stored/derived mask sentinel keeps the
   * existing stored value. When encryption is unavailable the plaintext is
   * stored as-is (ADR-012 degraded posture, warn once via token-crypto).
   */
  save(config: Partial<AppConfig>): void {
    for (const [k, v] of Object.entries(config)) {
      if (k === 'executorToken' && typeof v === 'string') {
        if (v === '') {
          // Explicit empty string = clear the token (user wiped the field).
          this.store.set(k, '');
          continue;
        }
        if (isValueEncrypted(v) || TOKEN_MASKS.has(v)) {
          // Encrypted round-trip (internal callers / getAll feed-back) and
          // mask sentinels both mean "token unchanged".
          if (!TOKEN_MASKS.has(v)) this.store.set(k, v);
          continue;
        }
        const enc = encryptToken(v);
        this.store.set(k, enc !== null ? enc : v);
        continue;
      }
      this.store.set(k as keyof AppConfig, v);
    }
  }

  /**
   * Raw read (encrypted form intact). Only for internal main-process use —
   * never expose over IPC; use getDecryptedToken() for the real secret.
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.store.get(key) as AppConfig[K];
  }

  /**
   * Raw write for main-process internal fields (autoStart etc.). Secret
   * writes go through save(), which owns the encrypt/mask branch table —
   * this method must never receive executorToken material.
   */
  setRaw<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value);
  }

  /** Main-process consumers (executor-process env, future rotate flows). */
  getDecryptedToken(): string {
    return decryptToken(this.store.get('executorToken') as string);
  }

  /**
   * IPC-facing read: like getAll() but the token is replaced by the mask
   * sentinel so the plaintext/ciphertext never crosses the bridge.
   */
  getAllMasked(): AppConfig {
    const cfg = this.getAll();
    return { ...cfg, executorToken: cfg.executorToken ? TOKEN_MASK : '' };
  }
}
