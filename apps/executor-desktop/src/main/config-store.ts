import type ElectronStoreClass from 'electron-store' with { 'resolution-mode': 'import' };
// @ts-expect-error TS1479：electron-store 11 为 ESM-only 包，CJS 主进程的静态
// import 在类型层被拒绝；运行时由 Electron 44 内置 Node 24 的同步 require(esm)
// 加载（已冒烟验证，见 package.json 的 _comment_deps）。
import Store from 'electron-store';
import * as os from 'os';
import { app } from 'electron';
import * as path from 'path';
import { decryptToken, encryptToken, isValueEncrypted } from './token-crypto';
import log from './logger';

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

  /**
   * python_task_multiversion：uv 多版本解释器支持（全部可选）。
   *
   * 这些字段**全部可缺省**——旧版本配置文件里没有它们，electron-store 的
   * defaults 会补上，因此老用户升级后不需要迁移、也不会因为缺字段而
   * 读配置失败（兼容红线）。
   *
   * 缺省语义：
   *   - `uvPath`：空 = 用自带的 uv，没有则回退 PATH 查找；
   *   - `uvPythonInstallDir`：空 = 用 `<userData>/interpreters`；
   *   - `uvPythonInstallMirror`：空 = 用 uv 默认源（内网部署才需要）。
   */
  uvPath?: string;
  uvPythonInstallDir?: string;
  uvPythonInstallMirror?: string;
  /** 单个解释器下载超时（毫秒）。空 = executor-node 默认值。 */
  interpreterDownloadTimeoutMs?: number;
  /** 私有 PyPI 源（依赖安装用）。空 = 用默认源。 */
  pypiRegistryUrl?: string;

  /**
   * ARCH-32/ARCH-33（ADR-015/ADR-016）：pull 回连模式开关。
   *
   * `true` = 执行器主动长轮询 admin-api 领取任务**与控制面命令**（部署/停止/
   * 卸载/配置热更新/终止/包更新），admin 无需反向连入本机。
   *
   * 为什么桌面端必须有这个开关（而不是让用户手改环境变量）：桌面的典型部署
   * 就是「公网中台 + 内网办公机」——正是 push 模式必然失败的拓扑。此前设置页
   * 只提示「跨网络或 NAT 环境需填外网 IP / 域名」，但办公机在 NAT 后根本
   * 没有可填的公网地址，用户按提示怎么填都不会通。pull 模式才是该拓扑的正解。
   *
   * 兼容红线：与 uv* 字段同样**可选**，缺省 false（= 保持既有 push 行为）。
   * 旧配置文件没有这个键，electron-store 的 defaults 会补上，老用户
   * 升级后行为不变、也不需要迁移。
   */
  pullMode?: boolean;

  /**
   * P7a（agent-and-deployment / ADR-022）：执行器 Agent 权限档位（09）。
   *
   * 全部可选、缺省即最保守（与 uv* / pullMode 同款兼容红线）：旧配置文件
   * 没有这些键时由 defaults 补齐为 minimal——**升级不会让任何机器突然获得
   * Agent 能力**，Agent 是"显式开启"而非"默认开启"。
   *
   * 为什么这里只存**本地**档位：最终生效档位是 `min(本地, 中台下发上限)`
   * （ADR-022 决策 4 / 09 §4.2），中台策略经 agent-collab poll 随 sopPolicy
   * 下发，合并发生在 `agent/permission-profile.ts` 的 mergeWithCenterPolicy。
   * 落盘只存本地意图，合并结果不落盘（否则"被中台压下来"会被持久化成
   * 本地意愿，中台放宽后反而回不去）。
   *
   * 消毒纪律：这些枚举值**必须**进 config-sanitize.ts 的消毒层——conf 15
   * 移除 JSON schema 后坏值静默落盘，一个拼错的档位名（sandbox→sandox）
   * 不会报错，只会把 Agent 带到未定义行为（09 §4.1 明确点名这个踩坑风险）。
   */
  agentPermissionProfile?: string;
  agentCodeExecution?: string;
  agentSandboxBackend?: string;
  agentHostAccess?: string;
  agentTaskExecution?: string;
  /** hostAccess=app-scoped（P7c）时的应用白名单；P7a 档位下恒空。 */
  agentAllowedApps?: string[];
  /** 试跑的网络面约束（域名白名单）。 */
  agentAllowedDomains?: string[];
}

