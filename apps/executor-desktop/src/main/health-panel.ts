/**
 * PLAN-EXECUTOR-DESKTOP-UX 5.1：健康检查面板的**纯展示映射层**。
 *
 * 为什么单独成一个模块、而不是在渲染层里现算：
 *  · 本仓反复警示的缺陷形态是「第二套真值源」。面板的每个数都必须来自
 *    既有真值源（诊断报告的 `buildDiagnosticReport()` 输出 + 既有的
 *    `config:python-env-status` 载荷），渲染层只做「把已有数据摊成行」，
 *    不重新采集（不探 /health、不 statfs、不 spawn uv）；
 *  · 渲染层无 DOM 测试设施，`test:main` 的 selftest 才是能真执行断言的地方。
 *    把映射逻辑放在 main 侧（零 electron 依赖的纯函数）即可被
 *    health-panel.selftest.ts 逐条钉住；renderer.selftest.mjs 再静态钉接线。
 *
 * 脱敏口径：**本模块不引入任何新的脱敏逻辑**——它只消费
 * `buildDiagnosticReport()` 的输出，那份输出已经过三层脱敏（键级掩码 /
 * 已知凭据真值子串擦洗 / 中台地址 userinfo 擦洗），见 export-flows.ts。
 * 唯一可能把绝对路径带到界面上的是 `workDir.path` 与 `runtime` 里的版本串，
 * 前者由 `diagnosticWorkDirDisplay()` 收敛成「末两段」（保留可辨识性、
 * 不暴露完整用户名路径），后者本来就是版本号不是路径。
 */

/** 诊断报告的形状（只取面板用得到的字段，避免把整个 DiagnosticReport 拖进来）。 */
export interface HealthPanelReport {
  sections: {
    runtime: {
      appVersion: string;
      electronVersion: string;
      nodeVersion: string;
      platform: string;
      arch: string;
    };
    health: {
      executorStatus: string | null;
      executorRunning: boolean | null;
      localHealthLive: boolean | null;
      adminRegistration: string | null;
      heartbeatStatus: string | null;
      executorPort: number | null;
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
  };
}

/**
 * Python 环境诊断的**面板子集**（`config:python-env-status` 载荷）。
 * 刻意只声明用到的字段：主进程那张载荷更大，面板不该假设它只有这些键。
 */
export interface HealthPanelPythonEnv {
  uvPath: string | null;
  uvSource: 'config' | 'bundled' | 'env' | 'path';
  uvFromSystemEnv: boolean;
  uvConfiguredButMissing?: boolean;
  uvStaticallyConfirmed?: boolean;
  poolEntries: string[];
  poolReadable: boolean;
}

/** 一行检查的判定：ok = 通过，warn = 需要注意但非致命，bad = 失败，unknown = 未取到。 */
export type HealthRowState = 'ok' | 'warn' | 'bad' | 'unknown';

/**
 * 一行检查的**机器可读**描述。
 *
 * 刻意不在这里拼中文/英文文案：文案必须走渲染层的既有手写双语表
 * （renderer/i18n.ts，`health.row.*` / `health.value.*` 键）。本模块只产出
 * `labelKey` + `state` + `values`（数值/版本串/单位），渲染层查表插值。
 * 这样两语言共用同一套判定，判定漂移无处藏身。
 */
export interface HealthRow {
  /** 行标题的 i18n 键（`health.row.<id>`）。 */
  id: 'adminApi' | 'executor' | 'adminReg' | 'heartbeat' | 'python' | 'node' | 'workDir' | 'disk';
  state: HealthRowState;
  /**
   * 值的 i18n 键（`health.value.*`）。null = 这一项没有值可显示（只有状态）。
   * 取值为**键名后缀**，渲染层自行拼 `health.value.` 前缀。
   */
  valueKey: string | null;
  /** 插值参数（版本串 / 端口 / 空间大小 / 池内版本数）。 */
  args: (string | number)[];
  /**
   * 附加说明的 i18n 键（可选）：例如目录不存在时的原因、探测失败的错误码。
   * 与 args 一起插值。
   */
  detailKey: string | null;
  detailArgs: (string | number)[];
}

/** 面板顶部汇总：ok / warn / bad / unknown 各自几行。 */
export interface HealthPanelSummary {
  ok: number;
  warn: number;
  bad: number;
  unknown: number;
  /** 整体判定：任一行 bad → 'bad'；否则任一 warn → 'warn'；全 unknown → 'unknown'；否则 'ok'。 */
  overall: HealthRowState;
}

export interface HealthPanel {
  rows: HealthRow[];
  summary: HealthPanelSummary;
}

/**
 * 工作目录的展示值：只保留**末两段**路径。
 *
 * 为什么脱敏路径：诊断报告里的 `workDir.path` 已过凭据擦洗但**保留完整路径**
 * （报告是给排障人读的，需要整条路径去核对）。面板是常驻界面，会出现在
 * 截图与工单里，`C:\Users\<真实姓名>\AppData\...` 这类路径不该顺带泄漏。
 * 末两段足够让用户确认「是不是这个目录」，又去掉了用户名前缀。
 *
 * 分隔符兼容 Windows / POSIX（诊断报告可能来自另一台机器粘贴的数据）。
 * 不足两段时原样返回；空串 → null（不显示一个空路径）。
 */
export function diagnosticWorkDirDisplay(rawPath: string | null | undefined): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (trimmed === '') return null;
  // 统一按 / 和 \ 切分；过滤空段能同时吃掉尾部分隔符与连续分隔符。
  const parts = trimmed.split(/[\\/]+/).filter((p) => p !== '');
  if (parts.length === 0) return null;
  // 盘符是卷根不是目录段：`E:\tasks` 只有一段目录，不该被显示成 `…/E:/tasks`。
  const volumeRoot = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] : null;
  const dirParts = volumeRoot ? parts.slice(1) : parts;
  if (dirParts.length === 0) return null; // 裸卷根（`C:\`）：没有可辨识的目录
  if (dirParts.length === 1) {
    return volumeRoot ? `${volumeRoot}\\${dirParts[0]}` : dirParts[0];
  }
  return `…/${dirParts.slice(-2).join('/')}`;
}

