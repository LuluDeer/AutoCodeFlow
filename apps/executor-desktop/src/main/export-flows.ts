/**
 * 拓展包「配置导入/导出 + 执行日志导出」的纯函数层。
 *
 * 为什么独立成模块：ipc-handlers.ts 顶层 import electron——裸 node 加载即崩，
 * 里面的入参处理逻辑因此没有行为回归闸（同 config-sanitize.ts / path-domain.ts
 * 的抽离理由）。本模块只依赖语言与类型（AppConfig 是 type-only import，编译
 * 后擦除，不会把 electron 拉进 selftest 运行时），可在 `npm run test:main`
 * 里直接断言。行为由 export-flows.selftest.ts 驱动。
 *
 * 两条流的安全契约：
 *  · 导出：**只接受掩码配置**（config:get 同款 getAllMasked() 产物）。token
 *    以 `******` 哨兵落盘，绝不落明文（SEC-NEW-1 同一姿态）；误把 getAll()
 *    的明文/密文喂进来会直接抛错，而不是静默导出。
 *  · 导入：掩码/空 token 一律剥离——导入**永不**覆盖（'******'）也**永不**
 *    清空（''，ConfigStore.save 把空串解释为"用户清空密钥"）存量 token。
 *    真实 token（跨机完整迁移场景）原样保留，交由 save() 的加密分支落盘。
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
