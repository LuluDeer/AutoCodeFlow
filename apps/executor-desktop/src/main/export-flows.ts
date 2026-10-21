/**
 * 拓展包「配置导入/导出 + 执行日志导出 + 诊断报告」的纯函数层。
 *
 * 为什么独立成模块：ipc-handlers.ts 顶层 import electron——裸 node 加载即崩，
 * 里面的入参处理逻辑因此没有行为回归闸（同 config-sanitize.ts / path-domain.ts
 * 的抽离理由）。本模块只依赖语言与类型（AppConfig 是 type-only import，编译
 * 后擦除，不会把 electron 拉进 selftest 运行时），可在 `npm run test:main`
 * 里直接断言。行为由 export-flows.selftest.ts 驱动。
 *
 * 三条流的安全契约：
 *  · 导出：**只接受掩码配置**（config:get 同款 getAllMasked() 产物）。token
 *    以 `******` 哨兵落盘，绝不落明文（SEC-NEW-1 同一姿态）；误把 getAll()
 *    的明文/密文喂进来会直接抛错，而不是静默导出。
 *  · 导入：掩码/空 token 一律剥离——导入**永不**覆盖（'******'）也**永不**
 *    清空（''，ConfigStore.save 把空串解释为"用户清空密钥"）存量 token。
 *    真实 token（跨机完整迁移场景）原样保留，交由 save() 的加密分支落盘。
 *  · 诊断报告（PLAN-EXECUTOR-DESKTOP-UX 5.2）：与导出相反，**绝不抛错**
 *    ——诊断是排障的最后手段，因为一个字段不合法就让用户拿不到现场，等于
 *    把唯一的出路堵死。因此调用侧喂进未掩码 token 时不抛，而是把整份载荷
 *    强制脱敏并在 meta.redactions 里留痕（见 buildDiagnosticReport 头注）。
 */

import type { AppConfig } from './config-store';

/**
 * 掩码哨兵。与 config-store.ts 的 TOKEN_MASK 同值——刻意**不从** config-store
 * 导入：那个模块顶层 import electron，会把 selftest 一起拖崩。两侧的逐字节
 * 一致性由 export-flows.selftest.ts 的 SYNC 守卫钉住。
 */
export const EXPORT_TOKEN_MASK = '******';

/** 导出默认文件名：acf-executor-config-YYYYMMDD.json（建议命名，按本地时区）。 */
export function configExportFileName(now: Date): string {
  return `acf-executor-config-${yyyymmdd(now)}.json`;
}

/** 执行日志导出默认文件名：acf-exec-log-<executionId>-YYYYMMDD.log。 */
export function execLogExportFileName(executionId: string, now: Date): string {
  return `acf-exec-log-${executionId}-${yyyymmdd(now)}.log`;
}

