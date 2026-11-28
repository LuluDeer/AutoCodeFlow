#!/usr/bin/env node
/**
 * LIVE-SPECS-WIRED：条件 skip 的门禁接线守卫（2026-11-27）。
 *
 * ## 病
 * 仓内有若干「给了隔离端口才跑」的真 PG / 真 Redis 集成 spec：
 *   · AGENT_RESUME_TEST_REDIS_PORT   —— agent-resume-bullmq.spec.ts
 *   · SOP_CANCEL_TEST_PG_PORT        —— sop-assignment-cancel.integration.spec.ts
 *   · SOP_ADMIN_TEST_PG_PORT         —— sop-admin-pull.integration.spec.ts
 * 它们的形态都是 `const raw = process.env.X; const live = raw === undefined ? describe.skip : describe;`
 * ——没有 env 时 Jest 报的是 **skipped**（绿），不是 failed。此前三个 env 在
 * CI 与任何会被执行的 npm script 里都没有赋值 ⇒ 级别 3 真机断言从未运行，
 * 门禁长期假绿。这类「写了测试但没人跑」比没有测试更坏。
 *
 * ## 判据
 * ① 扫描全仓 `*.spec.* / *.test.*`，提取所有**条件** skip 的门控 env；
 * ② 一个门控 env 必须满足以下至少一条才算接线：
 *    a) 在 `.github/workflows/*.yml` 的 `env:` 里被真实赋值（CI 真跑）；
 *    b) 在**从 CI 引用可达**的 npm script 里被真实赋值（`A=1 node …`）；
 *    只在没人调用的 script 里赋值 **不算**——那正是本守卫要抓的假绿。
 * ③ 提取器自身有下界：扫不到测试文件 / 门控数塌到 0 / 三个已知门控消失 ⇒ 结构红。
 *
 * 用法：
 *   node scripts/check-live-specs-wired.mjs              # 守卫
 *   node scripts/check-live-specs-wired.mjs --selftest   # 自检（夹具树 + 真子进程矩阵）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from './lib/guard-selftest.mjs';
import { printCoverageBanner } from './lib/agent-coverage.mjs';

printCoverageBanner(import.meta.url, 'check');

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), '..');

export const REQUIRED_GATES = [
  'AGENT_RESUME_TEST_REDIS_PORT',
  'SOP_CANCEL_TEST_PG_PORT',
  'SOP_ADMIN_TEST_PG_PORT',
];

/**
 * 刻意默认关闭的 opt-in 场景（与「持久化副作用被静默跳过」不同类）。
 *
 * E2E_NPM_REGISTRY_URL 只在本地/CI 显式起 verdaccio 私服时由
 * `scripts/e2e-full.sh` export；文档 07-testing/e2e-testing.md 明示默认 skip。
 * 它测的是依赖安装来源，不是持久化副作用门禁，故登记制放行；每条仍必须有
 * reason/owner/review_by，过期或 spec 消失都判红（不许变成永久后门）。
 */
export const OPT_IN_GATE_REGISTRY = {
  E2E_NPM_REGISTRY_URL: {
    reason: '私服依赖安装场景需外部 verdaccio，文档明示默认 skip；非持久化副作用门禁',
    owner: 'guard-smith',
    review_by: '2099-12-31',
  },
};
const MIN_TEST_FILES = 50;
const MIN_GATE_COUNT = 3;
const TEST_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_RE = /\b(?:describe|it|test)\.skip\b/;
const CONDITION_RE = /\?|if\s*\(/;
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.codegraph', 'coverage', 'dist', 'build', '.next', 'out',
]);

/** 递归列测试文件（返回相对仓库根路径）。 */
export function listTestFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) walk(join(dir, e.name));
        continue;
      }
      if (TEST_RE.test(e.name)) out.push(relative(root, join(dir, e.name)).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 提取条件 skip 的门控 env。
 *
 * 形态：`const raw = process.env.NAME; const live = raw === undefined ? describe.skip : describe;`
 * 也支持 `process.env['NAME']` / `if (!process.env.NAME) …describe.skip` / `it.skip`。
 * 只扫 skip 所在行前后 6 行的绑定，避免把同文件里无关的 env 读也算进门控。
 */
export function extractGatedEnvs(text, rel = '(unknown)') {
  const lines = String(text ?? '').split(/\r?\n/);
  const bindings = new Map();
  const envInLine = (line, out) => {
    for (const m of line.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) out.add(m[1]);
    for (const m of line.matchAll(/\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) out.add(m[1]);
  };
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      bindings.set(m[1], { env: m[2], line: idx + 1 });
    }
    for (const m of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      bindings.set(m[1], { env: m[2], line: idx + 1 });
    }
  });

  const gates = new Map();
  lines.forEach((line, idx) => {
    if (!SKIP_RE.test(line)) return;
    const from = Math.max(0, idx - 6);
    const window = lines.slice(from, idx + 2).join('\n');
    if (!CONDITION_RE.test(window)) return; // 无条件 describe.skip 不算「门控」
    const found = new Set();
    envInLine(window, found);
    for (const [name, info] of bindings) {
      if (info.line - 1 < from) continue;
      if (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(window)) found.add(info.env);
    }
    for (const env of found) {
      if (!gates.has(env)) gates.set(env, { env, file: rel, line: idx + 1 });
    }
  });
  return [...gates.values()].sort((a, b) => a.env.localeCompare(b.env));
}

