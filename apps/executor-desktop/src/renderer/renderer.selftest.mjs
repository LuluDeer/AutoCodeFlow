import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const css = readFileSync(resolve(root, 'styles/app.css'), 'utf8');
const app = readFileSync(resolve(root, 'App.tsx'), 'utf8');
const pages = ['AppsPage.tsx', 'ConfigPage.tsx', 'HistoryPage.tsx', 'StatusWindow.tsx', 'Wizard.tsx']
  .map((file) => readFileSync(resolve(root, 'pages', file), 'utf8'));

const requiredTokens = [
  '--color-primary: #0f172a',
  '--color-accent: #22c55e',
  '--color-background: #020617',
  '--color-foreground: #f8fafc',
  '--space-md: 16px',
  '--shadow-md: 0 4px 6px rgb(0 0 0 / 0.1)',
  "--font-heading: 'Fira Code'",
  "--font-body: 'Fira Sans'",
];
for (const token of requiredTokens) {
  if (!css.includes(token)) throw new Error(`missing design token: ${token}`);
}
if (!css.includes('@media (prefers-reduced-motion: reduce)')) {
  throw new Error('missing reduced-motion guard');
}
if ((app + pages.join('\n')).includes('style=')) {
  throw new Error('renderer JSX still contains inline style');
}
if (!app.includes('onSwitchTab') || !app.includes('minimizeWindow') || !app.includes('closeWindow')) {
  throw new Error('App IPC wiring was changed or removed');
}
if (!app.includes('role="tablist"') || !app.includes('role="tab"') || !app.includes('aria-selected') || !app.includes('role="tabpanel"')) {
  throw new Error('App tabs are missing accessible tab semantics');
}
if (!css.includes('.btn-primary') || !css.includes('.btn-success') || !css.includes('.btn-danger')) {
  throw new Error('button variant styles are missing');
}
if (!css.includes('.btn-primary') || !css.includes('.btn-success') || !css.includes('.btn-danger')
  || !css.match(/\.btn-primary\s*\{[^}]*color:\s*var\(--color-primary\)/s)
  || !css.match(/\.btn-success\s*\{[^}]*color:\s*var\(--color-primary\)/s)
  || !css.match(/\.btn-danger\s*\{[^}]*color:\s*var\(--color-primary\)/s)) {
  throw new Error('button foreground does not use the high-contrast dark foreground');
}
if (!css.includes('.toggle:focus-within') || !css.includes('.toggle input:focus-visible')) {
  throw new Error('custom toggle focus styles are missing');
}
if (!css.includes('.app-loading') || !css.includes('min-height: 100%') || !css.includes('#root')) {
  throw new Error('app-loading/root height anchors are missing');
}
const config = pages[1];
const history = pages[2];
const wizard = pages[4];
if (!config.includes('className={`ip-option') || !config.includes('aria-pressed={sel}')) {
  throw new Error('Config IP picker is missing button semantics/state');
}
if (!wizard.includes('className={`ip-option') || !wizard.includes('aria-pressed={sel}')) {
  throw new Error('Wizard IP picker is missing button semantics/state');
}
if (!history.includes('aria-expanded={isOpen}') || !history.includes('aria-controls={`history-runs-${key}`}')) {
  throw new Error('History group control is missing accessible state');
}

// ── 历史页过滤/搜索能力（本轮新增）────────────────────────────────
// 记录本身早已全量可得，但页面只能罗列——任务跑多后无法定位某次失败。
// 守卫保证：搜索框与状态过滤必须在位、必须基于过滤后集合分组、且
// 「过滤后为空」与「完全没有记录」的空态文案必须可区分。
if (!history.includes('history-search-input') || !history.includes('aria-label="搜索执行记录"')) {
  throw new Error('History 搜索框缺失或未标注无障碍名');
}
if (!history.includes("aria-pressed={statusFilter === value}")) {
  throw new Error('History 状态过滤必须用 aria-pressed 暴露选中态');
}
if (!history.includes('for (const rec of filtered)')) {
  throw new Error('History 分组必须基于过滤后的集合（否则过滤不生效）');
}
if (!history.includes('没有符合当前筛选条件的记录。')) {
  throw new Error('History 必须区分"过滤后为空"与"无任何记录"两种空态');
}
if (!css.includes('.history-search-input') || !css.includes('.history-chip')) {
  throw new Error('History 过滤/搜索样式缺失');
}
if (!wizard.includes('has-picker') || !css.includes('margin-top: var(--space-xs)')) {
  throw new Error('Wizard picker spacing anchor changed');
}

