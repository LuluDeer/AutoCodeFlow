/**
 * 渲染层与壳之间的唯一接口。
 *
 * 设计要点：
 *   1) 页面只依赖这个接口，不直接摸 window.electronAPI —— 换壳（Electron → Tauri）
 *      时只改这一层；
 *   2) 浏览器里跑（npm run dev）自动落到 mock，读写 localStorage，视觉/交互可以
 *      脱离壳独立评审；
 *   3) 入参在边界处归一，不让任意形状过桥（沿用 V1 bridge-args 的纪律）。
 */

export type UiLanguage = 'zh' | 'en' | 'auto';
export type LogLevel = 'info' | 'debug' | 'error';

export interface AppConfig {
  configured: boolean;
  adminApiUrl: string;
  executorName: string;
  executorHost: string;
  executorPort: number;
  executorAddressPublic: string;
  /** 主动回连中台（NAT 后办公机），V1 同名配置。 */
  pullMode: boolean;
  /** 已保存的令牌（不回传明文）；是否已设置由 hasSavedToken 表达。 */
  executorToken: string;
  hasSavedToken: boolean;
  workDir: string;
  maxConcurrentTasks: number;
  autoStart: boolean;
  autoStartExecutor: boolean;
  notifyEnabled: boolean;
  logLevel: LogLevel;
  uiLanguage: UiLanguage;
  uvPath: string;
  uvPythonInstallDir: string;
  uvPythonInstallMirror: string;
  interpreterDownloadTimeoutMs: number;
  pypiRegistryUrl: string;
}

export interface Ok {
  ok: boolean;
  message?: string;
}

export interface ConnectionProbe extends Ok {
  latencyMs?: number;
}

export interface PortProbe {
  available: boolean;
  reason?: string;
}

export type UvSource = 'configured' | 'bundled' | 'system-env' | 'path' | 'missing';

export interface PythonEnvStatus {
  uvPath: string | null;
  uvSource: UvSource;
  uvConfiguredButMissing: boolean;
  uvStaticallyConfirmed: boolean;
  interpretersDir: string;
  poolEntries: string[];
  poolReadable: boolean;
  mirrorConfigured: boolean;
  pypiConfigured: boolean;
}

export interface UpdateCheck {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface UpdateAvailable {
  version: string;
  current: string;
  previouslyDownloaded: boolean;
  releaseNotes: string;
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateDownloaded {
  version: string;
}

export interface UpdateError {
  message: string;
}


export type ExecutionStatus = 'success' | 'failed' | 'running';

export interface ExecutionRecord {
  id: string;
  taskName: string;
  status: ExecutionStatus;
  executorName: string;
  /** ISO 时间戳 */
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  logPath: string;
}

export interface LogChunk {
  lines: string[];
  /** 下一批起始行号（已读全时为总行数） */
  nextLine: number;
  eof: boolean;
}


export type AppStatus = 'running' | 'idle' | 'error';


export type ExecutorStatus = 'stopped' | 'pending' | 'online' | 'offline';

export interface ExecutorState {
  status: ExecutorStatus;
  pid: number | null;
  version: string;
  host: string;
  port: number;
  uptimeSec: number;
  concurrency: { running: number; max: number; queue: number };
  lastHeartbeatAt: string | null;
}

export interface AppRelease {
  releaseKey: string;
  version: string | null;
  deploymentId: string;
  isCurrent: boolean;
  deployedAt: string | null;
  hasLog: boolean;
  logPath: string;
}

export interface InstalledApp {
  id: string;
  name: string;
  version: string;
  releaseKey: string;
  installedAt: string;
  lastRunAt: string | null;
  runningCount: number;
  status: AppStatus;
  path: string;
  logPath: string;
  sizeBytes: number;
  /** 同一 appId 下的 release 数量（V1 的 apps:list 是「每个 release 一条」，V2 按应用归并）。 */
  releaseCount: number;
  hasLog: boolean;
  /** `current` 是否指向这个 release；false 表示没有激活版本（部署未完成/手工删过）。 */
  isCurrent: boolean;
  /** 部署时的 runMode（daemon / once / scheduled），旧部署为 null。 */
  runMode: string | null;
  /** 没有任何已完成的 release 时为 incomplete（正在部署 / 部署失败）。 */
  deploymentState: 'ready' | 'incomplete';
  /** 该应用下的所有 release（按部署时间倒序）。 */
  releases: AppRelease[];
}

export interface FileResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
  message?: string;
}

export interface BatchUninstallResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  results?: Array<{ appId: string; ok: boolean; error?: string }>;
}