/** 磁盘占用百分比（0–100 的整数）；分子分母不可用时返回 null（不假报 0%）。 */
export function diskUsedPercent(freeBytes: number | null, totalBytes: number | null): number | null {
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) return null;
  if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  if (freeBytes > totalBytes) return null; // 脏数据：宁可显示不可用，也不画一条超过 100% 的条
  const used = ((totalBytes - freeBytes) / totalBytes) * 100;
  return Math.min(100, Math.max(0, Math.round(used)));
}

/** 空间水位（§5.1 的 diskSpaceSufficient 语义）：<200MB 视为不足，<3GB 视为偏低。 */
export const HEALTH_DISK_CRITICAL_BYTES = 200 * 1024 * 1024;
export const HEALTH_DISK_WARN_BYTES = 3 * 1024 * 1024 * 1024;

/** 剩余空间 → 行状态。null（读不到）= unknown，不是 bad。 */
export function diskStateFromFreeBytes(freeBytes: number | null): HealthRowState {
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes) || freeBytes < 0) return 'unknown';
  if (freeBytes < HEALTH_DISK_CRITICAL_BYTES) return 'bad';
  if (freeBytes < HEALTH_DISK_WARN_BYTES) return 'warn';
  return 'ok';
}

/** 工作目录可写性 → 行状态。不存在 = bad（用户要看到"目录不存在"）；未探测 = unknown。 */
export function workDirState(writable: boolean | null, exists: boolean | null): HealthRowState {
  if (writable === true) return 'ok';
  if (writable === false) return 'bad';
  // writable 未知：目录明确不存在仍是 bad（等价于不可写，见 probeWorkDir 注释）
  if (exists === false) return 'bad';
  return 'unknown';
}

/** 中台注册判定 → 行状态。'unknown' 是旧 bundle 无该端点的正常态，按 warn 而非 bad。 */
export function adminRegistrationState(registration: string | null | undefined): HealthRowState {
  const v = typeof registration === 'string' ? registration.trim().toLowerCase() : '';
  if (v === 'registered') return 'ok';
  if (v === 'failed') return 'bad';
  if (v === '') return 'unknown';
  return 'warn';
}

/** 心跳通道状态 → 行状态。 */
export function heartbeatState(status: string | null | undefined): HealthRowState {
  const v = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (v === 'ok' || v === 'online' || v === 'alive') return 'ok';
  if (v === 'failed' || v === 'error' || v === 'offline') return 'bad';
  if (v === '') return 'unknown';
  return 'warn';
}

/**
 * Python 可用性 → 行状态。
 *
 * 判据与设置页诊断块**同一套**（见 ConfigPage 的 uvConfiguredButMissing /
 * uvStaticallyConfirmed 分支）：这里不重新推断 uv 解析链，只把那份载荷
 * 的两条既有标志映射成状态。
 */
