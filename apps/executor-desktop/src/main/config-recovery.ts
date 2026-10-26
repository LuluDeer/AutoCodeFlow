/**
 * 配置存储的**落盘卫生决策层**（纯模块：只依赖 fs/path/os 与注入面，可被
 * config-recovery.selftest.ts 在裸 Node 下逐分支断言；Electron 接线在
 * config-store.ts / ipc-handlers.ts，形态对齐 crash-guard.ts 的"决策下沉"先例）。
 *
 * 本模块承载三项修复：
 *
 * ## P1-1：config.json 损坏 → 无限启动崩溃循环
 *
 * ConfigStore 构造器此前无容错：config.json 一旦损坏（断电写半行 / 磁盘满 /
 * 手改坏 JSON），electron-store 12（conf 16）在构造时 JSON.parse 抛
 * SyntaxError（`clearInvalidConfig` 默认 false，不会自行清档），异常落在
 * crash-guard 覆盖内 → 每次启动弹「重启即可恢复」后退出，重启永远无效。
 *
 * 修法：构造时捕获 SyntaxError → 把坏文件改名 `config.json.corrupt-<ts>`
 * **留证**（同目录，用户可拿去排障/手工抢救 token 等字段）→ 以 defaults
 * 重建继续启动（代价：配置回到出厂态，但应用可用、证据还在）。
 *
 * ## P3-2：config.json 落盘 best-effort chmod 0600
 *
 * config.json 含执行器共享令牌（明文或 enc: 信封），落盘权限此前跟随 umask
 * （典型 0644，同机其他用户可读）。先例：executor-node 的
 * executor-instance-id.ts:98 以 mode 0o600 落盘行 id。这里在构造成功与每次
 * save 后对文件补 chmod 0600（best-effort：文件尚不存在/权限被拒只静默返回
 * false，绝不阻断主链；Windows 无 POSIX 权限位直接跳过）。
 *
 * ## P3-5：config:save 的 workDir 落盘前校验
 *
 * 渲染层送来的 workDir 不可信：相对路径会让 executor-node 的任务落盘点漂到
 * 进程 cwd 下；指向文件/只读目录则所有任务启动即失败。校验在**保存前**做，
 * 不合格以 `{ ok: false, error }` 回 IPC（与 config:save 既有错误形态同款）。
 * 校验只在 workDir **发生变化**时执行（由调用方比对旧值决定是否调用）——
 * 存量坏目录不该把用户改其它字段的保存也一并堵死。
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * 判断一个构造错误是否为「配置文件损坏」形态（JSON.parse 的 SyntaxError）。
 * 用 name 比对兼容跨 realm 的 SyntaxError（vm/沙箱场景 instanceof 会失手）。
 */
export function isConfigSyntaxError(err: unknown): boolean {
  return err instanceof SyntaxError || (err instanceof Error && err.name === 'SyntaxError');
}

/** quarantineCorruptConfigFile 的结果（绝不抛：失败以 error 字段如实回报）。 */
export interface QuarantineResult {
  /** 是否成功把坏文件改名留证。 */
  quarantined: boolean;
  /** 留证文件的绝对路径（quarantined=false 时为 null）。 */
  backupPath: string | null;
  /** 失败原因（quarantined=false 且文件本就不存在时为 undefined = 无需处理）。 */
  error?: string;
}

/**
 * 把损坏的配置文件改名 `<原路径>.corrupt-<毫秒时间戳>` 留证（同目录）。
 *
 * 改名优先于删除：坏文件里可能还有 token 信封等可手工抢救的字段，删掉等于
 * 销毁证据。改名失败（权限被拒等）再尝试 unlink 兜底——目标目录通常可写
 * （electron-store 自己也要往里写），两条路都走不通才报失败。
 */
export function quarantineCorruptConfigFile(
  configPath: string,
  nowMs: number = Date.now(),
): QuarantineResult {
  if (!fs.existsSync(configPath)) {
    // 损坏的不是这个文件（或已被并发处理）：无事可做，不算失败。
    return { quarantined: false, backupPath: null };
  }
  const backupPath = `${configPath}.corrupt-${nowMs}`;
  try {
    fs.renameSync(configPath, backupPath);
    return { quarantined: true, backupPath };
  } catch (renameErr) {
    try {
      fs.unlinkSync(configPath);
      return { quarantined: false, backupPath: null, error: `rename failed (${renameErr instanceof Error ? renameErr.message : renameErr}), fell back to unlink` };
    } catch (unlinkErr) {
      return {
        quarantined: false,
        backupPath: null,
        error: `rename failed (${renameErr instanceof Error ? renameErr.message : renameErr}) and unlink failed (${unlinkErr instanceof Error ? unlinkErr.message : unlinkErr})`,
      };
    }
  }
}

/**
 * config.json 落盘权限收紧（P3-2）：chmod 0600，Windows 跳过，best-effort。
 * 返回是否实际执行了 chmod（文件不存在/权限被拒 = false，调用方不处理）。
 */
export function hardenConfigFilePermissions(configPath: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    fs.chmodSync(configPath, 0o600);
    return true;
  } catch {
    // conf 的写盘是惰性的（首次 set 才落文件）：构造时文件尚不存在属正常
    // 时序，等下一次 save 后的收紧即可，不必报错。
    return false;
  }
}