export interface DesktopBridge {
  readonly kind: 'electron' | 'mock';
  getConfig(): Promise<AppConfig>;
  saveConfig(cfg: AppConfig): Promise<Ok>;
  /** 首次启动向导：保存并关闭向导窗口（V1 主进程会顺手唤回主窗）。 */
  saveAndCloseWizard(cfg: AppConfig): Promise<Ok>;
  /** 托盘菜单请求切换 Tab（'status' | 'history' | 'apps' | 'config'）。 */
  onSwitchTab(cb: (tab: string) => void): () => void;
  testConnection(url: string): Promise<ConnectionProbe>;
  checkPort(port: number, host?: string): Promise<PortProbe>;
  getPythonEnvStatus(): Promise<PythonEnvStatus>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enable: boolean): Promise<Ok>;
  openWizard(): Promise<Ok>;
  exportDiagnostics(): Promise<{ ok: boolean; path?: string; message?: string }>;
  exportConfig(): Promise<FileResult>;
  importConfig(): Promise<FileResult & { reloadError?: string; restartDeferred?: boolean }>;
  checkForUpdate(): Promise<UpdateCheck>;
  downloadUpdate(): Promise<Ok>;
  installUpdate(): Promise<Ok>;
  onUpdateAvailable(cb: (payload: UpdateAvailable) => void): () => void;
  onUpdateProgress(cb: (payload: UpdateProgress) => void): () => void;
  onUpdateDownloaded(cb: (payload: UpdateDownloaded) => void): () => void;
  onUpdateError(cb: (payload: UpdateError) => void): () => void;
  getHistory(): Promise<ExecutionRecord[]>;
  readExecLog(id: string): Promise<LogChunk>;
  clearHistory(): Promise<Ok>;
  exportExecLog(id: string): Promise<FileResult>;
  revealExecLog(id: string): Promise<Ok>;
  openLogFolder(): Promise<Ok>;
  onHistoryChanged(cb: () => void): () => void;
  getExecutorStatus(): Promise<ExecutorState>;
  startExecutor(): Promise<Ok>;
  stopExecutor(): Promise<Ok>;
  onExecutorStatusChange(cb: (status: ExecutorStatus) => void): () => void;
  onLogLine(cb: (line: string) => void): () => void;
  getTodayLogs(): Promise<string[]>;
  listApps(): Promise<InstalledApp[]>;
  getRunningApps(): Promise<Record<string, { pid?: number; running?: boolean }>>;
  readAppLog(logPath: string): Promise<LogChunk>;
  openAppFolder(id: string): Promise<Ok>;
  uninstallApp(id: string): Promise<FileResult>;
  uninstallApps(ids: string[]): Promise<BatchUninstallResult>;
  deleteAppRelease(appId: string, releaseKey: string, deploymentId: string): Promise<FileResult>;
  openReleaseFolder(appId: string, releaseKey: string): Promise<Ok>;
  minimizeWindow(): Promise<void>;
  toggleMaximize(): Promise<void>;
  closeWindow(): Promise<void>;
}

const STORAGE_KEY = 'acf-desktop-v2-config';

const DEFAULTS: AppConfig = {
  configured: true,
  adminApiUrl: 'ws://127.0.0.1:8001',
  executorName: 'executor-python-local',
  executorHost: '0.0.0.0',
  executorPort: 8001,
  executorAddressPublic: '',
  pullMode: false,
  executorToken: '',
  hasSavedToken: true,
  workDir: '/home/yongsheng/.config/autocodeflow/executor/workspace',
  maxConcurrentTasks: 4,
  autoStart: false,
  autoStartExecutor: true,
  notifyEnabled: true,
  logLevel: 'info',
  uiLanguage: 'auto',
  uvPath: '',
  uvPythonInstallDir: '/home/yongsheng/.config/autocodeflow/interpreters',
  uvPythonInstallMirror: '',
  interpreterDownloadTimeoutMs: 0,
  pypiRegistryUrl: '',
};

const delay = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function normalizeConfig(raw: Partial<AppConfig> | null | undefined): AppConfig {
  const merged = { ...DEFAULTS, ...(raw ?? {}) };
  return {
    ...merged,
    hasSavedToken: Boolean(merged.hasSavedToken ?? merged.executorToken),
    executorPort: Number(merged.executorPort) || DEFAULTS.executorPort,
    maxConcurrentTasks: Number(merged.maxConcurrentTasks) || DEFAULTS.maxConcurrentTasks,
  };
}

function readMockConfig(): AppConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeConfig(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeMockConfig(cfg: AppConfig): void {
  try {
    // 令牌不落 localStorage（mock 不等于真存储）
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cfg, executorToken: '' }));
  } catch {
    /* 隐私模式等场景静默降级 */
  }
}


const HISTORY_KEY = 'acf-desktop-v2-history';

const TASK_POOL = [
  '日报汇总',
  '库存同步',
  '订单对账',
  '发票归档',
  '渠道价格抓取',
  '客户标签刷新',
  '周报生成',
  '退款单核销',
  '物流轨迹回填',
  '商品详情同步',
];

function seedHistory(): ExecutionRecord[] {
  const now = Date.now();
  const records: ExecutionRecord[] = [];
  for (let i = 0; i < 18; i += 1) {
    const failed = i % 5 === 1;
    const running = i === 0;
    const started = new Date(now - i * 37 * 60 * 1000 - (i % 4) * 13_000);
    records.push({
      id: `exec_${(0x9c21 + i * 7919).toString(16)}`,
      taskName: TASK_POOL[i % TASK_POOL.length],
      status: running ? 'running' : failed ? 'failed' : 'success',
      executorName: 'executor-python-local',
      startedAt: started.toISOString(),
      durationMs: running ? 0 : 420 + ((i * 1873) % 6800),
      exitCode: running ? null : failed ? 1 : 0,
      logPath: `/home/yongsheng/.config/autocodeflow/executor/logs/${started.toISOString().slice(0, 10)}/exec_${i}.log`,
    });
  }
  return records;
}