export function pythonState(env: HealthPanelPythonEnv | null | undefined): HealthRowState {
  if (!env) return 'unknown';
  if (env.uvConfiguredButMissing === true) return 'bad'; // 配了 uvPath 但文件用不了
  if (env.uvPath) return 'ok';
  if (env.uvFromSystemEnv) return 'ok';
  // uvStaticallyConfirmed === false = 只能运行时从 PATH 兜底，**不是**缺失
  if (env.uvStaticallyConfirmed === false) return 'warn';
  return 'bad';
}

/** 执行器进程/健康探针 → 行状态。 */
export function executorState(
  running: boolean | null,
  status: string | null,
  localHealthLive: boolean | null,
): HealthRowState {
  // 本地 /health/live 是最硬的证据：它真的一次 HTTP 探通了
  if (localHealthLive === true) return 'ok';
  if (localHealthLive === false) return 'bad';
  if (running === false || (typeof status === 'string' && status === 'stopped')) return 'unknown';
  if (typeof status === 'string' && status === 'online') return 'ok';
  if (typeof status === 'string' && (status === 'offline' || status === 'pending')) return 'warn';
  return 'unknown';
}

/** 由行状态汇总出整体判定（顺序：bad > warn > unknown > ok）。 */
export function summarizeHealthRows(rows: readonly HealthRow[]): HealthPanelSummary {
  const summary: HealthPanelSummary = { ok: 0, warn: 0, bad: 0, unknown: 0, overall: 'unknown' };
  for (const row of rows) {
    if (row.state === 'ok') summary.ok += 1;
    else if (row.state === 'warn') summary.warn += 1;
    else if (row.state === 'bad') summary.bad += 1;
    else summary.unknown += 1;
  }
  if (summary.bad > 0) summary.overall = 'bad';
  else if (summary.warn > 0) summary.overall = 'warn';
  else if (summary.ok > 0) summary.overall = 'ok';
  else summary.overall = 'unknown';
  return summary;
}

/**
 * 从诊断报告里**投影**出面板需要的三段（runtime / health / workDir）。
 *
 * 为什么不把整份报告丢过 IPC：
 *  · 面板只需要这三段；`sections.config`（哪怕是掩码）与 `sections.recentLogs`
 *    （最多 200 行原始日志）过了桥就是白给渲染层的额外暴露面，一旦渲染层
 *    把它塞进 DOM/日志，脱敏承诺就被绕过一层；
 *  · 投影仍在**同一份真值**上做（同一个 buildDiagnosticReport 输出），
 *    不构成第二套采集逻辑。
 *
 * 传入 null/畸形载荷时返回全 null 段（面板降级为 unknown 行），绝不抛。
 */
export function projectHealthInputs(
  report: HealthPanelReport | null | undefined,
): {
  runtime: HealthPanelReport['sections']['runtime'] | null;
  health: HealthPanelReport['sections']['health'] | null;
  workDir: HealthPanelReport['sections']['workDir'] | null;
} {
  if (!report || typeof report !== 'object' || !report.sections) {
    return { runtime: null, health: null, workDir: null };
  }
  const sections = report.sections;
  return {
    runtime: sections.runtime ?? null,
    health: sections.health ?? null,
    workDir: sections.workDir ?? null,
  };
}

/**
 * 把「诊断报告 + Python 环境诊断 + 中台连通性」摊成面板行。
 *
 * 数据来源（**全部是既有真值源，本函数不采集任何东西**）：
 *   · `report`      ← 主进程 `collectDiagnosticInputs()` + `buildDiagnosticReport()`
 *   · `pythonEnv`   ← 既有 `config:python-env-status` 载荷
 *   · `adminApi`    ← 既有 `config:test-connection` 的结果（由调用方传入）
 *
 * 任一段缺失都降级为 unknown 行，**绝不抛错**（诊断不能因为一个可选项失败
 * 而失败——与 buildDiagnosticReport 同一姿态）。
 */