function yyyymmdd(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 日志导出的大文件阈值：超过 200MB 不在主进程 copyFile——一次数百 MB 的
 * 复制会把 IPC 面与主进程长时间占住（主进程同时承载 UI），且 saveDialog
 * 期间用户无从得知进度。此时返回 tooLarge，UI 引导走「打开日志文件夹」
 * 手动复制（与 history:open-log-folder / reveal-log 同一款出路）。
 */
export const LOG_EXPORT_MAX_BYTES = 200 * 1024 * 1024;

export function logExportTooLarge(sizeBytes: number): boolean {
  // stat 失败（-1 / NaN）按"不拦"处理：把错误留给 copyFile 自己抛，别让
  // 大小探测的偶发失败把导出整条路堵死。
  return Number.isFinite(sizeBytes) && sizeBytes > LOG_EXPORT_MAX_BYTES;
}

/** 配置导入文件大小上限：配置是 KB 级 JSON，超限几乎必然是拿错了文件。 */
export const CONFIG_IMPORT_MAX_BYTES = 1024 * 1024;

/**
 * 导入白名单 = AppConfig 的全部键。导入文件是任意外部内容，与渲染层自己
 * 的表单不同——不经白名单整包透传（sanitizeConfigInput 只消毒认识的形状、
 * 未知键原样透传），会把文件里的任意垃圾键送进 electron-store 的
 * dot-notation setter（BUG-12 同款隐患面）。
 *
 * SYNC 守卫：本清单与 config-store.ts 的 AppConfig 接口逐键对齐（两个方向
 * 都查），新增配置字段漏登记时 selftest 立即红。
 */
export const IMPORTABLE_CONFIG_KEYS = [
  'configured',
  'adminApiUrl',
  'executorName',
  'executorHost',
  'executorPort',
  'executorAddressPublic',
  'executorToken',
  'workDir',
  'maxConcurrentTasks',
  'autoStart',
  'autoStartExecutor',
  'notifyEnabled',
  'logLevel',
  // i18n-DESK-01：界面语言设置（zh/en/auto，默认 zh）。进白名单 = 配置备份
  // 跨机迁移时语言设置一并带走（导入侧仍走同一消毒通道，落盘前 clamp）。
  'uiLanguage',
  'uvPath',
  'uvPythonInstallDir',
  'uvPythonInstallMirror',
  'interpreterDownloadTimeoutMs',
  'pypiRegistryUrl',
  'pullMode',
  'agentPermissionProfile',
  'agentCodeExecution',
  'agentSandboxBackend',
  'agentHostAccess',
  'agentTaskExecution',
  'agentAllowedApps',
  'agentAllowedDomains',
  'agentEnabled',
] as const satisfies readonly (keyof AppConfig)[];

export type ImportParseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 把导入文件里 JSON.parse 出来的值规整成一个可交给 sanitizeConfigInput →
 * ConfigStore.save 的补丁（返回**新对象**，不改入参）。
 *
 * 顺序即契约：本函数只做「形状校验 + 白名单过滤 + 掩码剥离」；数值钳制、
 * 枚举归一化、布尔白名单等消毒由调用方走**既有的** sanitizeConfigInput
 * 通道（与「保存配置」同一条链路），消毒语义不在这里复制第二份。
 */
export function parseImportedConfig(raw: unknown): ImportParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置文件格式无效：根节点必须是 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  // 白名单过滤：未登记的键（含 __proto__ / constructor 等危险名）一律不进
  // 补丁——JSON.parse 的自有属性不会污染原型，但 electron-store 的写入面
  // 不该被任意键名试探（防御在先，不赌下游实现）。
  const out: Record<string, unknown> = {};
  for (const key of IMPORTABLE_CONFIG_KEYS) {
    if (key in source) out[key] = source[key];
  }
  // 掩码/空 token 剥离（语义见文件头注）。非字符串同理——sanitize 层也会
  // 丢弃它，这里提前剥掉是为了让"导入不触碰存量 token"的契约不依赖下游。
  const token = out.executorToken;
  // constant-time-exempt: 与掩码常量（'***'）比较，判断是不是被掩码过的值，不是验凭据。
  if (typeof token !== 'string' || token.trim() === '' || token === EXPORT_TOKEN_MASK) {
    delete out.executorToken;
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: '配置文件中没有可导入的配置项' };
  }
  return { ok: true, payload: out };
}

/**
 * 导出载荷守卫：直接透传 getAllMasked() 的完整掩码配置。唯一职责是把
 * "密钥绝不落明文"钉成运行时契约——传入配置的 token 若既非空串（未配置
 * 过密钥）也非掩码哨兵（明文/加密信封都算"真值"），直接抛错，调用侧拿错
 * 真值源的 bug 在导出瞬间炸出来，而不是被写进用户选择的任意路径。
 */
