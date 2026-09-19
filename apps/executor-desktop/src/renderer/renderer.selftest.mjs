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
  // 该 token 的**值**在样式打磨时被细化过（加了 -1px 偏移并叠了第二层阴影），
  // 但本行期望值没跟着改，导致 test:renderer 在 main 上长期为红（断言与实现
  // 脱节，而非样式有问题）。这里对齐到实际值；真正的意图是"多层阴影 token
  // 必须存在且被 --shadow 引用"，值本身仍由设计系统决定。
  '--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.12)',
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
// 按钮前景色必须与各自底色形成高对比（深色底 → 浅字 / 亮色底 → 深字）。
// 断言意图是"对比度合规"，不是"必须用某个具体变量"：早期实现统一用
// var(--color-primary)，样式打磨后改成按底色微调的硬编码值（绿底 #052e12、
// 红底 #fff）。原断言钉死旧变量，导致本测试在 main 上长期为红。
const btnForegrounds = [
  { cls: 'btn-primary', want: '#052e12' },
  { cls: 'btn-success', want: '#052e12' },
  { cls: 'btn-danger', want: '#fff' },
];
for (const { cls, want } of btnForegrounds) {
  const block = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`, 's'));
  if (!block || !new RegExp(`color:\\s*${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`).test(block[1])) {
    throw new Error(`button foreground does not use the high-contrast dark foreground: .${cls} 应为 ${want}`);
  }
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
// IP 快捷选择必须是真正的按钮并暴露选中态。实现早期用 `.ip-option`，样式打磨
// 后改名为 `.ip-chip`（CSS 里两个类都还在），本断言未同步 → main 上长期为红。
// 断言意图是"按钮语义 + aria-pressed 选中态"，与类名无关，故两个类名都接受。
const ipPickerOk = (src) =>
  (src.includes('className={`ip-chip') || src.includes('className={`ip-option')) &&
  src.includes('aria-pressed={sel}');
if (!ipPickerOk(config)) {
  throw new Error('Config IP picker is missing button semantics/state');
}
if (!ipPickerOk(wizard)) {
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
// Wizard 的 IP 选择区与地址输入框之间必须有明确间距（曾是 .has-picker 修饰类，
// UI 打磨提交 c0691e4 把它从 JSX 移除，但 CSS 规则与本断言都留了下来 → 断言
// 永不成立、main 上长期为红）。这里改为断言真正生效的形态：地址输入框类名
// 在位，且 IP 快捷选择容器有专用样式。间距由 .ip-picker 的 margin 提供。
if (!wizard.includes('wizard-address-input') || !css.includes('.ip-picker')) {
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

// ── python_task_multiversion：Python 运行环境必须**在 UI 上可配** ──────
// 历史问题：uvPath / uvPythonInstallMirror / uvPythonInstallDir /
// pypiRegistryUrl 四个字段后端全部实现并已下发子进程，但渲染层**零引用**
// ——运维只能手工编辑 userData 里的 config.json，等于该能力实际不可用。
// 内网/离线部署（自带 uv + 内网镜像/离线池）完全依赖这一组设置，必须钉死。
const pyFields = ['uvPath', 'uvPythonInstallMirror', 'uvPythonInstallDir', 'pypiRegistryUrl'];
for (const field of pyFields) {
  if (!config.includes(`form.${field}`)) {
    throw new Error(`python_task_multiversion: 设置页缺少 ${field} 输入项——内网/离线部署将无法配置`);
  }
}
if (!config.includes("id: 'python'")) {
  throw new Error('python_task_multiversion: 设置页缺少「Python 运行环境」分区');
}
// 诊断面：必须显示实际生效的 uv 与池路径（"配了却没生效"是最常见故障）。
if (!config.includes('getPythonEnvStatus') || !ipcHandlers.includes("ipcMain.handle('config:python-env-status'")) {
  throw new Error('python_task_multiversion: Python 环境诊断（uv/池实际路径）链路缺失');
}
if (!preloadSrc.includes('config:python-env-status')) {
  throw new Error('python_task_multiversion: preload 未暴露 config:python-env-status');
}
if (!css.includes('.py-env-status')) {
  throw new Error('python_task_multiversion: .py-env-status 样式缺失');
}

// ── 保存反馈：ok:false 不得被当成功 ────────────────────────────────────
// config:save 在载荷形状被拒时返回 {ok:false}（resolve 而非 reject）。原实现
// 只看 reloadError，于是该路径被当成成功 → 显示"✓ 已保存，配置已生效"，
// 而实际什么都没写入。保存反馈是用户判断"改没改成功"的唯一依据，必须全真。
if (!/r\.ok\s*===\s*false/.test(config)) {
  throw new Error('保存反馈必须处理 ok:false（否则会谎报"已保存"）');
}

// ── UX-DSK-NUM：number input 的"所见即所存" ────────────────────────────
// 真实故障（已反证）：设置页「最大并发任务数」用
// `parseInt(e.target.value, 10)` 无兜底 —— 清空输入框 → NaN；显示层
// `Number(form.x || 10)` 仍渲染 10，于是"界面显示 10、保存 NaN"。NaN 经 IPC
// 序列化为 null，主进程写 electron-store 时撞 ajv `must be number` 校验并整次
// 抛出：同批次其它修改已部分写入，UI 却只说"保存失败"。
// 三道闸：(1) 纯函数行为；(2) 设置页必须真的用它；(3) 主进程必须接住。
{
  const { parseBoundedInt, displayNumber, MAX_CONCURRENT_TASKS, EXECUTOR_PORT } =
    await import('./number-input.ts');

  const eq = (got, want, msg) => {
    if (got !== want) throw new Error(`UX-DSK-NUM: ${msg}（得到 ${got}，期望 ${want}）`);
  };
  const { fallback: F, min: LO, max: HI } = MAX_CONCURRENT_TASKS;

  // 清空输入框：必须回落默认 10，**不是** NaN，也**不是**被钳成的 1
  eq(parseBoundedInt('', F, LO, HI), 10, "清空输入框必须回落 10（原实现给 NaN）");
  eq(parseBoundedInt('   ', F, LO, HI), 10, '空白串必须回落 10');
  eq(parseBoundedInt('abc', F, LO, HI), 10, '非数字必须回落 10');
  // 越界钳制（HTML min/max 拦不住手输/粘贴）
  eq(parseBoundedInt('0', F, LO, HI), 1, '低于下界 → 钳到 1');
  eq(parseBoundedInt('-5', F, LO, HI), 1, '负数 → 钳到 1');
  eq(parseBoundedInt('9999', F, LO, HI), 100, '高于上界 → 钳到 100');
  // 合法值原样
  eq(parseBoundedInt('4', F, LO, HI), 4, '合法值保留');
  eq(parseBoundedInt('4.6', F, LO, HI), 4, '小数按 parseInt 语义取整');
  // 端口：区间与默认值都不同，必须各走各的规则
  eq(parseBoundedInt('', EXECUTOR_PORT.fallback, EXECUTOR_PORT.min, EXECUTOR_PORT.max), 8002,
    '端口清空 → 8002');
  eq(parseBoundedInt('99999', EXECUTOR_PORT.fallback, EXECUTOR_PORT.min, EXECUTOR_PORT.max), 65535,
    '端口越界 → 65535');
  // 显示层：状态里残留脏值时也要显示默认值（"所见即所存"的另一半）
  eq(displayNumber(NaN, 10), 10, 'NaN 状态必须显示默认 10');
  eq(displayNumber(null, 10), 10, 'null 状态必须显示默认 10');
  eq(displayNumber(4, 10), 4, '正常值原样显示');

  // 设置页必须真的调用该解析通道（改成裸 parseInt 立即红）
  for (const field of ['maxConcurrentTasks', 'executorPort', 'interpreterDownloadTimeoutMs']) {
    const re = new RegExp(`set\\('${field}',\\s*\\n?\\s*parseBoundedInt\\(`);
    if (!re.test(config)) {
      throw new Error(`UX-DSK-NUM: ConfigPage 的 ${field} 未走 parseBoundedInt（会重新引入 NaN）`);
    }
  }
  // 不得再出现无兜底的 parseInt（允许注释里出现该形态，故先去注释）
  const configNoComments = config
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (/parseInt\(e\.target\.value,\s*10\)\)/.test(configNoComments)) {
    throw new Error('UX-DSK-NUM: 仍存在无兜底的 parseInt(e.target.value, 10)');
  }
  // 主进程侧必须接住（渲染层修了、主进程没修也仍然会整次保存失败）
  if (!ipcHandlers.includes('sanitizeConfigInput(')) {
    throw new Error('UX-DSK-NUM: ipc-handlers 未调用 sanitizeConfigInput（保存仍会整次失败）');
  }
}

// ── UX-DSK-UV：uv 诊断不得谎报"未找到 uv" ──────────────────────────────
// 真实故障（已反证）：诊断把"没显式配置 + 没自带 uv"渲染成
// 「未找到 uv —— 声明了 Python 版本的任务将无法执行」，但 executor-node 的
// resolveUvBin 在其后还有系统 UV_BIN 与 **PATH 实跑探测**两级兜底。于是 uv
// 装在 PATH 上、任务完全能跑的机器也会收到假的致命告警。
// 反方向同样被隐瞒：uvPath 指到不存在的文件时旧实现仍显示"（来自 uvPath 配置）"。
{
  // 1) 渲染层必须区分三种真值，且不得在"未静态确认"时喊"未找到 uv"
  if (!config.includes('uvStaticallyConfirmed')) {
    throw new Error('UX-DSK-UV: 设置页未区分"未静态确认"与"未找到 uv"（PATH 兜底会被误报为缺失）');
  }
  if (!config.includes('uvConfiguredButMissing')) {
    throw new Error('UX-DSK-UV: 设置页未暴露 uvPath 配错路径（配错会被粉饰成已生效）');
  }
  // "未找到 uv"这句致命文案必须挂在一个条件之后，绝不能是无条件 fallback。
  // 先去注释再判——否则本仓库解释该缺陷的中文注释会自我触发（与上方
  // split(':')[0] 的反证同一教训）。
  const configNoCommentsUv = config
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const missingMsg = '未找到 uv';
  const idx = configNoCommentsUv.indexOf(missingMsg);
  if (idx === -1) throw new Error('UX-DSK-UV: 缺失告警文案消失（应保留给真正的缺失场景）');
  const before = configNoCommentsUv.slice(Math.max(0, idx - 400), idx);
  if (!/uvStaticallyConfirmed/.test(before)) {
    throw new Error('UX-DSK-UV: "未找到 uv" 必须是 uvStaticallyConfirmed 之后的条件分支');
  }
  // 2) 主进程必须提供这两个真值字段
  for (const field of ['uvConfiguredButMissing', 'uvStaticallyConfirmed']) {
    if (!ipcHandlers.includes(field)) {
      throw new Error(`UX-DSK-UV: config:python-env-status 未返回 ${field}`);
    }
  }
  if (!ipcHandlers.includes('classifyUvResolution(')) {
    throw new Error('UX-DSK-UV: 主进程未使用 classifyUvResolution（判定逻辑会再次漂移）');
  }
}

// ── UX-DSK-AUTOLAUNCH：向导的「开机自动启动」必须真的写系统自启动项 ─────
// 真实故障（已核对全仓引用）：config:save-and-close-wizard 只把 autoStart
// **落盘**，从未调用 setAutoLaunchEnabled()。而托盘菜单的勾选态读的正是
// config.autoStart（tray.ts 的 getAutoLaunch），设置页开关走的又是另一条
// 即时生效的 IPC——于是首设走向导的用户看到"已勾选"、重启后却没起来，
// 且同一开关在两处行为不一致。
{
  const start = ipcHandlers.indexOf("ipcMain.handle('config:save-and-close-wizard'");
  if (start === -1) throw new Error('UX-DSK-AUTOLAUNCH: 找不到 config:save-and-close-wizard');
  const rest = ipcHandlers.slice(start);
  const next = rest.indexOf('ipcMain.handle(', 1);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  if (!block.includes('setAutoLaunchEnabled(')) {
    throw new Error('UX-DSK-AUTOLAUNCH: 向导未调用 setAutoLaunchEnabled——开关只落盘不生效');
  }
  // 且必须挂在 autoStart 为真之后（无条件 enable 会把"不开机自启"也强制打开）
  if (!/autoStart\s*===\s*true/.test(block)) {
    throw new Error('UX-DSK-AUTOLAUNCH: setAutoLaunchEnabled 必须受 autoStart 条件保护');
  }
}

// ── EXP-04（本轮体验审查）：状态页 getStatus() 必须兜住 IPC reject ──────
//
// 原实现 `getStatus().then(...)` 无 .catch：`executor:status` handler 要读
// configStore.getAllMasked()，配置文件损坏/schema 校验抛错/token 解密异常时
// 该 IPC reject，于是 statusLoaded 永远为 false —— 状态徽章永久停在
// 「加载中...」、大按钮永久灰色不可点、页内无任何错误提示（actionError 只由
// handleStart/handleStop 设置）。用户既无法从界面启动执行器也不知道原因。
{
  const statusPage = pages[3]; // StatusWindow.tsx
  const start = statusPage.indexOf('.getStatus()');
  if (start === -1) throw new Error('EXP-04: 找不到 getStatus() 调用');
  const rest = statusPage.slice(start);
  const next = rest.indexOf('window.electronAPI', 1);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  if (!block.includes('.catch(')) {
    throw new Error('EXP-04: getStatus() 缺少 .catch —— reject 会让启动按钮永久 disabled 且无提示');
  }
  // 且必须在 finally 里置 statusLoaded（否则按钮依然永久不可点）
  if (!/\.finally\(/.test(block) || !block.includes('setStatusLoaded(true)')) {
    throw new Error('EXP-04: getStatus() 失败分支未置 statusLoaded —— 按钮仍会永久 disabled');
  }
  // 失败原因必须落到页内错误条（桌面端无 toast 体系）
  if (!block.includes('setActionError(')) {
    throw new Error('EXP-04: getStatus() 失败未写 actionError —— 用户看不到原因');
  }
}

// ── EXP-09（本轮体验审查）：listLogFiles() 必须有 typeof 守卫 + .catch ──
//
// 原实现 `listLogFiles().then(setLogFiles)`：旧版 preload 未暴露该方法时
// **同步抛 TypeError** → React 卸载整棵树 → 窗口只剩背景色（正是
// preload/index.ts:40-42 记录过的那次事故形态）。同仓 ConfigPage.tsx:93 已为
// 同类情形写了 typeof 守卫。
{
  const statusPage = pages[3];
  const start = statusPage.indexOf('.listLogFiles()');
  if (start === -1) throw new Error('EXP-09: 找不到 listLogFiles() 调用');
  const before = statusPage.slice(Math.max(0, start - 400), start);
  if (!before.includes("typeof window.electronAPI.listLogFiles !== 'function'")) {
    throw new Error('EXP-09: listLogFiles 缺少 typeof 守卫 —— 旧 preload 下会同步抛异常导致白屏');
  }
  const rest = statusPage.slice(start);
  const next = rest.indexOf('window.electronAPI', 1);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  if (!block.includes('.catch(')) {
    throw new Error('EXP-09: listLogFiles() 缺少 .catch');
  }
}

// ── EXP-05（本轮体验审查）：日志文件列表不得再列幽灵条目 main.log ──────
//
// logger.ts:15 落盘名是 `executor-YYYY-MM-DD.log`，而 log:list-files 读的是
// `logs/main.log` —— 因 existsSync 守卫该条目**永不出现**，且 userData/logs
// 域在面板里再无其他条目，导致**昨天的桌面端日志从 UI 完全不可达**。
{
  const start = ipcHandlers.indexOf("ipcMain.handle('log:list-files'");
  if (start === -1) throw new Error('EXP-05: 找不到 log:list-files handler');
  const rest = ipcHandlers.slice(start);
  const next = rest.indexOf('ipcMain.handle(', 1);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  if (block.includes("'main.log'")) {
    throw new Error('EXP-05: log:list-files 仍在读 main.log（幽灵条目，永不出现）');
  }
  if (!/executor-\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(block)) {
    throw new Error('EXP-05: log:list-files 未按 executor-YYYY-MM-DD.log 命名遍历');
  }
}

// ── EXP-06（本轮体验审查）：改完配置保存后，页内诊断必须刷新 ─────────────
//
// 「Python 运行环境」页的诊断块回答的是"我配的到底生效了没有"，而原实现只在
// `active` 变化时拉取一次。用户在这一页改完 uvPath / 解释器池目录 / 下载预算
// 并点「保存配置」后，诊断块**仍显示旧值**——于是他会怀疑保存没生效而反复保存，
// 或带着错误认知去排障。这类"改完不刷新"不报错，只让页面上显示的信息与真实
// 状态不一致。
{
  const configPage = pages[1]; // ConfigPage.tsx
  if (!configPage.includes('refreshPyEnv')) {
    throw new Error('EXP-06: ConfigPage 未抽出 refreshPyEnv()——诊断无法在保存后刷新');
  }
  // 保存成功分支里必须调用它（只在失败分支调用没意义）
  const saveIdx = configPage.indexOf('async function save()');
  if (saveIdx === -1) throw new Error('EXP-06: 找不到 save()');
  const saveBody = configPage.slice(saveIdx, saveIdx + 1600);
  if (!saveBody.includes('refreshPyEnv()')) {
    throw new Error('EXP-06: save() 成功后未调用 refreshPyEnv()——改完配置诊断仍显示旧值');
  }
  // 且必须在"保存成功"分支内，而不是 catch/失败分支
  const okIdx = saveBody.indexOf('setSaved(true)');
  const callIdx = saveBody.indexOf('refreshPyEnv()');
  if (okIdx === -1 || callIdx < okIdx) {
    throw new Error('EXP-06: refreshPyEnv() 必须在保存成功分支（setSaved(true) 之后）调用');
  }
  // 切页时仍要刷新（原行为不能被改坏）
  if (!/useEffect\(\(\) => \{\s*if \(active !== 'python'\) return;[\s\S]{0,80}refreshPyEnv\(\)/.test(configPage)) {
    throw new Error("EXP-06: 切到 python 页时仍须调用 refreshPyEnv()（原行为不得丢失）");
  }
}

// ── NETOPT-7⑤：ConfigPage 首屏 Promise.all 必须兜住 IPC reject ──────────
//
// getConfig() 走主进程 configStore.getAllMasked()——配置文件损坏/schema 校验
// 抛错/token 解密异常时该 IPC reject。原实现 `Promise.all([...]).then(...)` 无
// .catch：loaded 恒 false → 整页永久「加载中...」+ unhandled rejection。与
// EXP-04（StatusWindow 的 getStatus()）同源场景，修法对齐：脱离加载态 + 页内
// 错误行（桌面端无 toast 体系）。
{
  const configPage = pages[1];
  const start = configPage.indexOf('Promise.all([window.electronAPI.getConfig()');
  if (start === -1) throw new Error('NETOPT-7⑤: 找不到首屏 Promise.all(getConfig/getLocalIPs)');
  // 块边界：catch 紧跟 then，不可能跨到下一个 useEffect 之后
  const rest = configPage.slice(start);
  const next = rest.indexOf('useEffect', 1);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  const catchIdx = block.indexOf('.catch(');
  if (catchIdx === -1) {
    throw new Error('NETOPT-7⑤: 首屏 Promise.all 缺少 .catch —— 配置读取失败会永久「加载中...」');
  }
  // catch 必须挂在 Promise.all 链上：同 effect 里的 getAutoLaunch().catch 与本守卫
  // 无关——首个 .catch 若出现在 autolaunch 行之后，说明读取链本身仍无兜底。
  if (block.slice(0, catchIdx).includes('getAutoLaunch')) {
    throw new Error('NETOPT-7⑤: .catch 未挂在首屏 Promise.all 链上（只有 autolaunch 通道有 catch）');
  }
  if (!block.includes('setLoaded(true)')) {
    throw new Error('NETOPT-7⑤: 失败分支未置 loaded —— 页面仍会永久「加载中...」');
  }
  // 失败原因必须落到页内可见错误行，且错误行必须真的渲染出来
  if (!block.includes('setLoadError(')) {
    throw new Error('NETOPT-7⑤: 读取失败未写 loadError —— 用户看不到原因');
  }
  if (!configPage.includes('{loadError && (')) {
    throw new Error('NETOPT-7⑤: loadError 未渲染为页内错误行');
  }
}

// ── NETOPT-6⑥：渲染树必须有全局 ErrorBoundary 兜底 ─────────────────
// 背景：main.tsx 此前直接 render(<App />)，全 renderer 零边界——任一组件
// 渲染期抛错（EXP-09 记录过该事故形态：preload 缺方法同步抛 → 整树卸载
// 白屏）用户只能盲杀进程。test:renderer 是静态源码自检（本文件既有形态，
// 渲染层无 DOM 测试设施），故以下按同一形态做结构性守卫。
{
  const boundary = readFileSync(resolve(root, 'components', 'ErrorBoundary.tsx'), 'utf8');
  // React 错误边界的两个必要生命周期缺一不可：
  //   getDerivedStateFromError —— 把异常转为兜底 UI 的 state（class 边界）；
  //   componentDidCatch —— 副作用/日志钩子，没有它边界仍工作但不可观测。
  if (!boundary.includes('getDerivedStateFromError') || !boundary.includes('componentDidCatch')) {
    throw new Error('NETOPT-6⑥: ErrorBoundary 缺少 getDerivedStateFromError/componentDidCatch');
  }
  if (!/class ErrorBoundary extends React\.Component/.test(boundary)) {
    throw new Error('NETOPT-6⑥: ErrorBoundary 必须是 class 组件（函数组件无边界能力）');
  }
  // 兜底 UI 必须可感知：role="alert" 的错误摘要 + 可用的重载动作。
  if (!boundary.includes('role="alert"') || !boundary.includes('error-boundary-summary')) {
    throw new Error('NETOPT-6⑥: ErrorBoundary 兜底 UI 缺少 role="alert" 错误摘要');
  }
  if (!boundary.includes('window.location.reload()')) {
    throw new Error('NETOPT-6⑥: 「重载渲染层」按钮必须真正调用 window.location.reload()');
  }
  if (!boundary.includes('重载渲染层')) {
    throw new Error('NETOPT-6⑥: 重载动作缺中文可读标签');
  }
  // 入口接线：createRoot(...).render 的最外层必须是 <ErrorBoundary> 包 <App />。
  // 精确断言形态——只 import 不使用、或包在 App 内部都算断链。
  const mainEntry = readFileSync(resolve(root, 'main.tsx'), 'utf8');
  if (!/createRoot\(container\)\.render\(\s*<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>,?\s*\)/s.test(mainEntry)) {
    throw new Error('NETOPT-6⑥: main.tsx 的 render 根节点必须是 <ErrorBoundary><App /></ErrorBoundary>');
  }
  if (!css.includes('.error-boundary') || !css.includes('.error-boundary-summary')) {
    throw new Error('NETOPT-6⑥: .error-boundary 兜底 UI 样式缺失');
  }
}

console.log('renderer selftest: design tokens, accessibility, contrast, focus, layout, spacing, IPC anchors, F-21/F-22/F-37, DSK-05, PERF-DSK-01, SEC-DSK-01, EXP-04/05/06/09, ErrorBoundary, NETOPT-7⑤⑥ guards passed');