function readHistoryMock(): ExecutionRecord[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw) as ExecutionRecord[];
    const seeded = seedHistory();
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(seeded));
    return seeded;
  } catch {
    return seedHistory();
  }
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function buildMockLog(record: ExecutionRecord): string[] {
  const lines: string[] = [];
  const base = new Date(record.startedAt).getTime();
  const count = 160 + (hash(record.id) % 240);
  const stamp = (offset: number) => {
    const d = new Date(base + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  lines.push(`${stamp(0)} INFO  executor 收到任务 ${record.taskName} (${record.id})`);
  lines.push(`${stamp(120)} INFO  解析任务声明 params=schema_version=3`);
  lines.push(`${stamp(260)} INFO  准备 Python 3.12.4 解释器 (uv cache hit)`);
  if (record.status === 'failed') {
    lines.push(`${stamp(480)} WARN  PYPI_MIRROR 未配置，回退官方源`);
  }
  lines.push(`${stamp(520)} INFO  工作目录 /tmp/acf-visual-${record.id.slice(-4)}/workspace`);
  for (let i = 0; i < count; i += 1) {
    const t = 600 + i * 37;
    if (i === Math.floor(count * 0.42)) {
      lines.push(`${stamp(t)} INFO  step ${i}: 处理分片 ${i}/${count} rows=${120 + (i % 40)}`);
    } else if (record.status === 'failed' && i === count - 12) {
      lines.push(`${stamp(t)} ERROR TimeoutError: upstream 响应超过 30000ms (attempt 3/3)`);
    } else if (record.status === 'failed' && i > count - 12) {
      lines.push(`${stamp(t)} INFO  清理临时文件 ${i - (count - 12)} 个`);
    } else {
      lines.push(
        `${stamp(t)} INFO  ${i % 9 === 0 ? 'flush' : 'batch'} #${String(i).padStart(3, '0')} rows=${110 + ((i * 17) % 90)} elapsed=${(i * 0.37).toFixed(1)}s`,
      );
    }
  }
  if (record.status === 'success') {
    lines.push(`${stamp(600 + count * 37 + 40)} INFO  任务完成 exit=0 duration=${record.durationMs}ms`);
  } else if (record.status === 'failed') {
    lines.push(`${stamp(600 + count * 37 + 40)} ERROR 任务失败 exit=1，已上报控制面`);
  } else {
    lines.push(`${stamp(600 + count * 37 + 40)} INFO  仍在执行，等待下一次心跳…`);
  }
  return lines;
}

function normalizeRecord(raw: Record<string, unknown>, index: number): ExecutionRecord {
  const str = (keys: string[], fallback = '') => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value) return value;
    }
    return fallback;
  };
  const num = (keys: string[], fallback = 0) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return fallback;
  };
  const time = (keys: string[], fallback: string) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
      }
    }
    return fallback;
  };
  const rawStatus = str(['status', 'result', 'state'], 'success').toLowerCase();
  const status: ExecutionStatus =
    rawStatus.includes('fail') || rawStatus.includes('error')
      ? 'failed'
      : rawStatus.includes('run') || rawStatus.includes('pending')
        ? 'running'
        : 'success';
  const startedAt = time(
    ['startedAt', 'startTime', 'timestamp', 'createdAt'],
    new Date().toISOString(),
  );
  const endTime = num(['endTime', 'finishedAt'], 0);
  const startedMs = new Date(startedAt).getTime();
  const derivedDuration =
    endTime > 0 && Number.isFinite(startedMs) ? Math.max(0, endTime - startedMs) : 0;
  return {
    id: str(['id', 'executionId', 'execId'], `exec_${index}`),
    taskName: str(['taskName', 'task', 'name', 'jobName'], '未命名任务'),
    status,
    executorName: str(['executorName', 'executor', 'executorId'], '—'),
    startedAt,
    durationMs: num(['durationMs', 'duration', 'elapsedMs'], derivedDuration),
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    logPath: str(['logPath', 'logFile'], ''),
  };
}