export function buildConfigExportPayload(cfg: object): Record<string, unknown> {
  // AppConfig 等接口类型没有 index signature，入参按 object 收窄后读取
  // （调用侧传 getAllMasked() 的返回值，类型上正是 AppConfig）。
  const token = (cfg as Record<string, unknown>).executorToken;
  if (typeof token === 'string' && token !== '' && token !== EXPORT_TOKEN_MASK) {
    throw new Error('refusing to export an unmasked executor token');
  }
  return cfg as Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════
// PLAN-EXECUTOR-DESKTOP-UX 5.2：诊断报告（单一诊断包）
// ════════════════════════════════════════════════════════════════════════════

/** 诊断报告的文件名：acf-diagnostic-YYYYMMDD-HHmmss.json（按本地时区）。 */
export function diagnosticReportFileName(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `acf-diagnostic-${yyyymmdd(now)}-${hh}${mi}${ss}.json`;
}

/**
 * 诊断报告里的**日志尾部**上限：行数 + 每条长度。
 *
 * 为什么两个上限都要有：行数上限挡不住"一行 8MB 的堆栈"（executor-node 的
 * 结构化报错会把整个 response body 拼进一行），字节上限挡不住"10 万行 × 40
 * 字节"。两者独立生效，最坏情况下报告体积 ≈ LOG_LINE_CAP × 行数上限。
 */
export const DIAGNOSTIC_LOG_MAX_LINES = 200;
export const DIAGNOSTIC_LOG_LINE_MAX_CHARS = 2_000;

/**
 * 诊断报告里每个字符串字段的长度上限（配置值、错误消息等）。
 * 与日志行分开是因为它们不是"行"——一个被误填成整篇文档的 adminApiUrl
 * 不该把整份报告撑爆。
 */
export const DIAGNOSTIC_FIELD_MAX_CHARS = 2_000;

/**
 * 报告里**永不出现**的配置键（即使调用侧传错了真值源）。
 *
 * 判据是"值本身就是凭据"：token、密钥、口令。其余配置（地址/端口/路径/
 * 并发数/白名单）都是排障必需，保留原值——否则"工作目录是哪个、指向哪台
 * 中台"这类最常被问到的问题反而答不了。
 */
export const DIAGNOSTIC_SECRET_KEYS = [
  'executorToken',
  'token',
  'secret',
  'password',
  'apiKey',
  'adminToken',
  'accessToken',
  'refreshToken',
  'privateKey',
  'clientSecret',
] as const;

/** 报告里的敏感值统一替换成这个哨兵（与 EXPORT_TOKEN_MASK 同值，便于比对）。 */
export const DIAGNOSTIC_REDACTED = EXPORT_TOKEN_MASK;

/** 判断一个字符串是否是"真实凭据"（非空、非掩码哨兵）。 */
function isRealSecret(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value !== EXPORT_TOKEN_MASK
  );
}

/**
 * 对任意字符串做**子串级**凭据抹除：把已知的凭据真值（若有）从文本里替换掉。
 *
 * 为什么需要：日志行与错误消息是自由文本，token 完全可能被某条 `Bearer xxx`
 * 的调试日志带进来。键级白名单（DIAGNOSTIC_SECRET_KEYS）管不到这种情况，
 * 因此再加一层"已知真值 → 哨兵"的全局替换。
 */
function scrubKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue; // 太短的值做全局替换会把正常文本打碎
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(DIAGNOSTIC_REDACTED);
  }
  return out;
}

/** 截断到 n 个字符（超限时留省略号，让读者知道被截了）。 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  // 留 1 个字符给省略号，保证结果长度 <= max。
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 归一化任意值为"可进 JSON 的字符串或原语"（失败回落 String()，绝不抛错）。 */
function asText(value: unknown, max: number = DIAGNOSTIC_FIELD_MAX_CHARS): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

/**
 * 诊断报告的配置投影：白名单 + 凭据键一律掩码。
 *
 * 与 buildConfigExportPayload **刻意不同**：那个函数遇到未掩码 token 会抛错
 * （导出是"用户主动选择的文件"，宁可失败也不写错），本函数则**强制脱敏**
 * 后继续（诊断是排障最后手段，不能因为调用侧拿错真值源就什么都不给）。
 * 两条流的差异由 selftest 双向钉住。
 *
 * @param scrub 自由文本抹除器（把已知凭据真值换成哨兵）。以参数传入而不是在
 *   这里自行收集，是为了让"用户把 token 误填进 executorName 之类的非凭据键"
 *   这种形态也被抹掉——键级白名单管不到它，子串级能。
 */
