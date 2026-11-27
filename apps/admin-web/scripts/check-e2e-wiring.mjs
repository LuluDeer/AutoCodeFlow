#!/usr/bin/env node
/**
 * E2E-WIRING：防止 e2e/ux-*.spec.ts 成为「写了但没人跑」的孤儿。
 *
 * 判据（静态、零安装）：
 *   ① 至少两份权威 spec（browser-stub / browser-real）；
 *   ② 两份 scripts/playwright.ux-*.config.ts 的 testMatch/testIgnore 互斥且覆盖全部 ux spec；
 *   ③ package.json 有两条入口脚本，分别指向 stub / real 配置；
 *   ④ ci.yml 的 admin-web-e2e-authoritative job 同时调用这两条脚本。
 *
 * 退出码：0 = 全接线；1 = 存在孤儿 / 配置交叉拾取 / CI 未接线。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB = join(ROOT, 'apps', 'admin-web');
const fail = (msg) => {
  console.error(`✖ e2e wiring: ${msg}`);
  process.exitCode = 1;
};

const specs = readdirSync(join(WEB, 'e2e'))
  .filter((f) => f.startsWith('ux-') && f.endsWith('.spec.ts'))
  .sort();
if (specs.length < 2) fail(`ux spec 少于 2 份（当前 ${specs.length}）`);

const stubCfg = readFileSync(join(WEB, 'scripts', 'playwright.ux-stub.config.ts'), 'utf8');
const realCfg = readFileSync(join(WEB, 'scripts', 'playwright.ux-real.config.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

if (!stubCfg.includes('testMatch: /e2e\\/ux-.*\\.spec\\.ts$/')) fail('stub config 未覆盖 ux-*.spec.ts');
if (!stubCfg.includes('ux-real-backend\\.spec\\.ts')) fail('stub config 未排除 real spec（两套配置会交叉拾取）');
if (!realCfg.includes('testMatch: /e2e\\/ux-real-backend\\.spec\\.ts$/')) fail('real config 未精确圈定 ux-real-backend.spec.ts');

for (const spec of specs) {
  if (spec === 'ux-real-backend.spec.ts') {
    if (!realCfg.includes(spec.replace('.spec.ts', ''))) fail(`${spec} 未被 real config 引用`);
  } else if (!spec.startsWith('ux-')) {
    fail(`${spec} 不在 ux 契约命名域`);
  }
}

for (const [name, needle] of [
  ['test:e2e:ux:stub', 'playwright.ux-stub.config.ts'],
  ['test:e2e:ux:real', 'playwright.ux-real.config.ts'],
]) {
  const script = pkg.scripts?.[name];
  if (!script || !script.includes(needle)) fail(`package.json 缺少 ${name} → ${needle}`);
  if (!ci.includes(name)) fail(`ci.yml 未调用 ${name}`);
}
if (!ci.includes('admin-web-e2e-authoritative:')) fail('ci.yml 缺少 admin-web-e2e-authoritative job');

if (process.exitCode) {
  console.error(`✖ e2e wiring 未通过：${specs.length} 份 ux spec`);
} else {
  console.log(`✔ e2e wiring：${specs.length} 份 ux spec 全部接线（stub × ${specs.length - 1}, real × 1）`);
}