let mockApps: InstalledApp[] = [
  {
    id: 'app_report_daily',
    name: '日报生成器',
    version: '1.4.2',
    releaseKey: 'rel_20261012_01',
    installedAt: new Date(Date.now() - 6 * 86400000).toISOString(),
    lastRunAt: new Date(Date.now() - 42 * 60000).toISOString(),
    runningCount: 2,
    status: 'running',
    path: '/home/yongsheng/.config/autocodeflow/executor/apps/app_report_daily',
    logPath: '/home/yongsheng/.config/autocodeflow/executor/apps/app_report_daily/logs/app.log',
    sizeBytes: 18_432_000,
    releaseCount: 1,
    hasLog: true,
    isCurrent: true,
    runMode: 'daemon',
    deploymentState: 'ready',
    releases: [],
  },
  {
    id: 'app_inventory_sync',
    name: '库存同步',
    version: '2.0.1',
    releaseKey: 'rel_20261009_03',
    installedAt: new Date(Date.now() - 13 * 86400000).toISOString(),
    lastRunAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    runningCount: 0,
    status: 'idle',
    path: '/home/yongsheng/.config/autocodeflow/executor/apps/app_inventory_sync',
    logPath: '/home/yongsheng/.config/autocodeflow/executor/apps/app_inventory_sync/logs/app.log',
    sizeBytes: 9_830_400,
    releaseCount: 1,
    hasLog: true,
    isCurrent: true,
    runMode: 'daemon',
    deploymentState: 'ready',
    releases: [],
  },
  {
    id: 'app_order_reconcile',
    name: '订单对账',
    version: '1.2.8',
    releaseKey: 'rel_20260921_02',
    installedAt: new Date(Date.now() - 24 * 86400000).toISOString(),
    lastRunAt: new Date(Date.now() - 26 * 3600000).toISOString(),
    runningCount: 0,
    status: 'idle',
    path: '/home/yongsheng/.config/autocodeflow/executor/apps/app_order_reconcile',
    logPath: '/home/yongsheng/.config/autocodeflow/executor/apps/app_order_reconcile/logs/app.log',
    sizeBytes: 12_582_912,
    releaseCount: 1,
    hasLog: true,
    isCurrent: true,
    runMode: 'daemon',
    deploymentState: 'ready',
    releases: [],
  },
  {
    id: 'app_invoice_archive',
    name: '发票归档',
    version: '0.9.4',
    releaseKey: 'rel_20260918_01',
    installedAt: new Date(Date.now() - 31 * 86400000).toISOString(),
    lastRunAt: null,
    runningCount: 0,
    status: 'error',
    path: '/home/yongsheng/.config/autocodeflow/executor/apps/app_invoice_archive',
    logPath: '/home/yongsheng/.config/autocodeflow/executor/apps/app_invoice_archive/logs/app.log',
    sizeBytes: 4_194_304,
    releaseCount: 1,
    hasLog: true,
    isCurrent: true,
    runMode: 'daemon',
    deploymentState: 'ready',
    releases: [],
  },
];

function mockReleases(app: InstalledApp): AppRelease[] {
  return [
    {
      releaseKey: app.releaseKey,
      version: app.version,
      deploymentId: app.releaseKey.split('-').slice(1).join('-') || app.releaseKey,
      isCurrent: true,
      deployedAt: app.installedAt,
      hasLog: app.hasLog,
      logPath: app.logPath,
    },
  ];
}

function mockRemoveApps(ids: string[]): void {
  const set = new Set(ids);
  mockApps = mockApps.filter((app) => !set.has(app.id));
}

function buildAppLog(logPath: string): string[] {
  const seed = hash(logPath);
  const lines: string[] = [];
  const base = Date.now() - 42 * 60000;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (offset: number) => {
    const d = new Date(base + offset);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  lines.push(`${stamp(0)} INFO  app worker 启动 pid=${8000 + (seed % 900)}`);
  lines.push(`${stamp(80)} INFO  加载 manifest release=${logPath.split('/').slice(-3)[0]}`);
  for (let i = 0; i < 80; i += 1) {
    lines.push(
      `${stamp(120 + i * 420)} INFO  ${i % 5 === 0 ? 'heartbeat' : 'task'} #${String(i).padStart(2, '0')} ok latency=${((seed + i * 37) % 140) + 8}ms`,
    );
  }
  if (logPath.includes('invoice')) {
    lines.push(`${stamp(120 + 80 * 420)} ERROR 依赖缺失: reportlab>=4.0 未安装`);
  }
  return lines;
}

type AppEntry = InstalledApp & { isCurrent: boolean; deployedAtMs: number };

function normalizeApp(raw: Record<string, unknown>, index: number): AppEntry {
  const str = (keys: string[], fallback = '') => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && value) return value;
    }
    return fallback;
  };
  const num = (keys: string[], fallback = 0) => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return fallback;
  };
  const runningCount = num(['runningCount', 'running', 'pids'], 0);
  const deployedAtMs = num(['deployedAt'], 0);
  return {
    id: str(['id', 'appId'], `app_${index}`),
    name: str(['name', 'title', 'appName'], str(['id', 'appId'], '未命名应用')),
    version: str(['version', 'appVersion'], '0.0.0'),
    releaseKey: str(['releaseKey', 'release'], ''),
    installedAt:
      deployedAtMs > 0
        ? new Date(deployedAtMs).toISOString()
        : str(['installedAt', 'installTime', 'createdAt'], new Date().toISOString()),
    lastRunAt: str(['lastRunAt', 'lastRun', 'updatedAt']) || null,
    runningCount,
    status: (runningCount > 0 ? 'running' : (str(['status']) || 'idle')) as AppStatus,
    path: str(['appRoot', 'path', 'installPath', 'dir', 'deployDir']),
    logPath: str(['logPath', 'logFile']),
    sizeBytes: num(['sizeBytes', 'size'], 0),
    releaseCount: 1,
    hasLog: raw.hasLog === true || str(['logPath', 'logFile']) !== '',
    isCurrent: raw.isCurrent === true,
    runMode: str(['runMode']) || null,
    deploymentState: str(['releaseKey']) === '' ? 'incomplete' : 'ready',
    deployedAtMs,
    releases: [
      {
        releaseKey: str(['releaseKey']),
        version: raw.version == null ? null : String(raw.version),
        deploymentId: str(['deploymentId']),
        isCurrent: raw.isCurrent === true,
        deployedAt: num(['deployedAt'], 0) > 0 ? new Date(num(['deployedAt'], 0)).toISOString() : null,
        hasLog: raw.hasLog === true,
        logPath: str(['logPath', 'logFile']),
      },
    ],
  };
}