/** 读 CI workflow 文本（只读 `ci.yml` / `*.yml` / `*.yaml`）。 */
export function readWorkflows(root = REPO_ROOT) {
  const wfDir = join(root, '.github', 'workflows');
  let names = [];
  try { names = readdirSync(wfDir).filter((f) => /\.(yml|yaml)$/.test(f)); } catch { return []; }
  return names.map((f) => ({ file: f, text: readFileSync(join(wfDir, f), 'utf8') }));
}

/** workflow 里 `NAME: value` 形态的真实 env 赋值（排除注释行）。 */
export function workflowAssignedEnvs(workflows) {
  const out = new Map();
  for (const { file, text } of workflows) {
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\S.*)$/.exec(line);
      if (!m) continue;
      const [, env, raw] = m;
      const value = raw.trim().replace(/^['"]|['"]$/g, '');
      if (!value || value.startsWith('${{')) continue;
      if (!out.has(env)) out.set(env, { env, file, line: i + 1, value });
    }
  }
  return out;
}

/** 解析根 package.json 的 scripts（读不到即结构红）。 */
export function readScripts(root = REPO_ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return { scripts: pkg.scripts ?? {}, error: null };
  } catch (err) {
    return { scripts: {}, error: `package.json 不可读/不可解析：${err.message}` };
  }
}

/**
 * W2（链指针化）：`test:guards:repo`（矩阵入口）/ `test:guards:chain`（runner 入口）的 body
 * 都只剩一句 node 命令；链段本体在 scripts/guards-chain-steps.json（与 runner / matrix 同一事实源）。
 * 读不到 ⇒ 空串（fail-closed：可达面塌缩会让下游误报孤儿，宁可红）。
 */
function chainStepsText(root) {
  try {
    const steps = JSON.parse(readFileSync(join(root, 'scripts', 'guards-chain-steps.json'), 'utf8'))?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return '';
    return steps.map((s) => String(s).trim()).filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

/**
 * 从 CI 文本收集 `npm run X` 引用，再沿 package.json 的 `npm run X` 递归展开，
 * 得到「实际上会被跑到」的 npm script 名字集合。
 */
export function reachableScripts(scripts, workflows, root = REPO_ROOT) {
  const seed = new Set();
  for (const { text } of workflows) {
    for (const m of text.matchAll(/\bnpm\s+run\s+([A-Za-z0-9][\w:-]*)/g)) seed.add(m[1]);
  }
  // test:guards:repo 是本地门禁入口；即便某分支 workflow 文本恰好没写，也按真入口计。
  for (const k of ['test:guards:repo', 'test:guards:chain']) if (scripts[k]) seed.add(k);
  const seen = new Set();
  const stack = [...seed];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    let body = scripts[name];
    if (typeof body !== 'string') continue;
    // W2：入口指针（矩阵/runner）⇒ 等价代入链段本体再继续展开（与 R22 在 check-guards-wired 的手法一致）。
    if (/scripts\/(guards-repo-matrix|run-guards-chain)\.mjs/.test(body)) {
      const stepsText = chainStepsText(root);
      if (stepsText) body = `${body}\n${stepsText}`;
    }
    for (const m of body.matchAll(/\bnpm\s+run\s+([A-Za-z0-9][\w:-]*)/g)) {
      if (!seen.has(m[1])) stack.push(m[1]);
    }
  }
  return seen;
}

/** `ENV=value node …` 形态赋值；只在 reachable 集合内的 script 才算数。 */
export function scriptAssignedEnvs(scripts, reachable) {
  const wired = new Map();
  const orphan = new Map();
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    for (const m of body.matchAll(/(?:^|\s)(?:cross-env\s+)?([A-Z][A-Z0-9_]*)=(\S+)/g)) {
      const env = m[1];
      const target = reachable.has(name) ? wired : orphan;
      if (!target.has(env)) target.set(env, { env, script: name, value: m[2] });
    }
  }
  return { wired, orphan };
}

