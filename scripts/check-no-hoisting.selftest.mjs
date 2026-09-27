#!/usr/bin/env node
// scripts/check-no-hoisting.mjs 自检：临时目录构造结构矩阵，逐条断言判据有齿。
// 每个负例都对应一个**实测过**的真实故障形态（见 docs/ARCH-28b-turbo-adoption.md）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, NPM_SUBPROJECTS } from './check-no-hoisting.mjs';

let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

/** 造一个「干净」仓库骨架：8 子项目各持 lockfile，根 lock 仅含自身。 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'acf-nohoist-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.1', private: true }, null, 2));
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'r', version: '1.0.1', lockfileVersion: 3, packages: { '': { name: 'r' } } }, null, 2),
  );
  for (const p of NPM_SUBPROJECTS) {
    mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, p, 'package.json'), JSON.stringify({ name: p, version: '0.0.1', private: true }));
    writeFileSync(join(root, p, 'package-lock.json'), JSON.stringify({ name: p, lockfileVersion: 3, packages: {} }));
  }
  return root;
}
function patch(root, rel, obj) {
  writeFileSync(join(root, rel), JSON.stringify(obj, null, 2));
}

// ── 正例：干净骨架必须全绿（否则守卫是「永远红」，等于没有） ──────────
{
  const root = makeRepo();
  const { failures: f } = check(root);
  assert('干净骨架无违规', f.length === 0);
  rmSync(root, { recursive: true, force: true });
}

// ── ①②：根 workspaces 非空 = npm prefix 上移（实测：子项目 npm ci ERESOLVE） ──
{
  const root = makeRepo();
  patch(root, 'package.json', {
    name: 'r',
    version: '1.0.1',
    private: true,
    workspaces: NPM_SUBPROJECTS,
  });
  const { failures: f } = check(root);
  assert('根 workspaces 非空必须被检出', f.some((x) => x.includes('workspaces')));
  rmSync(root, { recursive: true, force: true });
}
// 对象形态 workspaces.packages 同样要检出（pnpm/npm 两种写法）
{
  const root = makeRepo();
  patch(root, 'package.json', {
    name: 'r',
    version: '1.0.1',
    private: true,
    workspaces: { packages: ['apps/*'] },
  });
  const { failures: f } = check(root);
  assert('workspaces.packages 对象形态必须被检出', f.some((x) => x.includes('workspaces')));
  rmSync(root, { recursive: true, force: true });
}
// 空数组是**合法**的（实测不触发 hoist）——不得误报
{
  const root = makeRepo();
  patch(root, 'package.json', { name: 'r', version: '1.0.1', private: true, workspaces: [] });
  const { failures: f } = check(root);
  assert('空 workspaces 数组不误报（实测不 hoist）', f.length === 0);
  rmSync(root, { recursive: true, force: true });
}

// ── ②：workspace 发现清单 ────────────────────────────────────────
for (const name of ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'rush.json']) {
  const root = makeRepo();
  writeFileSync(join(root, name), name.endsWith('.yaml') || name.endsWith('.yml') ? 'packages:\n  - "apps/*"\n' : '{}');
  const { failures: f } = check(root);
  assert(`${name} 存在必须被检出`, f.some((x) => x.includes(name)));
  rmSync(root, { recursive: true, force: true });
}

// ── ③：packageManager 诚实性 ─────────────────────────────────────
{
  const root = makeRepo();
  patch(root, 'package.json', { name: 'r', version: '1.0.1', private: true, packageManager: 'pnpm@10.0.0' });
  const { failures: f } = check(root);
  assert('packageManager=pnpm 必须被检出（与 npm 安装面相反）', f.some((x) => x.includes('packageManager')));
  rmSync(root, { recursive: true, force: true });
}
{
  const root = makeRepo();
  patch(root, 'package.json', { name: 'r', version: '1.0.1', private: true, packageManager: 'npm@11.19.0' });
  const { failures: f } = check(root);
  assert('packageManager=npm 不误报（诚实声明）', f.length === 0);
  rmSync(root, { recursive: true, force: true });
}

// ── ④：根 lockfile 承载依赖图 = hoist 已发生 ─────────────────────
{
  const root = makeRepo();
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'r',
        lockfileVersion: 3,
        packages: { '': { name: 'r' }, 'node_modules/express': { version: '4.22.2' } },
      },
      null,
      2,
    ),
  );
  const { failures: f } = check(root);
  assert('根 lockfile 含非根条目必须被检出', f.some((x) => x.includes('非根条目')));
  rmSync(root, { recursive: true, force: true });
}

// ── ⑤：子项目自持 lockfile ───────────────────────────────────────
{
  const root = makeRepo();
  rmSync(join(root, 'apps/admin-api/package-lock.json'));
  const { failures: f } = check(root);
  assert('子项目缺 lockfile 必须被检出', f.some((x) => x.includes('apps/admin-api')));
  rmSync(root, { recursive: true, force: true });
}

// ── 反证有牙：把真实仓库当前状态喂进去必须绿（守卫不能空转） ──────
{
  const { failures: f } = check(join(dirname(new URL(import.meta.url).pathname), '..'));
  assert('真实仓库当前状态全绿（守卫真的在跑）', f.length === 0);
}

console.log(failures === 0 ? '\ncheck-no-hoisting selftest: all passed' : `\ncheck-no-hoisting selftest: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