let mockExecutor: ExecutorState = {
  status: 'online',
  pid: 4812,
  version: '1.9.1',
  host: '127.0.0.1',
  port: 8001,
  uptimeSec: 8040,
  concurrency: { running: 4, max: 8, queue: 0 },
  lastHeartbeatAt: new Date().toISOString(),
};

const statusListeners = new Set<(status: ExecutorStatus) => void>();

function emitStatus(status: ExecutorStatus) {
  mockExecutor = {
    ...mockExecutor,
    status,
    lastHeartbeatAt: new Date().toISOString(),
  };
  statusListeners.forEach((listener) => listener(status));
}

const LOG_TEMPLATES = [
  '收到任务 task_9c21「日报汇总」 → 排队',
  '准备 Python 3.12.4 解释器 (uv cache hit)',
  '任务开始执行 pid=8821',
  'batch #017 rows=129 elapsed=6.3s',
  'flush #018 rows=146 elapsed=6.7s',
  '已上报执行结果 (status=success, duration=4218ms)',
  '复用解释器池 /home/yongsheng/.../interpreters/py312',
  '心跳 ack 200 (rtt=18ms)',
];

function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayLogSeed(): string[] {
  const start = Date.now() - 14 * 60_000;
  const at = (offset: number) => new Date(start + offset).toTimeString().slice(0, 8);
  const lines = [
    `${at(0)} INFO  executor 已连接 control-plane (ws://127.0.0.1:8001)`,
    `${at(800)} INFO  注册执行器 id=exe_7f3a · 并发上限 8 · 标签 [linux, python]`,
    `${at(2000)} INFO  心跳已启动 interval=2000ms`,
    `${at(44_000)} INFO  收到任务 task_9c21「日报汇总」 → 排队`,
    `${at(45_000)} WARN  PYPI_MIRROR 未配置，回退官方源，首次安装可能较慢`,
    `${at(47_000)} INFO  任务开始执行 pid=8821`,
  ];
  for (let i = 0; i < 12; i += 1) {
    lines.push(
      `${at(48_000 + i * 4800)} INFO  ${i % 4 === 3 ? 'flush' : 'batch'} #${String(i).padStart(3, '0')} rows=${110 + ((i * 17) % 90)} elapsed=${(i * 0.4).toFixed(1)}s`,
    );
  }
  lines.push(`${at(106_000)} ERROR task_9c21 失败: TimeoutError: upstream 响应超过 30000ms`);
  lines.push(`${at(107_000)} INFO  已上报执行结果 (status=failed, duration=7421ms)`);
  return lines;
}

const updateListeners = {
  available: new Set<(payload: UpdateAvailable) => void>(),
  progress: new Set<(payload: UpdateProgress) => void>(),
  downloaded: new Set<(payload: UpdateDownloaded) => void>(),
  error: new Set<(payload: UpdateError) => void>(),
};

function emitUpdate(channel: keyof typeof updateListeners, payload: unknown): void {
  (updateListeners[channel] as Set<(value: unknown) => void>).forEach((listener) =>
    listener(payload),
  );
}

