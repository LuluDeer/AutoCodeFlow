/// <reference types="vite/client" />

// ─────────────────────────────────────────────────────────────────────────────
// renderer 侧的 `window.electronAPI` **全局类型契约**（R196）
//
// ## 为什么需要它（这一段是 R196 修 `no-explicit-any` 时挖出来的）
//
// 此前 `window.electronAPI` **没有任何全局声明** ⇒ 9 个文件各自写了一份
// `declare const window: Window & { electronAPI: {...} }`（Wizard / StatusWindow /
// AppsPage / HistoryPage / ConfigPage / config/use-config-io / config/use-config-source /
// config/use-config-writer / main.tsx），**彼此字段集不一致**（有的含 `getHealthPanel`、
// 有的不含；同一方法在不同文件里**签名也不同**）。
//
// 两处直接代价：
// ① **字段集不一致** ⇒ A 文件加了新字段，B 文件的声明里没有 ⇒ 用到它时又得
//    `as any` 绕过去 ⇒ **12 处 `as any`**（含 `window.electronAPI` 这类）。
// ② **局部 `declare const window` 会遮蔽全局 `Window`**（注释里已记），
//    且**同一份契约抄 9 遍** ⇒ 改 preload 的暴露面要改 9 处，漏一处就是**静默不一致**。
//
// ## 本文件的取法：**以 preload 的真实暴露面为准**（不是手抄）
//
// 字段集**从 `src/preload/index.ts` 的 `exposeInMainWorld('electronAPI', {...})` 提取**
// （62 个方法）。⚠️ renderer 是**独立 tsconfig**（不继承根配置）⇒ 不能
// `import type` preload（那会把 electron 变成编译期依赖，破坏 renderer 的独立性），
// 所以这里手写一份**形状声明**，并由 `scripts/check-renderer-api-contract.mjs` 之类
// 的**契约守卫**盯着 preload 与本文件的一致性（见下方「一致性怎么保证」）。
//
// ## 一致性怎么保证（**别让这份声明又变成第 10 份不一致的**）
//
// `src/preload/index.ts` 是**唯一真值源**；本文件是它的**类型投影**。
// ⇒ 每次改 preload 的暴露面，**必须**同步本文件；
// `npm run typecheck:renderer` 会在 renderer 侧用错字段时报红（**不是**自动的，
//   所以下面的「可选性」选择很重要：多数字段标 `?` ⇒ 少写一个不报红，
//   **多写一个会报红**（`Object literal may only specify known properties`））。
//
// ## 字段是**必选**（不是可选）
//
// 局部声明原本就是**必选**字段（各文件调用时**没有** `?.`）⇒ 全局声明保持必选，
// 这样**删掉那 9 份局部声明后，所有调用点一行都不用改**（= 纯等价替换）。
// ⚠️ 副作用：preload 若**不再暴露**某个方法，renderer 侧会**立刻**报红
// （这正是我们要的：暴露面变了就该被看见）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * renderer 侧看到的 `window.electronAPI`。
 *
 * ⚠️ **跨 IPC 边界的返回值用 `any`**（下面若干方法）：这些数据是 **main 端 handler 的返回值**，
 * 经 `ipcRenderer.invoke` 回到 renderer ⇒ 精确类型**在 main 端才是权威**（`ipc-handlers.ts` 的
 * `ipcMain.handle(...)`）。在 renderer 侧再抄一份**必然漂移**（这正是本轮要消灭的那种重复契约），
 * 且 `invoke` 的静态返回类型本就是 `Promise<any>`。
 * ⇒ renderer 侧调用后**自己**收窄（各页面已有自己的 `LogReadResultLike` 之类的局部形状）。
 */
interface ElectronApiBridge {
  // ── 配置 ──
  getConfig: () => Promise<Record<string, unknown>>;
  saveConfig: (cfg: Record<string, unknown>) => Promise<any>;
  saveAndCloseWizard: (cfg: Record<string, unknown>) => Promise<any>;
  testConnection: (url: string) => Promise<{ ok: boolean; message: string }>;
  testInterpreterSource: () => Promise<{
    official: { ok: boolean; ms: number; detail: string };
    mirror: { ok: boolean; ms: number; detail: string };
  }>;
  openWizard: () => Promise<any>;
  checkPort: (port: number, host?: string) => Promise<any>;
  getPythonEnvStatus: () => Promise<any>;
  exportConfig: () => Promise<any>;
  importConfig: () => Promise<any>;

  // ── 诊断 ──
  exportDiagnosticReport: () => Promise<any>;
  getHealthPanel: () => Promise<any>;

  // ── 执行器 / agent ──
  getAgentStatus: () => Promise<any>;
  startExecutor: () => Promise<{ ok: boolean }>;
  stopExecutor: () => Promise<{ ok: boolean }>;
  getStatus: () => Promise<{
    running: boolean;
    status: string;
    config: Record<string, unknown>;
  }>;

  // ── 开机自启 ──
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enable: boolean) => Promise<any>;

  // ── 网络 / 窗口 ──
  getLocalIPs: () => Promise<any>;
  minimizeWindow: () => Promise<any>;
  getWindowState: () => Promise<any>;
  toggleMaximizeWindow: () => Promise<any>;
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
  closeWindow: () => Promise<any>;

  // ── 历史 ──
  getHistory: () => Promise<any>;
  onHistoryChanged: (cb: () => void) => () => void;
  onConfigChanged: (cb: () => void) => () => void;
  clearHistory: () => Promise<any>;
  readLog: (executionId: string, fromLine?: number) => Promise<any>;
  revealExecLog: (executionId: string) => Promise<any>;
  openTaskLogFolder: () => Promise<any>;
  exportExecLog: (executionId: string) => Promise<any>;

  // ── 日志 ──
  getTodayLogs: () => Promise<{ lines: string[]; date: string }>;
  listLogFiles: () => Promise<Array<{ label: string; path: string; date: string }>>;
  openLogFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;

  // ── 应用 ──
  listApps: () => Promise<any>;
  readAppLog: (logPath: string, fromLine?: number) => Promise<any>;
  openAppFolder: (appId: string) => Promise<any>;
  openReleaseFolder: (appId: string, releaseKey: string) => Promise<any>;
  uninstallApp: (appId: string) => Promise<any>;
  deleteAppRelease: (appId: string, releaseKey: string, deploymentId: string) => Promise<any>;
  getRunningApps: () => Promise<any>;

  // ── 剪贴板 / 事件订阅 ──
  writeClipboardText: (text: string) => Promise<any>;
  onLogLine: (cb: (line: string) => void) => () => void;
  onStatusChange: (cb: (status: string) => void) => () => void;
  onSwitchTab: (cb: (tab: string) => void) => () => void;

  // ── 更新 ──
  checkForUpdate: () => Promise<any>;
  downloadUpdate: () => Promise<any>;
  cancelUpdateDownload: () => Promise<any>;
  installUpdate: () => Promise<any>;
  onUpdateAvailable: (cb: (payload: {
    version: string;
    current: string;
    previouslyDownloaded: boolean;
    releaseNotes: string;
  }) => void) => () => void;
  onUpdateProgress: (cb: (payload: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void) => () => void;
  onUpdateDownloaded: (cb: (payload: { version: string }) => void) => () => void;
  onUpdateError: (cb: (payload: { message: string }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronApiBridge;
  }
}

export {};
