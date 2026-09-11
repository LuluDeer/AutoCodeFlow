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
console.log('renderer selftest: design tokens, accessibility, contrast, focus, layout, spacing, and IPC anchors passed');
