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
 * ## T4（第 4 轮守卫自检审计）：伴生 selftest **收编**进 `--selftest`
 *
 * 原 `scripts/check-no-hoisting.selftest.mjs` 已删除，13 条断言全部并入下面的
 * `selftest()`（判据逐条保留，见该函数内的用例对照）。**为什么收编而不是保留**：
 *   · 该伴生文件的每一条用例都在测**本脚本的判据**——它 `import { check,
 *     NPM_SUBPROJECTS }`，喂 `check()` 一份内存 fixture 再断言返回的 failures。
 *     判据在本文件里，事实源（根 manifest / 8 套 lockfile）也在本文件里，
 *     没有任何独立工具、网络或打包产物参与——不存在「伴生文件比主脚本多测了什么」
 *     的成分，也就不存在保留它的理由（check-migrations 前例）。
 *   · 旧形态的共同失效模式正好落在「函数级断言」的盲区：它直接调 `check()`，
 *     于是 **CLI 入口的 `process.exit(1)` 被删掉、`--root` 把路径吃掉、
 *     报错文案改两个字符**这三种坏法它一条都看不见（删掉 exit(1) 它照样全绿）。
 *     收编时全部改写为 `runGuard` 真子进程 + `expectExit` 断言退出码与关键文本。
 *   · 读真实仓库的那条（「守卫真的在跑」）也保留，但改成不带 `--root` 跑真脚本
 *     （旧版用 `process.cwd()` 之外的路径自算仓库根，Windows 上曾因
 *     `new URL().pathname` 得到 `\E:\…` 而在不存在的根上跑 → 恒红，见
 *     docs/archive/reports/audit-completion-summary-2026-10-17.md 的 SELFTEST-PATH）。
 *
 * ## T4 同时补的两件事（不改判据语义，只堵「没被扫到 = 没问题」）
 *   · **`--root`**：模块级 `const root = path.resolve(here,'..')` 收成参数，
 *     `import` 本文件时不实扫、不 `process.exit`；selftest 才能在 fixture 树上跑真脚本。
 *   · **结构红**（与「违规」分开的退出通道与文案）：根 package.json 缺失/非法、
 *     在盘子项目目录数跌破下界。旧版把它们混在 failures 里，或者干脆
 *     `readJson` 吞掉异常（`catch { return null }`）——一份写坏的根 manifest
 *     会被报成「根 package.json 缺失」，而为 0 个子项目目录时 ⑤ 只是「缺 8 个
 *     lockfile」的噪音，真正的原因（`--root` 指错了树）看不到。
 *
 * 纯静态读取，不需要 npm ci / 网络 / PG，秒级。
 *
 * 用法：
 *   node scripts/check-no-hoisting.mjs                  # 正式检查
 *   node scripts/check-no-hoisting.mjs --selftest       # 有齿自检（真子进程）
 *   node scripts/check-no-hoisting.mjs --root <dir>     # 只给 selftest：把 fixture 当仓库根
 *
 * 退出码：全通过 0；任一失败 / 结构错误 1。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const SELF = fileURLToPath(import.meta.url);

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

/**
 * 扫描面下界：至少半数子项目目录在盘（实测 8/8）。
 *
 * 「0 个子项目目录 = 0 个缺 lockfile」不是本守卫的形态（②⑤ 会逐条报红），
 * 但**诊断会错**：`--root` 指到空树时，人看到的是「8 个子项目全都缺 lockfile」，
 * 于是去查 lockfile，而真正的原因是根指错了。下界让这条走结构红并直说原因。
 */
export const MIN_SUBPROJECT_DIRS = 4;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 在给定仓库根上执行全部判据。
 *
 * @param {string} repoRoot 仓库根绝对路径
 * @returns {{failures: string[], checks: string[], structure: string[]}}
 *   `failures` 是违规（判据被违反）；`structure` 是「判据本身不可信」的结构错误
 *   （事实源缺失 / 扫描面塌陷）。两者都要 exit 1，但文案与顺序不同：
 *   结构错误先报，因为此时 failures 的内容可能是噪音。
 */