export function buildHealthPanel(
  report: HealthPanelReport | null | undefined,
  pythonEnv: HealthPanelPythonEnv | null | undefined,
  adminApi: { ok: boolean; message: string } | null | undefined,
): HealthPanel {
  const rows: HealthRow[] = [];
  const runtime = report?.sections?.runtime;
  const health = report?.sections?.health;
  const workDir = report?.sections?.workDir;

  // ① 中台连接：复用 config:test-connection 的判定（收到应答即 ok）。
  rows.push({
    id: 'adminApi',
    state: adminApi ? (adminApi.ok ? 'ok' : 'bad') : 'unknown',
    valueKey: adminApi ? (adminApi.ok ? 'reachable' : 'unreachable') : null,
    args: [],
    // 失败原因原样带上（主进程那条消息已限长）；成功时不重复贴消息。
    detailKey: adminApi && !adminApi.ok && adminApi.message ? 'message' : null,
    detailArgs: adminApi && !adminApi.ok && adminApi.message ? [adminApi.message] : [],
  });

  // ② 执行器进程 + 本地健康探针
  rows.push({
    id: 'executor',
    state: executorState(health?.executorRunning ?? null, health?.executorStatus ?? null, health?.localHealthLive ?? null),
    valueKey: health?.executorStatus ? 'status' : null,
    args: health?.executorStatus ? [health.executorStatus] : [],
    detailKey: health && health.executorPort !== null ? 'port' : null,
    detailArgs: health && health.executorPort !== null ? [health.executorPort] : [],
  });

  // ③ 中台注册
  rows.push({
    id: 'adminReg',
    state: adminRegistrationState(health?.adminRegistration),
    valueKey: health?.adminRegistration ? 'registration' : null,
    args: health?.adminRegistration ? [health.adminRegistration] : [],
    detailKey: null,
    detailArgs: [],
  });

  // ④ 心跳通道
  rows.push({
    id: 'heartbeat',
    state: heartbeatState(health?.heartbeatStatus),
    valueKey: health?.heartbeatStatus ? 'heartbeat' : null,
    args: health?.heartbeatStatus ? [health.heartbeatStatus] : [],
    detailKey: null,
    detailArgs: [],
  });

  // ⑤ Python 运行时（复用既有 python-env-status，不重新推断）
  // uvPath 是**绝对路径**，与工作目录同理：面板会进截图与工单，只留末两段。
  // （设置页诊断块显示完整路径是刻意的——那里是本地页面；这里是常驻一览。）
  const pyState = pythonState(pythonEnv);
  const uvPathLabel = diagnosticWorkDirDisplay(pythonEnv?.uvPath ?? null);
  rows.push({
    id: 'python',
    state: pyState,
    valueKey: pythonEnv
      ? (uvPathLabel ? 'uvPath' : pythonEnv.uvFromSystemEnv ? 'uvSystem' : 'uvRuntime')
      : null,
    args: uvPathLabel ? [uvPathLabel] : [],
    detailKey: pythonEnv && pythonEnv.poolReadable === false ? 'poolUnreadable' : null,
    detailArgs: [],
  });

  // ⑥ Node 运行时版本（来自诊断报告的 runtime 段——主进程注入，渲染层不自报）
  const nodeVersion = runtime?.nodeVersion ? String(runtime.nodeVersion) : '';
  rows.push({
    id: 'node',
    state: nodeVersion && nodeVersion !== 'unknown' ? 'ok' : 'unknown',
    valueKey: nodeVersion && nodeVersion !== 'unknown' ? 'nodeVersion' : null,
    args: nodeVersion && nodeVersion !== 'unknown' ? [nodeVersion] : [],
    detailKey: null,
    detailArgs: [],
  });

  // ⑦ 工作目录可写性（路径只显示末两段）
  const workDirLabel = diagnosticWorkDirDisplay(workDir?.path ?? null);
  const wdState = workDirState(workDir?.writable ?? null, workDir?.exists ?? null);
  rows.push({
    id: 'workDir',
    state: wdState,
    valueKey: workDirLabel ? 'workDirPath' : (workDir?.exists === false ? 'missing' : null),
    args: workDirLabel ? [workDirLabel] : [],
    detailKey: workDir?.probeError ? 'probeError' : null,
    detailArgs: workDir?.probeError ? [workDir.probeError] : [],
  });

  // ⑧ 磁盘可用空间
  const freeHuman = workDir?.freeHuman ?? null;
  rows.push({
    id: 'disk',
    state: diskStateFromFreeBytes(workDir?.freeBytes ?? null),
    valueKey: freeHuman ? 'diskFree' : null,
    args: freeHuman ? [freeHuman] : [],
    detailKey: null,
    detailArgs: [],
  });

  return { rows, summary: summarizeHealthRows(rows) };
}