export interface StoreRecoveryDeps<T> {
  /** 实际构造 store 的闭包（对 config.json 损坏会抛 SyntaxError）。 */
  createStore: () => T;
  /** 配置文件绝对路径（损坏时被改名留证的对象）。 */
  configPath: string;
  /** 恢复过程的 warn 日志出口（主进程注入 electron-log）。 */
  logWarn: (message: string) => void;
  /** 每次构造成功后对配置文件的权限收紧；缺省用 hardenConfigFilePermissions。 */
  hardenPermissions?: (configPath: string) => boolean;
  /** 时间源（留证文件名去重；selftest 注入固定值）。 */
  now?: () => number;
}

export interface StoreRecoveryOutcome<T> {
  store: T;
  /** 本次构造是否经历了「坏文件留证 + 重建」（true = 配置已回出厂态）。 */
  recovered: boolean;
  /** 留证文件路径（recovered=true 时非 null）。 */
  backupPath: string | null;
}

/**
 * 带损坏容错的 store 构造（P1-1 决策层）。
 *
 * 首次构造抛 SyntaxError → 坏文件改名留证 → 二次构造（读不到文件 = 走
 * defaults）。二次构造仍抛（目录不可写等更深的故障）则原样上抛——那已经
 * 不是「文件内容坏了」，crash-guard 的既有兜底才是正确去向。
 * 非 SyntaxError 的构造失败（权限、磁盘等）**不**做恢复，直接上抛：对那类
 * 故障"以 defaults 重建"会静默清掉用户全部配置，代价远大于崩溃一次。
 */
export function createStoreToleratingCorruption<T>(
  deps: StoreRecoveryDeps<T>,
): StoreRecoveryOutcome<T> {
  const harden = deps.hardenPermissions ?? hardenConfigFilePermissions;
  let store: T;
  try {
    store = deps.createStore();
    harden(deps.configPath);
    return { store, recovered: false, backupPath: null };
  } catch (err) {
    if (!isConfigSyntaxError(err)) throw err;
    const quarantine = quarantineCorruptConfigFile(deps.configPath, deps.now?.() ?? Date.now());
    deps.logWarn(
      quarantine.quarantined
        ? `Corrupt config.json detected and quarantined as ${quarantine.backupPath}; rebuilding with defaults. ` +
          'Saved settings are reset — the corrupt file is kept for inspection/recovery.'
        : `Corrupt config.json detected but could not be quarantined: ${quarantine.error ?? 'unknown'}`,
    );
    store = deps.createStore();
    harden(deps.configPath);
    return { store, recovered: true, backupPath: quarantine.backupPath };
  }
}

/** workDir 落盘校验的文件系统注入面（selftest 用假 fs 驱动边界分支）。 */
export interface WorkDirFsDeps {
  isAbsolute: (p: string) => boolean;
  exists: (p: string) => boolean;
  isDirectory: (p: string) => boolean;
  canWrite: (p: string) => boolean;
  /** 不存在时递归创建（best-effort；返回是否成功）。 */
  ensureDirectory: (p: string) => boolean;
}

const defaultWorkDirFsDeps: WorkDirFsDeps = {
  isAbsolute: (p) => path.isAbsolute(p),
  exists: (p) => fs.existsSync(p),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  canWrite: (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  ensureDirectory: (p) => {
    try {
      fs.mkdirSync(p, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
};

export type WorkDirVerdict = { ok: true } | { ok: false; error: string };

/**
 * 校验一次保存面送来的 workDir（P3-5）。返回 `{ ok: true }` 或带**用户可读**
 * 中文错误的 `{ ok: false, error }`（与 config:save 既有错误形态同款）。
 *
 * 语义边界：
 *  - 空白/非字符串 = sanitize 层的「不修改」语义，这里放行（兜底，不该走到）；
 *  - 目录不存在时**尽力创建**而非拒绝——首装的默认 workDir
 *    （`<userData>/tasks`）在执行器首跑前本就不存在，一票否决会把合法保存
 *    链路堵死；创建失败（权限等）才拒。
 */
export function validateWorkDirForSave(
  workDir: unknown,
  deps: WorkDirFsDeps = defaultWorkDirFsDeps,
): WorkDirVerdict {
  if (typeof workDir !== 'string' || workDir.trim() === '') return { ok: true };
  const trimmed = workDir.trim();
  if (!deps.isAbsolute(trimmed)) {
    return { ok: false, error: `工作目录必须是绝对路径：${trimmed}` };
  }
  if (deps.exists(trimmed)) {
    if (!deps.isDirectory(trimmed)) {
      return { ok: false, error: `工作目录指向的不是文件夹：${trimmed}` };
    }
    if (!deps.canWrite(trimmed)) {
      return { ok: false, error: `工作目录不可写（权限被拒）：${trimmed}` };
    }
    return { ok: true };
  }
  if (!deps.ensureDirectory(trimmed)) {
    return { ok: false, error: `工作目录不存在且无法创建：${trimmed}` };
  }
  if (!deps.canWrite(trimmed)) {
    return { ok: false, error: `工作目录刚创建但不可写（权限被拒）：${trimmed}` };
  }
  return { ok: true };
}