function projectConfigForDiagnostics(
  cfg: Record<string, unknown>,
  scrub: (text: string) => string = (t) => t,
): { config: Record<string, unknown>; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const config: Record<string, unknown> = {};
  // 只投影 IMPORTABLE_CONFIG_KEYS（= AppConfig 全键）里的键：配置文件是
  // electron-store 的自由形态，报告不该把外来垃圾键一起带走。
  for (const key of IMPORTABLE_CONFIG_KEYS) {
    if (!(key in cfg)) continue;
    const value = cfg[key];
    if ((DIAGNOSTIC_SECRET_KEYS as readonly string[]).includes(key)) {
      // 凭据键：**总是**输出掩码（不输出"有没有配"以外的任何信息）。
      config[key] = DIAGNOSTIC_REDACTED;
      if (isRealSecret(value)) redactedKeys.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      // 白名单类字段（agentAllowedApps / agentAllowedDomains）保留结构，
      // 但每项截断——一份塞了 5000 条的白名单会把报告撑爆。
      config[key] = value.slice(0, 50).map((item) => scrub(asText(item) ?? ''));
      continue;
    }
    const text = asText(value);
    // 自由文本抹除：非凭据键里也可能被误填了真凭据（见 @param scrub）。
    config[key] = text === null ? null : scrub(text);
  }
  // 兜底：调用侧可能传了 AppConfig 之外的敏感键（如中台口令），一并掩码。
  for (const key of Object.keys(cfg)) {
    if (key in config) continue;
    if ((DIAGNOSTIC_SECRET_KEYS as readonly string[]).includes(key)) {
      config[key] = DIAGNOSTIC_REDACTED;
      if (isRealSecret(cfg[key])) redactedKeys.push(key);
    }
  }
  return { config, redactedKeys };
}

/** 诊断报告的系统/运行时环境段（调用侧注入，纯函数不碰 process/electron）。 */
export interface DiagnosticRuntimeInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  /** 完整 OS 版本串（`os.version()` 语义，如 "Windows 11 Pro 10.0.22631"）。 */
  osVersion?: string;
  platform: string;
  arch: string;
  osRelease: string;
  /** 运行模式：打包版 / 开发版——排障第一问常是"你装的是哪个包"。 */
  packaged?: boolean;
  locale?: string;
}

/** 诊断报告的健康快照段（调用侧注入；缺省字段表示"该项不可用"）。 */
export interface DiagnosticHealthSnapshot {
  /** 执行器进程状态：stopped / pending / online / offline。 */
  executorStatus?: string;
  /** 执行器子进程是否在跑（与 status 不同：attached 外部实例时两者可能不一致）。 */
  executorRunning?: boolean;
  /** 本地 /health/live 探针结果（true/false）；undefined = 未探测。 */
  localHealthLive?: boolean;
  /** 中台注册判定：registered / failed / unknown。 */
  adminRegistration?: string;
  /** 心跳通道健康（HeartbeatMonitor 的 lastStatus）；undefined = 未启动。 */
  heartbeatStatus?: string;
  /** 执行器实际监听端口。 */
  executorPort?: number;
  /** 中台地址（非凭据，排障必需）。 */
  adminApiUrl?: string;
}

/** 诊断报告的工作目录段。 */
export interface DiagnosticWorkDirInfo {
  /** 配置里的工作目录（原样，便于用户核对路径拼写）。 */
  path?: string;
  /** 目录是否存在。 */
  exists?: boolean;
  /** 探测到的可写性：true/false；undefined = 未探测。 */
  writable?: boolean;
  /** 探测失败原因（如 EACCES / ENOENT）——"不可写"必须给出为什么。 */
  probeError?: string;
  /** 可用空间（字节）。 */
  freeBytes?: number;
  /** 总空间（字节）。 */
  totalBytes?: number;
}

/** buildDiagnosticReport 的全部注入面。 */
export interface DiagnosticInputs {
  /** 报告生成时刻（注入以便 selftest 断言时间戳与文件名）。 */
  now: Date;
  runtime: DiagnosticRuntimeInfo;
  /** 配置真值源。生产侧传 getAllMasked()；传了明文也会被强制脱敏。 */
  config: Record<string, unknown>;
  health?: DiagnosticHealthSnapshot;
  workDir?: DiagnosticWorkDirInfo;
  /** 最近日志行（**原始**，函数内做行数/行长上限与凭据抹除）。 */
  recentLogs?: readonly string[];
  /** 已知凭据真值（用于自由文本的子串级抹除，见 scrubKnownSecrets）。 */
  knownSecrets?: readonly string[];
}