// F-21（DEEP_REVIEW 0ef3bbe）：React.lazy 必须只在模块顶层创建一次——写在 render
// 体内会让 Wizard 子树在每次渲染（StrictMode 双渲染 / 未来加 state）反复重挂。
const lazyCalls = app.match(/React\.lazy\(/g) ?? [];
const lazyDeclIndex = app.indexOf('const Wizard = React.lazy(');
const appComponentIndex = app.indexOf('export default function App()');
if (lazyCalls.length !== 1 || lazyDeclIndex === -1 || lazyDeclIndex > appComponentIndex) {
  throw new Error('F-21: React.lazy must be created exactly once at module top level');
}

// F-22（DEEP_REVIEW 0ef3bbe）：启动/停止 IPC 必须 try/catch/finally 复位 disabled
// （否则 reject 后按钮永久禁用），且失败要有页内可见错误条。
const statusWindow = pages[3];
if (!/try\s*\{[\s\S]*?startExecutor\(\)[\s\S]*?\}\s*catch[\s\S]*?\}\s*finally\s*\{/.test(statusWindow)) {
  throw new Error('F-22: startExecutor must be wrapped in try/catch/finally');
}
if (!/try\s*\{[\s\S]*?stopExecutor\(\)[\s\S]*?\}\s*catch[\s\S]*?\}\s*finally\s*\{/.test(statusWindow)) {
  throw new Error('F-22: stopExecutor must be wrapped in try/catch/finally');
}
if (!statusWindow.includes('className="hero-error"') || !statusWindow.includes('role="alert"')) {
  throw new Error('F-22: start/stop failure must render an inline role=alert error');
}
if (!css.includes('.hero-error')) {
  throw new Error('F-22: .hero-error style is missing');
}

// ── D：同类"未包 try 导致按钮永久 disabled"缺陷必须全仓清零 ──────────
// F-22 只覆盖了 StatusWindow 的启动/停止；本轮发现 ConfigPage.save 与
// Wizard.finish 是同一缺陷（reject → saving 永久 true → 只能重启应用）。
// 这里对二者做同等约束，并检查失败时有可见错误条。
if (!/try\s*\{[\s\S]*?saveConfig\([\s\S]*?\}\s*catch[\s\S]*?\}\s*finally\s*\{/.test(config)) {
  throw new Error('D: ConfigPage.save 必须 try/catch/finally（否则失败后按钮永久禁用）');
}
if (!config.includes('cfg-save-error') || !config.includes('role="alert"')) {
  throw new Error('D: ConfigPage 保存失败必须渲染可见错误条');
}
if (!css.includes('.cfg-save-error')) {
  throw new Error('D: .cfg-save-error 样式缺失');
}
if (!/try\s*\{[\s\S]*?saveAndCloseWizard\([\s\S]*?\}\s*catch[\s\S]*?\}\s*finally\s*\{/.test(wizard)) {
  throw new Error('D: Wizard.finish 必须 try/catch/finally（否则卡在"保存中"无提示）');
}
if (!wizard.includes('wizard-error') || !wizard.includes('role="alert"')) {
  throw new Error('D: Wizard 保存失败必须渲染可见错误条');
}
if (!css.includes('.wizard-error')) {
  throw new Error('D: .wizard-error 样式缺失');
}
// 端口必须做区间校验（HTML min/max 不阻止手输/粘贴越界值）
if (!wizard.includes('form.executorPort <= 65535')) {
  throw new Error('D: Wizard 端口必须校验上界（1-65535）');
}
// 地址改写不得用 split(\':\')[0]（IPv6 会被截断成非法值）。
// 先去注释再判——否则本仓库解释该缺陷的中文注释会自我触发。
const wizardNoComments = wizard
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
if (/split\(':'\)\[0\]/.test(wizardNoComments)) {
  throw new Error("D: 地址端口改写不得用 split(':')[0]（IPv6 截断缺陷）");
}

// F-37（DEEP_REVIEW 0ef3bbe）：main 进程 IPC 处理器不得在函数体内 require()
// （模块统一顶层 import；main 进程无打包懒加载收益，属历史噪音）。
const ipcHandlers = readFileSync(resolve(root, '..', 'main', 'ipc-handlers.ts'), 'utf8');
if (/\brequire\(/.test(ipcHandlers)) {
  throw new Error('F-37: ipc-handlers.ts must not call require()');
}
if (!/^import \* as fs from 'fs';$/m.test(ipcHandlers) || !/^import \* as path from 'path';$/m.test(ipcHandlers)) {
  throw new Error('F-37: fs/path must be imported at module top level');
}

// ── DSK-05：自动更新 UI 必须真正接通（本轮修的核心缺陷）──────────────
// 历史问题：updater.ts 与 preload 通道完整实现，但渲染层零订阅，导致
// autoDownload=false 下用户永远收不到更新提示，客户端锁死在当前版本。
// 以下守卫防止该断链回归——任何一条被删都会让更新链路重新失效。
const banner = readFileSync(resolve(root, 'components', 'UpdateBanner.tsx'), 'utf8');
if (!statusWindow.includes("from '../components/UpdateBanner'") || !statusWindow.includes('<UpdateBanner')) {
  throw new Error('DSK-05: StatusWindow 必须渲染 UpdateBanner（否则更新提示无处呈现）');
}
for (const hook of ['onUpdateAvailable', 'onUpdateProgress', 'onUpdateDownloaded', 'onUpdateError']) {
  if (!banner.includes(`a.${hook}`)) {
    throw new Error(`DSK-05: UpdateBanner 未订阅 ${hook}——更新链路会静默失效`);
  }
}
for (const call of ['downloadUpdate', 'installUpdate', 'checkForUpdate']) {
  // 实际调用形态是 api().xxx?.()（运行期桥可能缺失，走可选链降级）
  if (!banner.includes(`api().${call}?.()`)) {
    throw new Error(`DSK-05: UpdateBanner 未调用 ${call}——更新流程无法推进`);
  }
}
// 订阅必须可取消（否则窗口重建/HMR 会累积监听器，一次事件多次 setState）
if (!/return \(\) => \{ for \(const off of offs\) off\(\); \}/.test(banner)) {
  throw new Error('DSK-05: UpdateBanner 的订阅必须在 useEffect 清理函数中取消');
}
// 进度/状态类信息用 polite，错误用 alert（无障碍语义）
if (!banner.includes('aria-live="polite"') || !banner.includes('role="alert"')) {
  throw new Error('DSK-05: UpdateBanner 缺少 aria-live/alert 语义');
}
if (!css.includes('.update-banner') || !css.includes('.update-progress')) {
  throw new Error('DSK-05: .update-banner/.update-progress 样式缺失');
}
// 主进程侧：显式下载入口与独立进度通道（原实现两者皆无）
if (!ipcHandlers.includes("ipcMain.handle('updater:download'")) {
  throw new Error('DSK-05: 缺少 updater:download 处理器（autoDownload=false 下无法下载）');
}
const updaterSrc = readFileSync(resolve(root, '..', 'main', 'updater.ts'), 'utf8');
if (!updaterSrc.includes("progress: 'updater:progress'")) {
  throw new Error('DSK-05: 进度事件必须走独立通道（复用 available 会污染版本号）');
}
const preloadSrc = readFileSync(resolve(root, '..', 'preload', 'index.ts'), 'utf8');
for (const ch of ['updater:download', "ipcRenderer.on('updater:progress'"]) {
  if (!preloadSrc.includes(ch)) {
    throw new Error(`DSK-05: preload 未暴露 ${ch}`);
  }
}

// ── PERF-DSK-01：日志读取必须是增量实现 ────────────────────────────
// 原实现在每次轮询时全量 readFileSync+split，渲染层 1.5s/2s 轮询 → 平方级 I/O。
if (!ipcHandlers.includes('function readLogIncremental(')) {
  throw new Error('PERF-DSK-01: 日志增量读取实现缺失');
}
const fullRereadCalls = (ipcHandlers.match(/allLines\.slice\(fromLine\)/g) ?? []).length;
if (fullRereadCalls > 1) {
  throw new Error('PERF-DSK-01: 仍有多处全量重读日志（应统一走 readLogIncremental）');
}

// ── SEC-DSK-01：Electron 窗口硬化 ─────────────────────────────────
const winMgr = readFileSync(resolve(root, '..', 'main', 'window-manager.ts'), 'utf8');
if (!winMgr.includes('function hardenWindow(')) {
  throw new Error('SEC-DSK-01: window-manager 缺少 hardenWindow()');
}
// 用精确的事件注册形态断言，避免"改个名但仍含子串"就能绕过
const eventGuards = [
  "win.webContents.on('will-navigate',",
  'win.webContents.setWindowOpenHandler(',
  "win.webContents.on('will-attach-webview',",
];
for (const guard of eventGuards) {
  if (!winMgr.includes(guard)) {
    throw new Error(`SEC-DSK-01: window-manager 缺少导航/弹窗守卫注册: ${guard}`);
  }
}
// 守卫必须真的阻止导航（preventDefault）与拒绝弹窗（action: 'deny'）
if (!/will-navigate[\s\S]{0,400}?event\.preventDefault\(\)/.test(winMgr)) {
  throw new Error('SEC-DSK-01: will-navigate 守卫必须调用 event.preventDefault()');
}
if (!/setWindowOpenHandler[\s\S]{0,400}?action:\s*'deny'/.test(winMgr)) {
  throw new Error("SEC-DSK-01: setWindowOpenHandler 必须返回 { action: 'deny' }");
}
// hardenWindow 必须在每个窗口创建处调用（status + wizard）
const hardenCalls = (winMgr.match(/hardenWindow\(this\./g) ?? []).length;
if (hardenCalls < 2) {
  throw new Error(`SEC-DSK-01: hardenWindow 应挂在每个窗口上（当前 ${hardenCalls} 处）`);
}
if (!winMgr.includes('sandbox: true')) {
  throw new Error('SEC-DSK-01: webPreferences 必须显式开启 sandbox');
}
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
if (!indexHtml.includes('Content-Security-Policy')) {
  throw new Error('SEC-DSK-01: renderer index.html 缺少 CSP');
}
// 精确取出 content="..." 里的策略串，再逐指令检查——不能在整份 HTML 上
// 用宽松正则（style-src 的 'unsafe-inline' 会被误判成 script-src 的）。
const cspMatch = indexHtml.match(/content="(default-src[^"]*)"/);
if (!cspMatch) {
  throw new Error('SEC-DSK-01: 未能解析出 CSP 策略串');
}
const csp = cspMatch[1];
const scriptSrc = (csp.match(/script-src[^;]*/) ?? [''])[0];
if (!/script-src\s+'self'/.test(scriptSrc)) {
  throw new Error("SEC-DSK-01: CSP script-src 必须为 'self'");
}
if (scriptSrc.includes('unsafe-inline') || scriptSrc.includes('unsafe-eval')) {
  throw new Error('SEC-DSK-01: CSP script-src 不得含 unsafe-inline/unsafe-eval');
}
// object-src / base-uri 必须显式收紧
for (const directive of ["object-src 'none'", "base-uri 'none'"]) {
  if (!csp.includes(directive)) {
    throw new Error(`SEC-DSK-01: CSP 缺少 ${directive}`);
  }
}

console.log('renderer selftest: design tokens, accessibility, contrast, focus, layout, spacing, IPC anchors, F-21/F-22/F-37, DSK-05, PERF-DSK-01, SEC-DSK-01 guards passed');