export function check(repoRoot) {
  const failures = [];
  const checks = [];
  const structure = [];

  // ⓪ 结构：根在不在（`--root` 指错树时，下面每条判据都在说胡话）
  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    structure.push(`仓库根不存在或不是目录：${repoRoot}（--root 指错了树？）`);
    return { failures, checks, structure };
  }

  // ① 根 workspaces 字段
  const rootPkgPath = path.join(repoRoot, 'package.json');
  const rootPkg = readJson(rootPkgPath);
  if (!rootPkg) {
    // 事实源缺失/不可解析 → 结构红。旧版把这条混在 failures 里，于是一份写坏的
    // manifest 与「真的声明了 workspaces」共用同一个退出通道，归因困难。
    structure.push(
      `根 package.json 缺失或不是合法 JSON：${rootPkgPath}（①②③ 三条判据的事实源，缺失即判据不可信）`,
    );
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

  // ⑤ 子项目自持 lockfile（先过扫描面下界：目录都不在时，下面的清单没有意义）
  const presentDirs = NPM_SUBPROJECTS.filter((p) => {
    try {
      return fs.statSync(path.join(repoRoot, p)).isDirectory();
    } catch {
      return false;
    }
  });
  if (presentDirs.length < MIN_SUBPROJECT_DIRS) {
    structure.push(
      `只扫到 ${presentDirs.length} 个 npm 子项目目录（下界 ${MIN_SUBPROJECT_DIRS}）——` +
        `下面的「缺 lockfile」清单大概率是噪音：根可能不是仓库根（--root 指错），` +
        `或 NPM_SUBPROJECTS 与目录布局已漂移。`,
    );
    return { failures, checks, structure };
  }

  const missing = NPM_SUBPROJECTS.filter((p) => !fs.existsSync(path.join(repoRoot, p, 'package-lock.json')));
  if (missing.length > 0) {
    failures.push(
      `以下 npm 子项目缺少 package-lock.json：${missing.join(', ')}——no-hoisting 模型要求每个子项目自持 lockfile，` +
        `否则该项目的 CI \`npm ci\` 无 lock 可用。`,
    );
  } else {
    checks.push(`全部 ${NPM_SUBPROJECTS.length} 个 npm 子项目自持 package-lock.json`);
  }

  return { failures, checks, structure };
}

// ── 自检（T4：原 checks 全部改写为真子进程断言）───────────────────────────
function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 造一份「干净」仓库骨架：8 子项目各持 lockfile，根 lock 仅含自身。 */
function tree({
  rootPkg = { name: 'r', version: '1.0.1', private: true },
  rootLock,
  locks = NPM_SUBPROJECTS,
  extra = {},
} = {}) {
  const files = {};
  // 传 null 表示「这个事实源不存在」（用于事实源缺失的反证）
  if (rootPkg !== null) files['package.json'] = rootPkg;
  const lock =
    rootLock === undefined
      ? { name: 'r', version: '1.0.1', lockfileVersion: 3, packages: { '': { name: 'r' } } }
      : rootLock;
  if (lock !== null) files['package-lock.json'] = lock;
  for (const p of locks) {
    files[`${p}/package.json`] = { name: p, version: '0.0.1', private: true };
    files[`${p}/package-lock.json`] = { name: p, lockfileVersion: 3, packages: {} };
  }
  return { ...files, ...extra };
}

/**
 * 自检：17 条用例，全部 `runGuard` 真子进程（`--root` 指向 fixture 树）。
 *
 * ①–⑬ 是原伴生 `check-no-hoisting.selftest.mjs` 的 13 条断言（判据逐条保留）：
 *   ① 干净骨架全绿　② 根 workspaces 数组　③ workspaces.packages 对象形态
 *   ④ 空 workspaces 不误报　⑤–⑧ 四个发现清单　⑨ packageManager=pnpm
 *   ⑩ packageManager=npm 不误报　⑪ 根 lock 承载依赖图　⑫ 子项目缺 lockfile
 *   ⑬ 真实仓库全绿（守卫真的在跑）
 * ⑭–⑰ 是 T4 新增的结构红与扫描面下界反证。
 */
