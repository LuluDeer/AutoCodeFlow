#!/usr/bin/env node
/**
 * ARCH-28b 守卫：no-hoisting 安装模型不得回退（2026-09-27，N-01 实测产物）。
 *
 * 为什么需要这道守卫 —— 它是本次 turbo 接入实测（docs/ARCH-28b-turbo-adoption.md）
 * 最有价值的发现，而不是一次「顺手加的检查」：
 *
 * turbo 的多包模式**要求**根 manifest 提供 workspace 发现面（`workspaces` 字段，
 * 或 `pnpm-workspace.yaml`）。本仓根 package.json 一旦把 8 个子项目列进
 * `workspaces`，npm 的 prefix 就从子项目上移到仓库根——**任何一个**子项目里跑
 * `npm ci`，npm 改去解析**整个 workspace 图**并按根 hoist，直接撞上 ARCH-28
 * §1.5 实测的 161 处版本分裂（express 4/5、eslint 8/9、vitest 3/4 跨大版本共存）。
 *
 * 实测（2026-09-27，本机 Node 24.21 / npm 11.19，见
 * docs/ARCH-28b-turbo-adoption.md §3）：8 个子项目 `npm ci` **全部 exit 1**。
 * 两个后果让这个回退极难归因：
 *   ① **报错文本与被跑的项目无关**。在 `apps/executor-node` 里跑 `npm ci`，报的
 *      是 `While resolving: admin-api@0.0.1 / Found: ioredis@6.0.0 / peerOptional
 *      ioredis@"^5.0.4" from typeorm@1.1.1`——完全不提 executor-node。按报错去
 *      查 executor-node 的依赖会一无所获。
 *   ② **部分列出更隐蔽**：只把部分子项目写进 `workspaces` 时，被列进去的那些
 *      红、没列进去的照常绿（实测 `workspaces:['packages/docs-site']` →
 *      docs-site exit 1，admin-api/executor-node/acf-cli 全 exit 0）。
 *      即"CI 一半红一半绿"，最容易被当成 flake。
 * 既有 lockfile-integrity 守卫能覆盖到 7 个列名项目（docs-site 不在它的矩阵里），
 * 但它的报错是「package.json 与 package-lock.json 漂移——运行 npm install 同步后
 * 提交两文件」，**指向的是错误的修法**（真去跑 npm install 会进一步把 hoist 写进
 * 根 lockfile，坐实破坏）。故本守卫直接盯**结构**，不依赖任何命令的退出码，
 * 且覆盖全部 8 个子项目。
 *
 * 判据（任一违反即红）：
 *   ① 根 package.json 不得声明非空 `workspaces`（npm prefix 上移的触发条件）；
 *   ② 根目录不得出现 workspace 发现清单（pnpm-workspace.yaml / lerna.json /
 *      rush.json）——它们同时是「实际用 pnpm/lerna 安装」的错误信号；
 *   ③ 根 package.json 的 `packageManager`（若声明）必须是 npm；
 *   ④ 根 package-lock.json 的 packages 映射除自身（""）外不得有其它条目
 *      ——有其它条目即说明根已承载依赖图（hoist 已发生）；
 *   ⑤ 8 个 npm 子项目各自必须有 package-lock.json（no-hoisting 的前提：
 *      每个子项目自持 lockfile，CI 才能逐项目 `npm ci`）。
 *
 * 纯静态读取，不需要 npm ci / 网络 / PG，秒级。
 *
 * 用法：
 *   node scripts/check-no-hoisting.mjs             # 正式检查
 *   node scripts/check-no-hoisting.mjs --selftest  # 有齿自检（负例必须被检出）
 *
 * 退出码：全通过 0；任一失败 1。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** no-hoisting 的 8 个 npm 子项目（ARCH-20 裁定；Python 包不在 npm 安装面）。 */
export const NPM_SUBPROJECTS = [
  'apps/admin-api',
  'apps/admin-web',
  'apps/executor-node',
  'apps/executor-desktop',
  'packages/acf-cli',
  'packages/mcp-server',
  'packages/autocodeflow-node-sdk',
  'packages/docs-site',
];

/** workspace 发现清单：出现即意味着根成为 npm/pnpm 的安装根。 */
export const DISCOVERY_MANIFESTS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'rush.json'];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 在给定仓库根上执行全部判据。
 * @param {string} repoRoot 仓库根绝对路径
 * @returns {{failures: string[], checks: string[]}}
 */