const mockBridge: DesktopBridge = {
  kind: 'mock',

  async getConfig() {
    await delay(160);
    return readMockConfig();
  },

  async saveConfig(cfg) {
    await delay(320);
    writeMockConfig({ ...cfg, configured: true });
    return { ok: true };
  },

  async saveAndCloseWizard(cfg) {
    await delay(320);
    writeMockConfig({ ...cfg, configured: true });
    return { ok: true };
  },

  onSwitchTab() {
    return () => {};
  },

  async testConnection(url) {
    await delay(420);
    if (!/^(wss?|https?):\/\/.+/.test(url.trim())) {
      return { ok: false, message: '地址必须以 ws://、wss://、http:// 或 https:// 开头' };
    }
    if (/bad|invalid/i.test(url)) {
      return { ok: false, message: 'ECONNREFUSED：对端没有在监听' };
    }
    const local = /127\.0\.0\.1|localhost/.test(url);
    return { ok: true, latencyMs: local ? 14 : 96 };
  },

  async checkPort(port, host) {
    await delay(260);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { available: false, reason: '端口必须在 1–65535 之间' };
    }
    if ([22, 80, 443].includes(port)) {
      return { available: false, reason: `端口 ${port} 被系统服务占用` };
    }
    if (port === 8001) {
      return { available: false, reason: '端口 8001 已被当前执行器实例占用' };
    }
    void host;
    return { available: true };
  },

  async getPythonEnvStatus() {
    await delay(180);
    return {
      uvPath: '/usr/local/bin/uv',
      uvSource: 'path',
      uvConfiguredButMissing: false,
      uvStaticallyConfirmed: true,
      interpretersDir: '/home/yongsheng/.config/autocodeflow/interpreters',
      poolEntries: ['cpython-3.12.4', 'cpython-3.11.9'],
      poolReadable: true,
      mirrorConfigured: false,
      pypiConfigured: false,
    };
  },

  async getAutoLaunch() {
    await delay(80);
    return false;
  },

  async setAutoLaunch() {
    await delay(120);
    return { ok: true };
  },

  async openWizard() {
    await delay(120);
    return { ok: true };
  },

  async exportConfig() {
    await delay(500);
    return { ok: true, path: '/tmp/config-backup.json' };
  },

  async importConfig() {
    await delay(500);
    return { ok: false, canceled: true };
  },

  async exportDiagnostics() {
    await delay(600);
    return { ok: true, path: '/home/yongsheng/Downloads/acf-diagnostics.json' };
  },

  async checkForUpdate() {
    await delay(650);
    emitUpdate('available', {
      version: '2.1.0',
      current: '2.0.0-preview',
      previouslyDownloaded: false,
      releaseNotes:
        '• 历史页日志支持虚拟滚动\n• 修复托盘切换 Tab 偶发失效\n• 配置页新增解释器镜像预设',
    });
    return { ok: true };
  },

  async downloadUpdate() {
    const total = 84_000_000;
    for (let step = 1; step <= 20; step += 1) {
      await delay(120);
      const percent = step * 5;
      emitUpdate('progress', {
        percent,
        transferred: Math.round((total * percent) / 100),
        total,
        bytesPerSecond: 6_200_000,
      });
    }
    emitUpdate('downloaded', { version: '2.1.0' });
    return { ok: true };
  },

  async installUpdate() {
    await delay(200);
    return { ok: true };
  },

  onUpdateAvailable(cb) {
    updateListeners.available.add(cb);
    return () => updateListeners.available.delete(cb);
  },
  onUpdateProgress(cb) {
    updateListeners.progress.add(cb);
    return () => updateListeners.progress.delete(cb);
  },
  onUpdateDownloaded(cb) {
    updateListeners.downloaded.add(cb);
    return () => updateListeners.downloaded.delete(cb);
  },
  onUpdateError(cb) {
    updateListeners.error.add(cb);
    return () => updateListeners.error.delete(cb);
  },


  async getHistory() {
    await delay(200);
    return readHistoryMock();
  },

  async readExecLog(id) {
    await delay(240);
    const record = readHistoryMock().find((item) => item.id === id);
    const lines = record ? buildMockLog(record) : [];
    return { lines, nextLine: lines.length, eof: true };
  },

  async clearHistory() {
    await delay(320);
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify([]));
    } catch {
      /* 隐私模式静默 */
    }
    return { ok: true };
  },

  async exportExecLog(id) {
    await delay(520);
    return { ok: true, path: `/home/yongsheng/Downloads/${id}.log` };
  },

  async revealExecLog() {
    await delay(120);
    return { ok: true };
  },

  async openLogFolder() {
    await delay(120);
    return { ok: true };
  },

  onHistoryChanged() {
    return () => {};
  },


  async listApps() {
    await delay(220);
    return mockApps.map((app) => ({ ...app, releases: mockReleases(app) }));
  },

  async getRunningApps() {
    await delay(80);
    return {};
  },


  async getExecutorStatus() {
    await delay(140);
    return { ...mockExecutor };
  },

  async startExecutor() {
    emitStatus('pending');
    window.setTimeout(() => emitStatus('online'), 900);
    return { ok: true };
  },

  async stopExecutor() {
    emitStatus('stopped');
    return { ok: true };
  },

  onExecutorStatusChange(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  },

  onLogLine(cb) {
    let index = 0;
    const timer = window.setInterval(() => {
      const template = LOG_TEMPLATES[index % LOG_TEMPLATES.length];
      index += 1;
      cb(`${stampNow()} INFO  ${template}`);
    }, 2400);
    return () => window.clearInterval(timer);
  },

  async getTodayLogs() {
    await delay(120);
    return todayLogSeed();
  },

  async readAppLog(logPath) {
    await delay(180);
    const lines = buildAppLog(logPath);
    return { lines, nextLine: lines.length, eof: true };
  },

  async openAppFolder() {
    await delay(100);
    return { ok: true };
  },

  async uninstallApp(id) {
    await delay(680);
    mockRemoveApps([id]);
    return { ok: true, path: id };
  },

  async uninstallApps(ids) {
    await delay(900);
    mockRemoveApps(ids);
    return { ok: true, results: ids.map((appId) => ({ appId, ok: true })) };
  },

  async deleteAppRelease(appId, releaseKey) {
    await delay(420);
    return { ok: true, path: `${appId}/${releaseKey}` };
  },

  async openReleaseFolder() {
    await delay(100);
    return { ok: true };
  },

  async minimizeWindow() {},
  async toggleMaximize() {},
  async closeWindow() {},
};

