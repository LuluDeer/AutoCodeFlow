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

// F-37（DEEP_REVIEW 0ef3bbe）：main 进程 IPC 处理器不得在函数体内 require()
// （模块统一顶层 import；main 进程无打包懒加载收益，属历史噪音）。
const ipcHandlers = readFileSync(resolve(root, '..', 'main', 'ipc-handlers.ts'), 'utf8');
if (/\brequire\(/.test(ipcHandlers)) {
  throw new Error('F-37: ipc-handlers.ts must not call require()');
}
if (!/^import \* as fs from 'fs';$/m.test(ipcHandlers) || !/^import \* as path from 'path';$/m.test(ipcHandlers)) {
  throw new Error('F-37: fs/path must be imported at module top level');
}

console.log('renderer selftest: design tokens, accessibility, contrast, focus, layout, spacing, IPC anchors, F-21/F-22/F-37 guards passed');