export function selftest() {
  const cases = [];
  /** @param {(fixtureDir: string) => string} [rootOf] fixture 根 → 实际传给 `--root` 的路径 */
  const subprocess = (name, files, expect, rootOf = (d) => d) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'no-hoisting-selftest-' });
        try {
          expectExit(runGuard(SELF, { args: ['--root', rootOf(repo.dir)] }), {
            ...expect,
            withinMs: 3000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ── 正例：干净骨架必须全绿（否则守卫是「永远红」，等于没有） ──────────
  subprocess('① 干净骨架（8 子项目自持 lockfile、根 lock 仅含自身）→ 绿', tree(), {
    code: 0,
    contains: [
      'no-hoisting 安装模型完整（ARCH-20 / ARCH-28b）。',
      `全部 ${NPM_SUBPROJECTS.length} 个 npm 子项目自持 package-lock.json`,
      '根 package.json 未声明非空 workspaces',
    ],
    absent: ['✘', '结构错误'],
  });

  // ── ①②：根 workspaces 非空 = npm prefix 上移（实测：子项目 npm ci ERESOLVE） ──
  subprocess(
    '② 根 workspaces 数组非空 → 红并点明 ERESOLVE 后果',
    tree({ rootPkg: { name: 'r', version: '1.0.1', private: true, workspaces: NPM_SUBPROJECTS } }),
    {
      code: 1,
      contains: ['声明了非空 workspaces', `${NPM_SUBPROJECTS.length} 项`, 'ERESOLVE'],
      absent: ['no-hoisting 安装模型完整'],
    },
  );

  // 对象形态 workspaces.packages 同样要检出（pnpm/npm 两种写法）
  subprocess(
    '③ workspaces.packages 对象形态 → 红（pnpm 写法同样上移 prefix）',
    tree({ rootPkg: { name: 'r', version: '1.0.1', private: true, workspaces: { packages: ['apps/*'] } } }),
    { code: 1, contains: ['声明了非空 workspaces', 'ERESOLVE'], absent: ['no-hoisting 安装模型完整'] },
  );

  // 空数组是**合法**的（实测不触发 hoist）——不得误报
  subprocess(
    '④ 空 workspaces 数组 → 绿（实测不 hoist，不得误报）',
    tree({ rootPkg: { name: 'r', version: '1.0.1', private: true, workspaces: [] } }),
    { code: 0, contains: ['no-hoisting 安装模型完整'], absent: ['✘'] },
  );

  // ── ②：workspace 发现清单（4 种，逐个单测——它们是 4 条独立的触发条件） ────
  DISCOVERY_MANIFESTS.forEach((name, i) => {
    const body = name.endsWith('.yaml') || name.endsWith('.yml') ? 'packages:\n  - "apps/*"\n' : '{}';
    subprocess(
      `${['⑤', '⑥', '⑦', '⑧'][i]} 根目录出现 ${name} → 红（「根是安装根」的信号）`,
      tree({ extra: { [name]: body } }),
      { code: 1, contains: [`workspace 发现清单 ${name}`], absent: ['no-hoisting 安装模型完整'] },
    );
  });

  // ── ③：packageManager 诚实性 ─────────────────────────────────────
  subprocess(
    '⑨ packageManager=pnpm → 红（与 npm 安装面相反）',
    tree({ rootPkg: { name: 'r', version: '1.0.1', private: true, packageManager: 'pnpm@10.0.0' } }),
    {
      code: 1,
      contains: ['packageManager 为「pnpm@10.0.0」', 'corepack 严格模式下会真的改写安装行为'],
      absent: ['no-hoisting 安装模型完整'],
    },
  );
  subprocess(
    '⑩ packageManager=npm → 绿（诚实声明不误报）',
    tree({ rootPkg: { name: 'r', version: '1.0.1', private: true, packageManager: 'npm@11.19.0' } }),
    { code: 0, contains: ['packageManager 为 npm（npm@11.19.0）'], absent: ['✘'] },
  );

  // ── ④：根 lockfile 承载依赖图 = hoist 已发生 ─────────────────────
  subprocess(
    '⑪ 根 package-lock.json 含非根条目 → 红（hoist 已发生）',
    tree({
      rootLock: {
        name: 'r',
        lockfileVersion: 3,
        packages: { '': { name: 'r' }, 'node_modules/express': { version: '4.22.2' } },
      },
    }),
    { code: 1, contains: ['非根条目', 'node_modules/express', 'hoist 已发生'], absent: ['no-hoisting 安装模型完整'] },
  );

  // ── ⑤：子项目自持 lockfile ───────────────────────────────────────
  subprocess(
    '⑫ 子项目缺 package-lock.json → 红并点名该项目',
    tree({ locks: NPM_SUBPROJECTS.filter((p) => p !== 'apps/admin-api') }),
    {
      code: 1,
      contains: ['以下 npm 子项目缺少 package-lock.json：apps/admin-api', 'npm ci` 无 lock 可用'],
      absent: ['no-hoisting 安装模型完整'],
    },
  );

  // ── 反证有牙：真实仓库当前状态喂进去必须绿（守卫不能空转） ──────────
  // 不带 `--root`：走 CLI 默认根（process.cwd() = 仓库根），这条同时钉住
  // 「默认根仍在仓库根」——旧伴生文件用自算路径，Windows 上曾在不存在的根上跑。
  cases.push({
    name: '⑬ 真实仓库当前状态全绿（守卫真的在跑，默认根=仓库根）',
    fn: () => {
      expectExit(runGuard(SELF), {
        code: 0,
        withinMs: 3000,
        contains: [`全部 ${NPM_SUBPROJECTS.length} 个 npm 子项目自持 package-lock.json`, 'no-hoisting 安装模型完整'],
        absent: ['✘'],
        label: '⑬ 真实仓库',
      });
    },
  });

  // ── ⑭ 结构红：事实源缺失（根 package.json 被删） ──────────────────
  subprocess('⑭ 事实源缺失（根 package.json 不存在）→ 结构红，不与违规混报', tree({ rootPkg: null }), {
    code: 1,
    contains: ['结构错误', '根 package.json 缺失或不是合法 JSON', '缺失即判据不可信'],
    absent: ['no-hoisting 安装模型完整', 'Error:', 'ENOENT'],
  });

  // ── ⑮ 结构红：事实源不可解析（根 package.json 是坏 JSON） ─────────
  subprocess(
    '⑮ 事实源不可解析（根 package.json 是坏 JSON）→ 结构红（旧版 readJson 吞异常）',
    tree({ rootPkg: '{ this is not json' }),
    {
      code: 1,
      contains: ['结构错误', '根 package.json 缺失或不是合法 JSON'],
      absent: ['no-hoisting 安装模型完整', 'SyntaxError'],
    },
  );

  // ── ⑯ 结构红：扫描面下界（--root 指到不是仓库根的树） ────────────
  subprocess(
    `⑯ 只扫到 ${MIN_SUBPROJECT_DIRS - 1} 个子项目目录 → 结构红（不是「缺 lockfile」的噪音）`,
    tree({ locks: NPM_SUBPROJECTS.slice(0, MIN_SUBPROJECT_DIRS - 1) }),
    {
      code: 1,
      contains: ['结构错误', `只扫到 ${MIN_SUBPROJECT_DIRS - 1} 个 npm 子项目目录（下界 ${MIN_SUBPROJECT_DIRS}）`],
      absent: ['no-hoisting 安装模型完整', '缺少 package-lock.json：'],
    },
  );

  // ── ⑰ 结构红：根不存在（--root 指到不存在的路径） ────────────────
  subprocess(
    '⑰ --root 指向不存在的目录 → 结构红（不崩栈、不静默）',
    tree(),
    { code: 1, contains: ['结构错误', '仓库根不存在或不是目录', '--root 指错了树'], absent: ['no-hoisting 安装模型完整'] },
    (dir) => path.join(dir, 'missing-subdir'),
  );

  const failed = reportCases(cases, { title: 'check-no-hoisting selftest' });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    const root = path.resolve(argValue(process.argv, '--root') ?? process.cwd());
    const { failures, checks, structure } = check(root);

    if (structure.length > 0) {
      console.error('');
      console.error('✖ no-hoisting 守卫结构错误（判据本身不可信）：');
      for (const e of structure) console.error(`  · ${e}`);
      console.error('');
      process.exit(1);
    }
    for (const c of checks) console.log(`  ✔ ${c}`);
    if (failures.length > 0) {
      console.error('');
      for (const f of failures) console.error(`  ✘ ${f}`);
      console.error(`\nno-hoisting 守卫失败（${failures.length} 项）。裁定依据见 docs/ARCH-28b-turbo-adoption.md。`);
      process.exit(1);
    }
    console.log('\nno-hoisting 安装模型完整（ARCH-20 / ARCH-28b）。');
  }
}