type RawBridge = Record<string, (...args: never[]) => Promise<unknown>>;

function getRawBridge(): RawBridge | null {
  const candidate = (window as unknown as { electronAPI?: RawBridge }).electronAPI;
  return candidate ?? null;
}

function createElectronBridge(api: RawBridge): DesktopBridge {
  const call = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const fn = api[name];
    if (typeof fn !== 'function') throw new Error(`桥方法缺失：${name}`);
    return (await fn(...(args as never[]))) as T;
  };

  return {
    kind: 'electron',
    getConfig: async () => normalizeConfig((await call<Partial<AppConfig>>('getConfig')) ?? null),
    saveConfig: (cfg) => call<Ok>('saveConfig', cfg as unknown as never),
    saveAndCloseWizard: (cfg) => call<Ok>('saveAndCloseWizard', cfg as unknown as never),
    onSwitchTab(cb) {
      const api = raw as unknown as {
        onSwitchTab?: (handler: (tab: string) => void) => () => void;
      };
      if (!api.onSwitchTab) return () => {};
      return api.onSwitchTab(cb);
    },
    testConnection: (url) => call<ConnectionProbe>('testConnection', url as never),
    checkPort: (port, host) =>
      call<PortProbe>('checkPort', port as never, host as never),
    getPythonEnvStatus: () => call<PythonEnvStatus>('getPythonEnvStatus'),
    getAutoLaunch: () => call<boolean>('getAutoLaunch'),
    setAutoLaunch: (enable) => call<Ok>('setAutoLaunch', enable as never),
    openWizard: () => call<Ok>('openWizard'),
    exportDiagnostics: () =>
      call<{ ok: boolean; path?: string; message?: string }>('exportDiagnostics'),
    exportConfig: () => call<FileResult>('exportConfig'),
    importConfig: () =>
      call<FileResult & { reloadError?: string; restartDeferred?: boolean }>('importConfig'),
    checkForUpdate: () => call<UpdateCheck>('checkForUpdate'),
    downloadUpdate: () => call<Ok>('downloadUpdate'),
    installUpdate: () => call<Ok>('installUpdate'),
    onUpdateAvailable(cb) {
      const api = raw as unknown as {
        onUpdateAvailable?: (handler: (payload: UpdateAvailable) => void) => () => void;
      };
      if (!api.onUpdateAvailable) return () => {};
      return api.onUpdateAvailable(cb);
    },
    onUpdateProgress(cb) {
      const api = raw as unknown as {
        onUpdateProgress?: (handler: (payload: UpdateProgress) => void) => () => void;
      };
      if (!api.onUpdateProgress) return () => {};
      return api.onUpdateProgress(cb);
    },
    onUpdateDownloaded(cb) {
      const api = raw as unknown as {
        onUpdateDownloaded?: (handler: (payload: UpdateDownloaded) => void) => () => void;
      };
      if (!api.onUpdateDownloaded) return () => {};
      return api.onUpdateDownloaded(cb);
    },
    onUpdateError(cb) {
      const api = raw as unknown as {
        onUpdateError?: (handler: (payload: UpdateError) => void) => () => void;
      };
      if (!api.onUpdateError) return () => {};
      return api.onUpdateError(cb);
    },

    async getHistory() {
      const raw = await call<unknown>('getHistory');
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { records?: unknown })?.records)
          ? ((raw as { records: unknown[] }).records)
          : [];
      return list
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item, index) => normalizeRecord(item, index));
    },

    async readExecLog(id) {
      const raw = await call<unknown>('readLog', id as never);
      if (Array.isArray(raw)) {
        const lines = raw.map((line) => String(line));
        return { lines, nextLine: lines.length, eof: true };
      }
      const obj = (raw ?? {}) as { lines?: unknown; content?: unknown; next?: unknown };
      const source = Array.isArray(obj.lines)
        ? obj.lines
        : typeof obj.content === 'string'
          ? obj.content.split(/\r?\n/)
          : [];
      const lines = source.map((line) => String(line));
      return {
        lines,
        nextLine: typeof obj.next === 'number' ? obj.next : lines.length,
        eof: lines.length === 0,
      };
    },

    clearHistory: () => call<Ok>('clearHistory'),
    exportExecLog: (id) => call<FileResult>('exportExecLog', id as never),
    revealExecLog: (id) => call<Ok>('revealExecLog', id as never),
    openLogFolder: () => call<Ok>('openLogFolder'),

    onHistoryChanged(cb) {
      const api = raw as unknown as {
        onHistoryChanged?: (handler: () => void) => () => void;
      };
      if (!api.onHistoryChanged) return () => {};
      return api.onHistoryChanged(cb);
    },



    async getExecutorStatus() {
      const raw = await call<{
        running?: boolean;
        status?: ExecutorStatus;
        config?: Partial<AppConfig>;
        pid?: number | null;
        startedAt?: number | null;
        version?: string;
        lastHeartbeatAt?: number | null;
      }>('getStatus');
      const cfg = raw?.config ?? {};
      const startedAt = typeof raw?.startedAt === 'number' ? raw.startedAt : null;
      return {
        status: raw?.status ?? (raw?.running ? 'online' : 'stopped'),
        pid: typeof raw?.pid === 'number' ? raw.pid : null,
        version: raw?.version ?? '—',
        host: cfg.executorHost ?? '127.0.0.1',
        port: cfg.executorPort ?? 8001,
        uptimeSec: startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0,
        concurrency: {
          running: 0,
          max: cfg.maxConcurrentTasks ?? 4,
          queue: 0,
        },
        lastHeartbeatAt:
          typeof raw?.lastHeartbeatAt === 'number'
            ? new Date(raw.lastHeartbeatAt).toISOString()
            : null,
      };
    },

    startExecutor: () => call<Ok>('startExecutor'),
    stopExecutor: () => call<Ok>('stopExecutor'),

    onExecutorStatusChange(cb) {
      const api = raw as unknown as {
        onStatusChange?: (handler: (status: string) => void) => () => void;
      };
      if (!api.onStatusChange) return () => {};
      return api.onStatusChange((status) => cb(status as ExecutorStatus));
    },

    onLogLine(cb) {
      const api = raw as unknown as {
        onLogLine?: (handler: (line: string) => void) => () => void;
      };
      if (!api.onLogLine) return () => {};
      return api.onLogLine(cb);
    },

    async getTodayLogs() {
      const raw = await call<{ lines?: unknown }>('getTodayLogs');
      const lines = Array.isArray(raw?.lines) ? raw.lines.map((line) => String(line)) : [];
      return lines;
    },

    async getRunningApps() {
      return call<Record<string, { pid?: number; running?: boolean }>>('getRunningApps');
    },

    async listApps() {
      const raw = await call<unknown>('listApps');
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { apps?: unknown })?.apps)
          ? (raw as { apps: unknown[] }).apps
          : [];
      const entries = list
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item, index) => normalizeApp(item, index));

      // V1 的 apps:list 是「每个 release 一条」；V2 的卡片按应用归并，
      // 优先 current，其次最近部署的那次。
      const grouped = new Map<string, AppEntry[]>();
      for (const entry of entries) {
        const group = grouped.get(entry.id);
        if (group) group.push(entry);
        else grouped.set(entry.id, [entry]);
      }
      // 运行态只能从执行器 /api/app-status 取（进程登记在 executor 进程内）；
      // 执行器离线时返回空表，UI 保持“就绪”，不冒充运行中。
      let running: Record<string, { pid?: number; running?: boolean }> = {};
      try {
        running = await call('getRunningApps');
      } catch {
        running = {};
      }

      return [...grouped.values()].map((group) => {
        const chosen =
          group.find((entry) => entry.isCurrent) ??
          [...group].sort((a, b) => b.deployedAtMs - a.deployedAtMs)[0];
        const releases = group
          .map((entry) => entry.releases[0])
          .sort((a, b) => (b.deployedAt ?? '').localeCompare(a.deployedAt ?? ''));
        const runningCount = group.filter(
          (entry) => running[entry.releases[0].deploymentId]?.running === true,
        ).length;
        return {
          ...chosen,
          releaseCount: group.length,
          releases,
          runningCount,
          status: runningCount > 0 ? ('running' as const) : chosen.status,
        };
      });
    },

    async readAppLog(logPath) {
      const raw = await call<unknown>('readAppLog', logPath as never);
      // V1 返回 { lines, totalLines }；兼容纯数组与 content 两种历史形态。
      const source = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { lines?: unknown })?.lines)
          ? ((raw as { lines: unknown[] }).lines)
          : typeof (raw as { content?: unknown })?.content === 'string'
            ? (raw as { content: string }).content.split(/\r?\n/)
            : [];
      const lines = source.map((line) => String(line));
      return { lines, nextLine: lines.length, eof: true };
    },

    openAppFolder: (id) => call<Ok>('openAppFolder', id as never),
    uninstallApp: (id) => call<FileResult>('uninstallApp', id as never),
    uninstallApps: (ids) => call<BatchUninstallResult>('uninstallApps', ids as never),
    deleteAppRelease: (appId, releaseKey, deploymentId) =>
      call<FileResult>('deleteAppRelease', appId as never, releaseKey as never, deploymentId as never),
    openReleaseFolder: (appId, releaseKey) =>
      call<Ok>('openReleaseFolder', appId as never, releaseKey as never),

    minimizeWindow: async () => {
      await call('minimizeWindow');
    },
    toggleMaximize: async () => {
      await call('toggleMaximizeWindow');
    },
    closeWindow: async () => {
      await call('closeWindow');
    },
  };
}

const raw = getRawBridge();

/** 全局唯一桥。浏览器里是 mock，Electron 里是真桥。 */
export const bridge: DesktopBridge = raw ? createElectronBridge(raw) : mockBridge;

export const DEFAULT_CONFIG = DEFAULTS;