/** 报告结构。sections 恒定包含这些键（selftest 断言"所有段都在"）。 */
export interface DiagnosticReport {
  format: 'acf-diagnostic/1';
  generatedAt: string;
  sections: {
    runtime: {
      appVersion: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      osVersion: string | null;
      platform: string;
      arch: string;
      osRelease: string;
      packaged: boolean | null;
      locale: string | null;
    };
    config: Record<string, unknown>;
    health: {
      executorStatus: string | null;
      executorRunning: boolean | null;
      localHealthLive: boolean | null;
      adminRegistration: string | null;
      heartbeatStatus: string | null;
      executorPort: number | null;
      adminApiUrl: string | null;
    };
    workDir: {
      path: string | null;
      exists: boolean | null;
      writable: boolean | null;
      probeError: string | null;
      freeBytes: number | null;
      totalBytes: number | null;
      freeHuman: string | null;
    };
    recentLogs: {
      count: number;
      truncated: boolean;
      lines: string[];
    };
  };
  meta: {
    /** 被掩码的配置键（不含值）——让读报告的人知道"这里是被藏起来的"。 */
    redactedKeys: string[];
    /** 因上限被丢弃的日志行数。 */
    logsDropped: number;
    /** 因行长上限被截断的日志行数。 */
    logsClipped: number;
  };
}