/** 登记项必须有 reason/owner/review_by，且 review_by 未过期、条目未腐烂。 */
export function registryProblems(registry, gateNames, label) {
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const [env, entry] of Object.entries(registry ?? {})) {
    if (!gateNames.has(env)) {
      errors.push(`${label} ${env} 已无对应门控（登记腐烂）—— 请回收登记`);
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label} ${env} 不是对象（需 reason + owner + review_by）`);
      continue;
    }
    for (const field of ['reason', 'owner', 'review_by']) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length < (field === 'review_by' ? 10 : 4)) {
        errors.push(`${label} ${env} 缺 ${field}（或过短）—— 无理由的门控豁免不许放行`);
      }
    }
    if (typeof entry.review_by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.review_by) && entry.review_by < today) {
      errors.push(`${label} ${env} 的 review_by=${entry.review_by} 已过期 —— 复核期限已过`);
    }
  }
  return errors;
}

/**
 * 主判据。返回 errors[]（带 meta 供报告用）。
 */
export function check(root = REPO_ROOT, {
  requiredGates = REQUIRED_GATES,
  optInRegistry = OPT_IN_GATE_REGISTRY,
} = {}) {
  const errors = [];
  const files = listTestFiles(root);
  if (files.length < MIN_TEST_FILES) {
    errors.push(
      `只扫到 ${files.length} 个测试文件（下界 ${MIN_TEST_FILES}）——` +
        `扫描面塌方（扩展名/目录变了？），「0 个孤儿」不是全绿。`,
    );
    return errors;
  }

  const gates = [];
  for (const rel of files) {
    let text;
    try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const g of extractGatedEnvs(text, rel)) gates.push(g);
  }
  const gateNames = new Set(gates.map((g) => g.env));
  if (gates.length < MIN_GATE_COUNT) {
    errors.push(
      `只提取到 ${gates.length} 个条件 skip 门控 env（下界 ${MIN_GATE_COUNT}）——` +
        `提取器瞎了，或有人把 skip 改成无条件 silent skip。`,
    );
  }
  for (const env of requiredGates) {
    if (!gateNames.has(env)) {
      errors.push(
        `已知门控 ${env} 从测试里消失 —— 要么提取器失效，要么 spec 被删/改名；` +
          `同步 REQUIRED_GATES 前不许算绿。`,
      );
    }
  }
  errors.push(...registryProblems(optInRegistry, gateNames, 'opt-in 门控登记'));

  const workflows = readWorkflows(root);
  if (workflows.length === 0) {
    errors.push(`.github/workflows 下没有 workflow 文本 —— 无从判断 env 是否真接线（fail-closed）`);
  }
  const inCI = workflowAssignedEnvs(workflows);
  const { scripts, error: scriptsError } = readScripts(root);
  if (scriptsError) errors.push(`结构错误：${scriptsError}`);
  const reachable = reachableScripts(scripts, workflows, root);
  const { wired: inScripts, orphan: unreachable } = scriptAssignedEnvs(scripts, reachable);

  for (const g of gates) {
    if (optInRegistry[g.env]) continue; // 有登记的 opt-in 场景，不冒充「已接线」
    if (inCI.has(g.env)) continue;
    if (inScripts.has(g.env)) continue;
    const where = unreachable.has(g.env)
      ? `只在没人跑的 script "${unreachable.get(g.env).script}" 里赋值（不算接线）`
      : '在 CI 与可达 npm script 里都没有赋值';
    errors.push(
      `条件 skip 门控孤儿：${g.env}（${g.file}:${g.line}）—— ${where}；` +
        `spec 永远 skipped 却报绿。请把它接到真实执行 PG/Redis 的 CI job 的 env，` +
        `或接到 CI 可达的 npm script。`,
    );
  }

  errors.meta = {
    testFiles: files.length,
    gates: gates.map((g) => g.env),
    ciEnvs: [...inCI.keys()],
    reachableScripts: reachable.size,
  };
  return errors;
}

// ── 自检：夹具树 + 真子进程，逐条反证门控/可达性/结构下界 ──────────────────
const SELF = fileURLToPath(import.meta.url);

function testSource(env) {
  return [
    `const rawPort = process.env.${env};`,
    `const live = rawPort === undefined ? describe.skip : describe;`,
    `live("fixture ${env}", () => { it.skip("placeholder", () => {}); });`,
    '',
  ].join('\n');
}

function fixtureRepo() {
  const files = {
    'package.json': {
      scripts: {
        'test:guards:repo': 'node scripts/guards-repo-matrix.mjs',
        'test:guards:chain': 'npm run check:reachable',
        'check:reachable': 'BAR_PORT=456 node scripts/bar.mjs',
        'check:dead': 'FOO_PORT=123 node scripts/foo.mjs',
      },
    },
    '.github/workflows/ci.yml': [
      'name: fixture',
      'jobs:',
      '  guards:',
      '    steps:',
      '      - run: npm run test:guards:chain',
      '        env:',
      "          BAZ_PORT: '789'",
      '',
    ].join('\n'),
  };
  for (let i = 0; i < 55; i += 1) {
    files[`src/f${i}.spec.ts`] = `describe("f${i}", () => { it("ok", () => {}); });\n`;
  }
  files['src/live-a.spec.ts'] = testSource('FOO_PORT');
  files['src/live-b.spec.ts'] = testSource('BAR_PORT');
  files['src/live-c.spec.ts'] = testSource('BAZ_PORT');
  return files;
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function runSelftest() {
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  test('真实仓库：三个已知门控都提取得到', () => {
    const gates = new Set(listTestFiles(REPO_ROOT).flatMap((rel) => {
      try { return extractGatedEnvs(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel).map((g) => g.env); }
      catch { return []; }
    }));
    for (const env of REQUIRED_GATES) must(gates.has(env), `没提取到 ${env}（提取器瞎了？）`);
  });

  test('真实仓库：默认清单不是 2 个脚本的缩小面（本守卫自身覆盖率由 inventory 保证）', () => {
    const errs = check(REPO_ROOT);
    const orphan = errs.filter((e) => !e.includes('条件 skip 门控孤儿'));
    must(orphan.length === 0, `真仓库结构错误：${orphan.slice(0, 2).join('；')}`);
    must(errs.meta.gates.length >= MIN_GATE_COUNT, `门控数 ${errs.meta.gates.length}`);
  });

  test('夹具：CI env + 可达 script 都算接线，不可达 script 仍是孤儿', () => {
    const repo = makeFixtureRepo(fixtureRepo(), { prefix: 'live-specs-wired-' });
    try {
      const errs = check(repo.dir, { requiredGates: [], optInRegistry: {} });
      must(errs.length === 1, `期望恰好 1 项（FOO_PORT），实得 ${errs.join('；')}`);
      must(errs[0].includes('FOO_PORT') && errs[0].includes('没人跑'), `报错不对：${errs[0]}`);
      must(errs.meta.gates.length === 3, `门控数 ${errs.meta.gates.length}`);
    } finally { repo.cleanup(); }
  });

  test('夹具：把孤儿 env 接进 CI 后转绿（反证判据有牙）', () => {
    const files = fixtureRepo();
    files['.github/workflows/ci.yml'] = files['.github/workflows/ci.yml'].replace(
      "          BAZ_PORT: '789'",
      "          BAZ_PORT: '789'\n          FOO_PORT: '123'",
    );
    const repo = makeFixtureRepo(files, { prefix: 'live-specs-green-' });
    try {
      const errs = check(repo.dir, { requiredGates: [], optInRegistry: {} });
      must(errs.length === 0, `期望绿，实得 ${errs.join('；')}`);
    } finally { repo.cleanup(); }
  });

  test('夹具：测试文件塌方 → 结构红（不许静默绿）', () => {
    const files = {};
    for (let i = 0; i < 3; i += 1) files[`src/f${i}.spec.ts`] = testSource(`X${i}_PORT`);
    const repo = makeFixtureRepo(files, { prefix: 'live-specs-collapse-' });
    try {
      const errs = check(repo.dir, { requiredGates: [], optInRegistry: {} });
      must(errs.some((e) => e.includes('扫描面塌方')), `errs=${errs.join('；')}`);
    } finally { repo.cleanup(); }
  });

  test('夹具：opt-in 登记缺 review_by/过期 → 红（不许变永久后门）', () => {
    const repo = makeFixtureRepo(fixtureRepo(), { prefix: 'live-specs-signoff-' });
    try {
      const errs = check(repo.dir, {
        requiredGates: [],
        optInRegistry: { FOO_PORT: { reason: 'fixture opt-in scenario', owner: 'x' } },
      });
      must(errs.some((e) => e.includes('review_by')), `errs=${errs.join('；')}`);
    } finally { repo.cleanup(); }
  });

  test('CLI：真仓库原样 → exit 0（控制组）', () => {
    expectExit(runGuard(SELF), {
      code: 0,
      contains: ['条件 skip 门控接线守卫通过'],
      absent: ['✘'],
      withinMs: 2000,
      label: 'CLI 真仓库原样',
    });
  });

  const failed = reportCases(cases, { title: 'check-live-specs-wired selftest' });
  return failed === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) process.exit(runSelftest());
  const errors = check(REPO_ROOT);
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(
      `✔ 条件 skip 门控接线守卫通过：${meta.gates.length} 个门控 env 中无孤儿` +
        `（扫描 ${meta.testFiles} 个测试文件，可达 script ${meta.reachableScripts} 条；` +
        `opt-in 登记 ${Object.keys(OPT_IN_GATE_REGISTRY).length} 条）。`,
    );
    return 0;
  }
  console.error(`✘ 条件 skip 门控接线守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) process.exit(main());