// electron-store 11（conf 15）移除了 JSON schema（ajv）支持，旧 schema 里
// 的 `type` 校验职责由 config-sanitize.ts 消毒层承接（见 config-sanitize.ts
// 头注）；`default` 补默认值职责由 conf 仍支持的 `defaults` 选项承载——
// 语义不变：旧配置文件缺这些键时 electron-store 会补默认值，保证升级后
// 读配置不炸（兼容红线，与各字段的既有注释同义）。
const defaults = {
  configured: false,
  adminApiUrl: '',
  executorName: os.hostname(),
  executorHost: '0.0.0.0',
  executorPort: 8002,
  executorAddressPublic: '',
  executorToken: '',
  workDir: '',
  maxConcurrentTasks: 10,
  autoStart: false,
  autoStartExecutor: true,
  // DSK-04：系统通知默认开启（用户可在设置页关闭）
  notifyEnabled: true,
  logLevel: 'info',
  // python_task_multiversion：可选，缺省即"用内置默认值"。
  // 显式给 default '' 而不是 required——旧配置文件缺这些键时 electron-store
  // 会补默认值，保证升级后读配置不炸。
  uvPath: '',
  uvPythonInstallDir: '',
  uvPythonInstallMirror: '',
  interpreterDownloadTimeoutMs: 0,
  pypiRegistryUrl: '',
  // ARCH-33：默认 false = 保持既有 push 行为。旧配置文件缺该键时由 defaults
  // 补齐，升级后行为不变（兼容红线，与 uv* 字段同处置）。
  pullMode: false,
  // P7a（ADR-022）：Agent 权限档位默认 **minimal**（什么都不允许）。
  // 选 minimal 而非 standard 作默认，是因为这是一次信任模型变更——09 §1
  // 「默认最保守」原则要求开箱即用档位为「什么都不能做」；且旧配置文件
  // 根本没有这些键，升级后**不允许**凭空获得"能在本机试跑生成代码"的能力。
  // 09 §7 待用户确认的「默认预设改 standard」一旦拍板，只改这里。
  agentPermissionProfile: 'minimal',
  // 细粒度覆盖缺省**空串** = "不覆盖"（跟随预设），而不是"某个轴值"。
  // 空串经消毒层保留、经 permission-profile 解析回落到预设值。
  agentCodeExecution: '',
  agentSandboxBackend: '',
  agentHostAccess: '',
  agentTaskExecution: '',
  agentAllowedApps: [],
  agentAllowedDomains: [],
} satisfies Partial<AppConfig>;

/**
 * Config-page fields that reference the token but must never receive the
 * real secret back over IPC (SEC-NEW-1: the renderer is an untrusted
 * display layer — it may keep editing other fields without re-typing the
 * token). The renderer sends these sentinel values back on save and they
 * are mapped to "keep the stored token" instead of overwriting it.
 */
export const TOKEN_MASK = '******';
const TOKEN_MASKS = new Set([TOKEN_MASK, '']);

/**
 * S-2（audit-r4）：严格加密模式的开关。
 * 设 EXECUTOR_REQUIRE_ENCRYPTED_TOKEN=1/true 后，token **不得**以明文落盘：
 * 无 OS keyring（典型 Linux 无桌面/gnome-keyring 未运行）时 save() 跳过 token
 * 写入并 error 级记录，而不是按 ADR-012 的兼容姿态存明文。
 */
export function isStrictTokenEncryption(): boolean {
  const v = (process.env.EXECUTOR_REQUIRE_ENCRYPTED_TOKEN || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

// electron-store 11 的默认导出即类本身；经类型导入拿到实例形状，
// 运行时构造器（any）在此收窄。
type ElectronStoreInstance = ElectronStoreClass<AppConfig>;
const StoreCtor = Store as unknown as new (options?: {
  defaults?: Partial<AppConfig>;
}) => ElectronStoreInstance;

export class ConfigStore {
  private store: ElectronStoreInstance;

  constructor() {
    this.store = new StoreCtor({ defaults });
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
        const enc = encryptToken(v, { requireEncryption: isStrictTokenEncryption() });
        if (enc !== null) {
          this.store.set(k, enc);
        } else if (isStrictTokenEncryption()) {
          // S-2：严格模式 + 无 keyring → 不写 token（保留旧值），绝不降级明文。
          // token-crypto 已 error 级记录原因与修法；此处不覆盖旧存储值。
          log.error(
            '[SEC-NEW-1] Token save rejected: encryption unavailable and ' +
              'EXECUTOR_REQUIRE_ENCRYPTED_TOKEN is set — keeping the previous stored value.',
          );
        } else {
          this.store.set(k, v);
        }
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