/** 人类可读的字节数（诊断报告里给人看，不做精确换算断言）。 */
export function formatBytesHuman(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 纯函数：把注入的现场信息拼成一份**可序列化的诊断报告**。
 *
 * 设计纪律（与 5.2 的验收口径逐条对应）：
 *  1. **绝不抛错**——任何缺字段/脏值都降级为 null 或空集合。诊断是用户拿
 *     现场的最后手段，因为一个字段缺失就让导出失败等于堵死唯一出路。
 *  2. **绝不碰 process/electron/fs**——所有环境值由调用侧注入，因此本函数
 *     能在裸 node 的 selftest 里被直接调用（ipc-handlers 顶层 import electron，
 *     拉不起来；本模块刻意零 Electron 依赖，见文件头注）。
 *  3. **绝不输出凭据**——三层：①配置投影时凭据键恒掩码；②knownSecrets 里的
 *     真值在**所有**字符串（含日志行、错误消息）里做子串替换；③即便调用侧
 *     漏传 knownSecrets，凭据键也仍然是掩码（第①层独立成立）。
 *  4. **体积有界**——日志行数、单行长度、单字段长度、白名单条目数各自封顶。
 */
export function buildDiagnosticReport(inputs: DiagnosticInputs): DiagnosticReport {
  const { now, runtime, config } = inputs;

  // ── 0. 凭据抹除的"已知真值"集合 ────────────────────────────────────
  // 同时收：调用侧显式声明的 knownSecrets + 配置里凭据键的真实值。后者让
  // "调用侧忘了传 knownSecrets"这一常见遗漏不会导致日志里的 token 泄漏。
  const secrets = new Set<string>();
  for (const s of inputs.knownSecrets ?? []) {
    if (isRealSecret(s)) secrets.add(s as string);
  }
  for (const key of DIAGNOSTIC_SECRET_KEYS) {
    const value = config[key];
    if (isRealSecret(value)) secrets.add(value as string);
  }
  const secretList = [...secrets];
  const scrub = (text: string): string => scrubKnownSecrets(text, secretList);

  // ── 1. runtime ─────────────────────────────────────────────────────
  const runtimeSection: DiagnosticReport['sections']['runtime'] = {
    appVersion: asText(runtime?.appVersion) ?? 'unknown',
    electronVersion: asText(runtime?.electronVersion) ?? 'unknown',
    nodeVersion: asText(runtime?.nodeVersion) ?? 'unknown',
    chromeVersion: asText(runtime?.chromeVersion) ?? 'unknown',
    osVersion: asText(runtime?.osVersion),
    platform: asText(runtime?.platform) ?? 'unknown',
    arch: asText(runtime?.arch) ?? 'unknown',
    osRelease: asText(runtime?.osRelease) ?? 'unknown',
    packaged: typeof runtime?.packaged === 'boolean' ? runtime.packaged : null,
    locale: asText(runtime?.locale),
  };

  // ── 2. config（强制脱敏投影）───────────────────────────────────────
  const { config: configSection, redactedKeys } = projectConfigForDiagnostics(
    config ?? {},
    scrub,
  );

  // ── 3. health ──────────────────────────────────────────────────────
  const health = inputs.health ?? {};
  const healthSection: DiagnosticReport['sections']['health'] = {
    executorStatus: asText(health.executorStatus),
    executorRunning:
      typeof health.executorRunning === 'boolean' ? health.executorRunning : null,
    localHealthLive:
      typeof health.localHealthLive === 'boolean' ? health.localHealthLive : null,
    adminRegistration: asText(health.adminRegistration),
    heartbeatStatus: asText(health.heartbeatStatus),
    executorPort:
      typeof health.executorPort === 'number' && Number.isFinite(health.executorPort)
        ? health.executorPort
        : null,
    // 中台地址不是凭据（用户本来就填在表单里），但对它同样做凭据抹除——
    // 有人会把 `https://user:pass@host` 填进来，那段 userinfo 是真凭据。
    adminApiUrl: health.adminApiUrl ? scrub(clip(String(health.adminApiUrl), DIAGNOSTIC_FIELD_MAX_CHARS)) : null,
  };

  // ── 4. workDir（可写性 + 剩余空间）─────────────────────────────────
  const wd = inputs.workDir ?? {};
  const freeBytes =
    typeof wd.freeBytes === 'number' && Number.isFinite(wd.freeBytes) && wd.freeBytes >= 0
      ? wd.freeBytes
      : null;
  const totalBytes =
    typeof wd.totalBytes === 'number' && Number.isFinite(wd.totalBytes) && wd.totalBytes >= 0
      ? wd.totalBytes
      : null;
  const workDirSection: DiagnosticReport['sections']['workDir'] = {
    path: wd.path ? scrub(clip(String(wd.path), DIAGNOSTIC_FIELD_MAX_CHARS)) : null,
    exists: typeof wd.exists === 'boolean' ? wd.exists : null,
    writable: typeof wd.writable === 'boolean' ? wd.writable : null,
    probeError: wd.probeError ? scrub(clip(String(wd.probeError), DIAGNOSTIC_FIELD_MAX_CHARS)) : null,
    freeBytes,
    totalBytes,
    freeHuman: formatBytesHuman(freeBytes),
  };

  // ── 5. recentLogs（行数 + 行长双上限 + 凭据抹除）────────────────────
  const rawLines = Array.isArray(inputs.recentLogs) ? inputs.recentLogs : [];
  // 只取**尾部** N 行：报告要的是"最近发生了什么"，开头那批老日志没有诊断价值。
  const windowed = rawLines.slice(-DIAGNOSTIC_LOG_MAX_LINES);
  const logsDropped = Math.max(0, rawLines.length - windowed.length);
  let logsClipped = 0;
  const lines: string[] = [];
  for (const raw of windowed) {
    let line = typeof raw === 'string' ? raw : String(raw ?? '');
    // 去掉行尾 CR：Windows 落盘是 \r\n，残留 \r 会让查看器把它显示成方块。
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > DIAGNOSTIC_LOG_LINE_MAX_CHARS) {
      line = clip(line, DIAGNOSTIC_LOG_LINE_MAX_CHARS);
      logsClipped += 1;
    }
    lines.push(scrub(line));
  }

  return {
    format: 'acf-diagnostic/1',
    generatedAt: now instanceof Date && !Number.isNaN(now.getTime())
      ? now.toISOString()
      : new Date(0).toISOString(),
    sections: {
      runtime: runtimeSection,
      config: configSection,
      health: healthSection,
      workDir: workDirSection,
      recentLogs: { count: lines.length, truncated: logsDropped > 0, lines },
    },
    meta: { redactedKeys: [...new Set(redactedKeys)], logsDropped, logsClipped },
  };
}