export function check(repoRoot) {
  const failures = [];
  const checks = [];

  // ① 根 workspaces 字段
  const rootPkgPath = path.join(repoRoot, 'package.json');
  const rootPkg = readJson(rootPkgPath);
  if (!rootPkg) {
    failures.push(`根 package.json 缺失或不是合法 JSON：${rootPkgPath}`);
  } else {
    const ws = rootPkg.workspaces;
    const wsList = Array.isArray(ws) ? ws : ws && Array.isArray(ws.packages) ? ws.packages : null;
    if (wsList && wsList.length > 0) {
      failures.push(
        `根 package.json 声明了非空 workspaces（${wsList.length} 项）——npm 的安装根会从子项目上移到仓库根，` +
          `子项目 \`npm ci\` 将 ERESOLVE 失败（ARCH-28 §1.5 的 161 处版本分裂）。` +
          `turbo 多包模式需要它，这正是 docs/ARCH-28b-turbo-adoption.md 裁定不予接入的原因。`,
      );
    } else {
      checks.push('根 package.json 未声明非空 workspaces（npm prefix 仍在子项目）');
    }

    // ③ packageManager 诚实性
    const pm = rootPkg.packageManager;
    if (pm === undefined) {
      checks.push('根 package.json 未声明 packageManager（不引入错误的包管理器信号）');
    } else if (typeof pm === 'string' && /^npm@/.test(pm)) {
      checks.push(`根 package.json 的 packageManager 为 npm（${pm}）`);
    } else {
      failures.push(
        `根 package.json 的 packageManager 为「${pm}」，但本仓用 npm 安装（8 套 package-lock.json）。` +
          `声明非 npm 的包管理器会让 turbo 读取 pnpm-workspace.yaml 等清单——那是与实现相反的配置，` +
          `且 corepack 严格模式下会真的改写安装行为。`,
      );
    }
  }

  // ② workspace 发现清单
  for (const name of DISCOVERY_MANIFESTS) {
    if (fs.existsSync(path.join(repoRoot, name))) {
      failures.push(
        `根目录出现 workspace 发现清单 ${name}——它是「根是安装根」的信号，会让 turbo 走多包模式并` +
          `连带要求 workspaces 字段。本仓 no-hoisting 模型下不应存在（ARCH-20 / ARCH-28b）。`,
      );
    }
  }
  if (!DISCOVERY_MANIFESTS.some((n) => fs.existsSync(path.join(repoRoot, n)))) {
    checks.push('根目录无 workspace 发现清单（pnpm-workspace/lerna/rush）');
  }

  // ④ 根 lockfile 不得承载依赖图
  const rootLockPath = path.join(repoRoot, 'package-lock.json');
  const rootLock = readJson(rootLockPath);
  if (!rootLock) {
    checks.push('根目录无 package-lock.json（root 无依赖，符合 no-hoisting）');
  } else {
    const keys = Object.keys(rootLock.packages || {});
    const foreign = keys.filter((k) => k !== '');
    if (foreign.length > 0) {
      failures.push(
        `根 package-lock.json 的 packages 映射含 ${foreign.length} 个非根条目（如 ${foreign
          .slice(0, 3)
          .join(', ')}）——根已承载依赖图，hoist 已发生。`,
      );
    } else {
      checks.push('根 package-lock.json 仅含根自身条目（未承载依赖图）');
    }
  }

  // ⑤ 子项目自持 lockfile
  const missing = NPM_SUBPROJECTS.filter((p) => !fs.existsSync(path.join(repoRoot, p, 'package-lock.json')));
  if (missing.length > 0) {
    failures.push(
      `以下 npm 子项目缺少 package-lock.json：${missing.join(', ')}——no-hoisting 模型要求每个子项目自持 lockfile，` +
        `否则该项目的 CI \`npm ci\` 无 lock 可用。`,
    );
  } else {
    checks.push(`全部 ${NPM_SUBPROJECTS.length} 个 npm 子项目自持 package-lock.json`);
  }

  return { failures, checks };
}

function main() {
  const { failures, checks } = check(root);
  for (const c of checks) console.log(`  ✔ ${c}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(`\nno-hoisting 守卫失败（${failures.length} 项）。裁定依据见 docs/ARCH-28b-turbo-adoption.md。`);
    process.exit(1);
  }
  console.log('\nno-hoisting 安装模型完整（ARCH-20 / ARCH-28b）。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(here, 'check-no-hoisting.selftest.mjs')], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  main();
}
