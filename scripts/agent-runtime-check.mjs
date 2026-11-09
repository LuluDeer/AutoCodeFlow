#!/usr/bin/env node
/**
 * P2（agent-and-deployment）运行时行为验证 —— Agent 运行时底座。
 *
 * 验证目标（设计文档 02）：
 *   · 预算闸门四道（steps / tokens / wallClock / toolCalls）
 *   · 推理循环：多轮、终态判定（模型不再要工具 = 给结论）
 *   · 可重入：从 DB 的 steps 重建 messages（挂起/重启恢复的基础）
 *   · 幂等：终态会话不重复运行
 *   · fail-open：模型调用失败收敛为 failed，不抛出
 *   · 指标埋点确实发生
 *
 * 同 P1：admin-api 的 jest 在本环境整模块不可运行（既有问题，未改动模块
 * 同样失败），故走「转译 + 直接实例化 + 依赖打桩」的运行时 harness，
 * 验证**行为**而非文本匹配。
 *
 * 用法:
 *   node scripts/agent-runtime-check.mjs              # 主跑（需 admin-api 依赖）
 *   node scripts/agent-runtime-check.mjs --selftest   # 判据自检（零依赖，夹具内跑）
 *   node scripts/agent-runtime-check.mjs --root <dir> # 只跑纯源码文本判据，以 <dir> 为根
 *
 * ## R160：为什么有 `--selftest` 形态（判据③）
 *
 * 判据③ 要求「有自检的守卫，其自检必须被本地与 CI 两面真的执行到」。本守卫此前
 * 没有 `--selftest` 形态 ⇒ 判据本体没有可被跑到的自检。
 *
 * **核事实：判据本体没有被任何 jest spec 完全覆盖。** `agent-runtime.service.spec.ts`
 * 覆盖了推理循环/幂等/终态/预算闸门的大头，但「指标**发射侧**」（`recordRuntime`
 * 的调用点与标签）、「指标注册表登记」、「队列隔离（AGENT_QUEUE_NAME / 并发上限 /
 * 未预期异常不重抛 / registerQueue）」、「模块单向依赖注释纪律」这几组**零覆盖**
 * （`app.module.spec.ts` 只测根 BullMQ 配置，不测 agent.module）。
 * ⇒ 不能用 `covered-elsewhere` 豁免。
 *
 * ## 自检的边界（**如实写明**）
 *
 * 判据分两类：
 *   ① **需要转译 + 运行**（预算闸门、推理循环、指标运行时捕获）⇒ 需要 admin-api
 *      的 typescript / reflect-metadata / @nestjs ⇒ **夹具里跑不了**；
 *   ② **纯源码文本**（指标发射侧的调用点/标签、指标注册表、队列隔离）⇒ 只
 *      `readFileSync` 读源码做正则匹配 ⇒ **可在夹具里真跑**。
 *
 * ⇒ 本 `--selftest` 覆盖**第 ② 类**；第 ① 类由 jest spec + CI 的
 * `npm run test:agent` 主跑覆盖。**不是**「全部断言都有自检」。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { printCoverageBanner } from "./lib/agent-coverage.mjs";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apiDir = join(root, "apps/admin-api");
const require = createRequire(join(apiDir, "package.json"));

// 覆盖哨兵（S6-6-4）的计数出口：**必须在下面 require 依赖之前打**——本脚本缺
// admin-api 的 typescript/reflect-metadata 时会在 require() 处直接崩，而「崩了」
// 与「零用例」是两件事，哨兵要能分开看。stdout 是同步写的，崩溃前打出来的行
// 父进程一定读得到（异步写会丢）。
printCoverageBanner(import.meta.url, "check");

const argv = process.argv.slice(2);

/** `--root <dir>`：以 <dir> 为仓库根（**只给 selftest**：把夹具树当仓库根扫）。 */
function argRoot(args) {
  const eq = args.find((a) => a.startsWith("--root="));
  if (eq) return resolve(eq.slice("--root=".length));
  const at = args.indexOf("--root");
  if (at >= 0) return resolve(args[at + 1] ?? root);
  return root;
}

const SELF = fileURLToPath(import.meta.url);

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/**
 * 第 ② 类断言：**纯源码文本**（指标发射侧调用点/标签、指标注册表、队列隔离）。
 *
 * 抽成函数并以 `rootDir` 为参数 ⇒ **同一份判据**既能被主跑在真仓库上跑，也能被
 * `--selftest` 在夹具树上跑（自检测的是**判据本身**，不是抄一份副本——副本会与
 * 被测判据各自演化，副本绿 ≠ 守卫绿，见 `lib/guard-selftest.mjs` 头注）。
 *
 * 不在这里的：§3 的**运行时捕获**部分（`recorded` 来自真实执行）——那需要转译。
 *
 * @param {string} rootDir 仓库根（主跑 = 真仓库；自检 = 夹具树）
 */
function checkSourceTextGroups(rootDir) {
  const api = join(rootDir, "apps/admin-api");

  // ═══ 3b. 指标埋点（结构断言：发射侧与注册表）══════════════════════
  console.log("\n── 3b. 指标埋点（结构）──");
  {
    // ② 结构断言——会话服务是埋点的主出口
    const sess = readFileSync(join(api, "src/modules/agent/runtime/agent-session.service.ts"), "utf8");
    check("会话终态埋点存在", /recordRuntime\("autoflow_agent_sessions_total"/.test(sess));
    check("  带 kind + status 标签", /autoflow_agent_sessions_total",\s*\{\s*kind: session\.kind,\s*status,/s.test(sess));
    // 允许跨行调用（2026-10-29：为传第三参 value=令牌数 而换行）
    check("令牌埋点存在（成本归因）", /recordRuntime\(\s*"autoflow_agent_tokens_total"/.test(sess));
    // 增量必须是令牌数而不是事件次数（观测审计 P1：此前是 +1，成本低 2~3 个数量级）
    check("  令牌增量传实际数量（不是 +1）", /direction: "in",[\s\S]{0,200}?tokensIn,/.test(sess) && /direction: "out",[\s\S]{0,200}?tokensOut,/.test(sess));
    check("  令牌按 in/out 分别计", /direction: "in"/.test(sess) && /direction: "out"/.test(sess));
    check("  带 provider/model 标签", /provider: input\.provider/.test(sess) && /model: input\.model/.test(sess));
    check("工具调用埋点存在", /recordRuntime\("autoflow_agent_tool_calls_total"/.test(sess));
    // OBS3-02：tool label 必须经 metricToolLabel 收敛（注册表外的名字→unknown），
    // 不能直接把模型返回的函数名写进指标（基数无界）。
    check(
      "  带 tool/tier/status 标签且 tool 已收敛",
      /tool: this\.metricToolLabel\(input\.toolName\)/.test(sess) &&
        /tier: input\.tier/.test(sess),
    );

    // 指标名必须在注册表里（否则 recordRuntime 静默忽略，埋点形同虚设）
    const reg = readFileSync(join(api, "src/modules/metrics/runtime-metrics.ts"), "utf8");
    for (const n of [
      "autoflow_agent_sessions_total",
      "autoflow_agent_tokens_total",
      "autoflow_agent_tool_calls_total",
      "autoflow_agent_denied_total",
      "autoflow_agent_budget_exceeded_total",
    ]) {
      check(`指标已注册: ${n}`, reg.includes(`"${n}"`));
    }
  }

  // ═══ 4. 队列隔离 ══════════════════════════════════════════════════
  console.log("\n── 4. 队列隔离（静态断言）──");
  {
    const proc = readFileSync(join(api, "src/modules/agent/runtime/agent.processor.ts"), "utf8");
    check("队列名独立于 task-queue", /AGENT_QUEUE_NAME = "agent-jobs"/.test(proc));
    check("并发上限固定为 2（不随 CPU 弹性扩）", /AGENT_QUEUE_CONCURRENCY = 2/.test(proc));
    check("未预期异常不重抛（避免重复副作用）", /不重抛/.test(proc));

    const mod = readFileSync(join(api, "src/modules/agent/agent.module.ts"), "utf8");
    check("模块注册独立队列", /BullModule\.registerQueue\(\{ name: AGENT_QUEUE_NAME \}\)/.test(mod));
    check("模块未被业务模块依赖的注释纪律在", /单向依赖/.test(mod));
  }
}

// ── selftest（零依赖：夹具树 + 真子进程）────────────────────────────────
//
// 夹具自造**最小副本**（不含真仓库的 admin-api 源码）⇒ 自检零依赖、能进
// `test:guards` 本地面；同时夹具形态与真源码一致 ⇒ 判据在夹具上红，真源码上也会红。
// 每条反例都配一条正例控制组（否则「expectExit 永远抛」也能让全部负例通过）。

/** 夹具：形态正确的最小副本（正例控制组）。 */
const FIXTURE_OK = {
  "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts": [
    'recordRuntime("autoflow_agent_sessions_total", {',
    "  kind: session.kind,",
    "  status,",
    "});",
    "recordRuntime(",
    '  "autoflow_agent_tokens_total",',
    "  {",
    "    provider: input.provider,",
    "    model: input.model,",
    '    direction: "in",',
    "  },",
    "  tokensIn,",
    ");",
    "recordRuntime(",
    '  "autoflow_agent_tokens_total",',
    "  {",
    "    provider: input.provider,",
    "    model: input.model,",
    '    direction: "out",',
    "  },",
    "  tokensOut,",
    ");",
    'recordRuntime("autoflow_agent_tool_calls_total", {',
    "  tool: this.metricToolLabel(input.toolName), tier: input.tier, status });",
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/metrics/runtime-metrics.ts": [
    '"autoflow_agent_sessions_total"',
    '"autoflow_agent_tokens_total"',
    '"autoflow_agent_tool_calls_total"',
    '"autoflow_agent_denied_total"',
    '"autoflow_agent_budget_exceeded_total"',
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/agent/runtime/agent.processor.ts": [
    'const AGENT_QUEUE_NAME = "agent-jobs";',
    "const AGENT_QUEUE_CONCURRENCY = 2;",
    "// 未预期异常不重抛（避免重复副作用）",
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/agent/agent.module.ts": [
    "BullModule.registerQueue({ name: AGENT_QUEUE_NAME })",
    "// 单向依赖：业务模块不依赖本模块",
    "",
  ].join("\n"),
};

function fixtureWith(rel, content) {
  return { ...FIXTURE_OK, [rel]: content };
}

function runSelftest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  const runOn = (files) => {
    const repo = makeFixtureRepo(files, { prefix: "agent-runtime-selftest-" });
    const result = runGuard(SELF, { args: ["--root", repo.dir] });
    return { result, cleanup: repo.cleanup };
  };

  add("① 正例控制组：形态正确的夹具 ⇒ 全绿（0 失败）", () => {
    const { result, cleanup } = runOn(FIXTURE_OK);
    try {
      expectExit(result, {
        code: 0,
        contains: ["全部运行时断言通过"],
        absent: ["✘"],
        label: "控制组",
      });
    } finally {
      cleanup();
    }
  });

  add("② 反证：会话终态埋点被删 ⇒ 红", () => {
    const { result, cleanup } = runOn({ ...FIXTURE_OK });
    try {
      // 直接删掉 sessions_total 那一行
      const repo = makeFixtureRepo(
        fixtureWith(
          "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts",
          FIXTURE_OK["apps/admin-api/src/modules/agent/runtime/agent-session.service.ts"].replace(
            /recordRuntime\("autoflow_agent_sessions_total"[^\n]*\n/,
            "",
          ),
        ),
        { prefix: "agent-runtime-selftest-" },
      );
      try {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 1,
          contains: ["会话终态埋点存在"],
          label: "终态埋点",
        });
      } finally {
        repo.cleanup();
      }
    } finally {
      cleanup();
    }
  });

  add("③ 反证：令牌增量退回 +1（不是实际数量）⇒ 红", () => {
    const repo = makeFixtureRepo(
      fixtureWith(
        "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts",
        FIXTURE_OK["apps/admin-api/src/modules/agent/runtime/agent-session.service.ts"]
          .replace(/\n  tokensIn,\n/g, "\n  1,\n")
          .replace(/\n  tokensOut,\n/g, "\n  1,\n"),
      ),
      { prefix: "agent-runtime-selftest-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["令牌增量传实际数量"],
        label: "令牌增量",
      });
    } finally {
      repo.cleanup();
    }
  });

  add("④ 反证：tool 标签不走 metricToolLabel（基数无界）⇒ 红", () => {
    const repo = makeFixtureRepo(
      fixtureWith(
        "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts",
        FIXTURE_OK["apps/admin-api/src/modules/agent/runtime/agent-session.service.ts"].replace(
          /tool: this\.metricToolLabel\(input\.toolName\)/g,
          "tool: input.toolName",
        ),
      ),
      { prefix: "agent-runtime-selftest-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["tool 已收敛"],
        label: "tool 收敛",
      });
    } finally {
      repo.cleanup();
    }
  });

  add("⑤ 反证：指标未在注册表登记 ⇒ 红（recordRuntime 会静默忽略）", () => {
    const repo = makeFixtureRepo(
      fixtureWith(
        "apps/admin-api/src/modules/metrics/runtime-metrics.ts",
        FIXTURE_OK["apps/admin-api/src/modules/metrics/runtime-metrics.ts"].replace(
          /"autoflow_agent_denied_total"\n/,
          "",
        ),
      ),
      { prefix: "agent-runtime-selftest-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["指标已注册: autoflow_agent_denied_total"],
        label: "指标注册",
      });
    } finally {
      repo.cleanup();
    }
  });

  add("⑥ 反证：并发上限被改成 CPU 弹性 ⇒ 红", () => {
    const repo = makeFixtureRepo(
      fixtureWith(
        "apps/admin-api/src/modules/agent/runtime/agent.processor.ts",
        'const AGENT_QUEUE_NAME = "agent-jobs";\nconst AGENT_QUEUE_CONCURRENCY = os.cpus().length;\n// 不重抛\n',
      ),
      { prefix: "agent-runtime-selftest-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["并发上限固定为 2"],
        label: "并发上限",
      });
    } finally {
      repo.cleanup();
    }
  });

  add("⑦ 反证：队列名退回与 task-queue 共用 ⇒ 红", () => {
    const repo = makeFixtureRepo(
      fixtureWith(
        "apps/admin-api/src/modules/agent/runtime/agent.processor.ts",
        'const AGENT_QUEUE_NAME = "task-queue";\nconst AGENT_QUEUE_CONCURRENCY = 2;\n// 不重抛\n',
      ),
      { prefix: "agent-runtime-selftest-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["队列名独立于 task-queue"],
        label: "队列名",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "agent-runtime-check selftest" });
  return failed > 0 ? 1 : 0;
}

// ── 入口分派（**必须在任何依赖 require 之前**）────────────────────────
if (argv.includes("--selftest")) {
  process.exit(runSelftest());
}

if (argv.includes("--root")) {
  const rootDir = argRoot(argv);
  console.log(`\n=== P2 Agent 运行时（纯文本判据面，根 = ${rootDir}）===\n`);
  checkSourceTextGroups(rootDir);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部运行时断言通过 ===\n");
  process.exit(failures ? 1 : 0);
}

// TypeORM 实体装饰器需要 reflect-metadata 先就位
require("reflect-metadata");

// ── 转译本地 import 图 ────────────────────────────────────────────
const ts = require("typescript");
const scratch = join(apiDir, ".agent-check");
mkdirSync(scratch, { recursive: true });
const transpiled = new Set();

function transpileOne(relPath) {
  const src = readFileSync(join(apiDir, relPath), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      // 必须为 true：TypeORM 实体靠装饰器元数据推断列类型，缺了会在
      // 加载时报 「Column type ... cannot be guessed」（P1 的 ai.service
      // 是纯服务不需要，这里因为要加载 entity 而必须开）。
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
    fileName: relPath,
  });
  const dest = join(scratch, relPath.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out.outputText);
  return src;
}

function transpileGraph(entryRel) {
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (transpiled.has(rel)) continue;
    transpiled.add(rel);
    let src;
    try {
      src = transpileOne(rel);
    } catch {
      continue;
    }
    const re = /from\s+["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const base = join(dirname(rel), m[1]).replace(/\\/g, "/");
      for (const cand of [`${base}.ts`, `${base}/index.ts`]) {
        if (transpiled.has(cand)) break;
        try {
          readFileSync(join(apiDir, cand));
          queue.push(cand);
          break;
        } catch {
          /* next */
        }
      }
    }
  }
}

let budgetMod, runtimeMod, sessionEntity;
try {
  transpileGraph("src/modules/agent/runtime/agent-budget.service.ts");
  transpileGraph("src/modules/agent/runtime/agent-runtime.service.ts");
  transpileGraph("src/modules/agent/entities/agent-session.entity.ts");
  budgetMod = require(join(scratch, "src/modules/agent/runtime/agent-budget.service.js"));
  runtimeMod = require(join(scratch, "src/modules/agent/runtime/agent-runtime.service.js"));
  sessionEntity = require(join(scratch, "src/modules/agent/entities/agent-session.entity.js"));
} catch (err) {
  console.error(`\n[FATAL] 转译失败: ${err.message}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const { AgentBudgetService, DEFAULT_BUDGET } = budgetMod;
const { AgentRuntimeService } = runtimeMod;

// ── 指标埋点捕获 ──────────────────────────────────────────────────
// agent-budget.service 与 agent-runtime.service 都经 runtime-metrics-entry
// 的 recordRuntime 打点。直接 require 真实模块并包一层计数。
const metricsEntryPath = join(scratch, "src/modules/metrics/runtime-metrics-entry.js");
const metricsEntry = require(metricsEntryPath);
const recorded = [];
const originalRecord = metricsEntry.recordRuntime;
metricsEntry.recordRuntime = (name, labels) => {
  recorded.push({ name, labels });
  return originalRecord(name, labels);
};

console.log("\n=== P2 Agent 运行时行为验证 ===\n");

// ═══ 1. 预算闸门（四道）══════════════════════════════════════════
console.log("── 1. 预算闸门 ──");
{
  const svc = new AgentBudgetService({ get: () => undefined });
  const b = DEFAULT_BUDGET;

  const mk = (o = {}) => ({ steps: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, startedAt: null, ...o });

  check("全新会话预算通过", svc.check(b, mk()).ok === true);

  const rSteps = svc.check(b, mk({ steps: b.maxSteps }));
  check("步数达上限 → 拒绝", rSteps.ok === false);
  check("  超限项为 max_steps", rSteps.kind === "max_steps");

  const rTok = svc.check(b, mk({ tokensIn: b.maxTokens, tokensOut: 0 }));
  check("令牌（in+out 合计）达上限 → 拒绝", rTok.ok === false);
  check("  超限项为 max_tokens", rTok.kind === "max_tokens");
  const rTok2 = svc.check(b, mk({ tokensIn: b.maxTokens / 2, tokensOut: b.maxTokens / 2 }));
  check("  令牌按 in+out 合计计算（各半也触发）", rTok2.ok === false);

  const rWall = svc.check(b, mk({ startedAt: new Date(Date.now() - b.wallClockMs - 1000) }));
  check("墙钟超时 → 拒绝", rWall.ok === false);
  check("  超限项为 wall_clock", rWall.kind === "wall_clock");

  const rCalls = svc.check(b, mk({ toolCalls: b.maxToolCalls }));
  check("工具调用数达上限 → 拒绝", rCalls.ok === false);
  check("  超限项为 max_tool_calls", rCalls.kind === "max_tool_calls");

  // 判定顺序固定（steps 优先）——保证同一份用量总是同一 kind
  const both = svc.check(b, mk({ steps: b.maxSteps, toolCalls: b.maxToolCalls }));
  check("多项同时超限时判定顺序稳定（steps 优先）", both.kind === "max_steps");

  // budget=null 时回落默认（防御：历史会话可能没有 budgetJson）
  check("budget=null 回落默认预算", svc.check(null, mk()).ok === true);
  check("budget=null 且用量超默认 → 仍拒绝", svc.check(null, mk({ steps: DEFAULT_BUDGET.maxSteps })).ok === false);
}
{
  // 配置覆盖
  const svc = new AgentBudgetService({ get: (k) => (k === "agent.budget.maxSteps" ? 5 : undefined) });
  const b = svc.resolveBudget();
  check("配置可覆盖 maxSteps", b.maxSteps === 5);
  check("未配置项保持默认", b.maxTokens === DEFAULT_BUDGET.maxTokens);
}
{
  // 脏配置回落（非数字/负数不得让闸门失效——那样 Agent 就无限制了）
  const svc = new AgentBudgetService({ get: () => "abc" });
  const b = svc.resolveBudget();
  check("脏配置回落默认（闸门不失效）", b.maxSteps === DEFAULT_BUDGET.maxSteps);
  const svc2 = new AgentBudgetService({ get: () => -1 });
  check("负配置回落默认", svc2.resolveBudget().maxSteps === DEFAULT_BUDGET.maxSteps);
}

// ═══ 2. 推理循环 ══════════════════════════════════════════════════
console.log("\n── 2. 推理循环 ──");

/** 造一个内存版 AgentSessionService（复刻真实语义：可重入重建 messages）。 */
function makeSessionService() {
  const sessions = new Map();
  const steps = new Map();
  /** S7-G1：事件日志替身（见 tryAppendEvent 的注释）。 */
  const events = new Map();
  const toolCalls = [];

  return {
    _sessions: sessions,
    _steps: steps,
    _toolCalls: toolCalls,

    async create(input) {
      const id = `sess-${sessions.size + 1}`;
      const s = {
        id,
        kind: input.kind,
        status: "pending",
        title: input.title ?? null,
        triggerSource: input.triggerSource,
        parentSessionId: input.parentSessionId ?? null,
        contextJson: input.context ?? null,
        scopeJson: input.scope ?? {},
        budgetJson: input.budget ?? DEFAULT_BUDGET,
        totalSteps: 0, totalTokensIn: 0, totalTokensOut: 0, totalToolCalls: 0,
        startedAt: null, finishedAt: null, summary: null, errorMessage: null,
        resultJson: null, waitingFor: null,
      };
      sessions.set(id, s);
      steps.set(id, []);
      return s;
    },
    async findById(id) { return sessions.get(id) ?? null; },
    async requireById(id) {
      const s = sessions.get(id);
      if (!s) throw new Error(`not found: ${id}`);
      return s;
    },
    // GAP-1 契约：返回「是否赢得执行凭据」。替身必须保真（ADR-027）——
    // 旧版返回 undefined 会被生产 run() 当成 CAS 输家，整个 harness 静默让位。
    async markRunning(id) {
      const s = sessions.get(id);
      const terminal = ["succeeded", "failed", "aborted", "budget_exceeded"];
      if (s.status === "running" || terminal.includes(s.status)) return false;
      s.status = "running";
      if (!s.startedAt) s.startedAt = new Date();
      return true;
    },
    // GAP-3：自动续跑额度（条件写语义）。harness 未装配出队口，故正常不会走到。
    async claimAutoResume(id) {
      const s = sessions.get(id);
      if (!s || s.autoResumeCount >= 1) return false;
      s.autoResumeCount = (s.autoResumeCount ?? 0) + 1;
      return true;
    },
    // GAP-6：终态重开（只认 failed/budget_exceeded）。
    async reopenForResume(id) {
      const s = sessions.get(id);
      if (!s || !["failed", "budget_exceeded"].includes(s.status)) return false;
      s.status = "pending";
      s.waitingFor = null;
      // RT-2：人工恢复给新的墙钟窗口（成本闸门仍累计）
      s.startedAt = new Date();
      s.finishedAt = null;
      return true;
    },
    async markWaiting(id, w) { const s = sessions.get(id); s.status = "waiting_input"; s.waitingFor = w; },
    async finish(id, status, opts = {}) {
      const s = sessions.get(id);
      if (["succeeded", "failed", "aborted", "budget_exceeded"].includes(s.status)) return;
      s.status = status;
      s.finishedAt = new Date();
      if (opts.summary) s.summary = opts.summary;
      if (opts.errorMessage) s.errorMessage = opts.errorMessage;
      if (opts.result) s.resultJson = opts.result;
    },
    async appendStep(sessionId, input) {
      const s = sessions.get(sessionId);
      const arr = steps.get(sessionId);
      const step = {
        id: `step-${arr.length + 1}`,
        sessionId, seq: arr.length + 1, ...input,
        tokensIn: input.tokensIn ?? 0, tokensOut: input.tokensOut ?? 0,
      };
      arr.push(step);
      s.totalSteps += 1;
      s.totalTokensIn += input.tokensIn ?? 0;
      s.totalTokensOut += input.tokensOut ?? 0;
      return step;
    },
    /**
     * S7-G1：事件日志旁路（`agent_events`）。
     *
     * 替身必须**保真**（ADR-027）：生产契约是「**永不抛出**，失败返回 null」——
     * 若这里写成抛错/不存在，run() 里的 `tryAppendEvent(...)` 会在真实调用时崩，
     * 而本 harness 测的就不是生产语义了。
     * 2026-11-01 实测踩到：G1 加了这个方法，但替身没跟上 ⇒ CI 的 selftests job
     * 报 `this.sessionService.tryAppendEvent is not a function`（生产有、替身无）。
     * 这里只累加到内存数组，供断言「provider 调用前已落指纹」。
     */
    async tryAppendEvent(sessionId, event) {
      const arr = events.get(sessionId) ?? [];
      arr.push({ seq: arr.length + 1, ...event });
      events.set(sessionId, arr);
      return arr.length;
    },
    /**
     * S2-A2：折叠账本 + 连续不收敛计数（`agent_sessions.contextFoldStreak` /
     * `contextFoldLedger`）。
     *
     * 保真要点（ADR-027，与 tryAppendEvent 同型）：生产契约是
     *   · `streak` 非有限数或 ≤0 ⇒ 归零（`Math.trunc` 截断）；
     *   · `entry` 为空 ⇒ **清零路径**（绝大多数轮次），且生产用
     *     `WHERE id = ... AND status NOT IN (terminal)` 的条件写，命中 0 行是正常；
     *   · `entry` 非空 ⇒ 追加账本（生产有界 100 条，这里只需可断言）。
     * 2026-11-01 由 check-agent-stub-fidelity 抓到：生产 `agent-runtime.service.ts`
     * 调它两处，替身没有 —— 折叠路径一被走到就 `is not a function`（与
     * tryAppendEvent 同型事故的潜伏版）。
     */
    async recordContextFold(id, input) {
      const s = sessions.get(id);
      if (!s) return;
      const terminal = ["succeeded", "failed", "aborted", "budget_exceeded"];
      if (terminal.includes(s.status)) return;   // 条件写语义：终态不写
      const streak =
        Number.isFinite(input?.streak) && input.streak > 0
          ? Math.trunc(input.streak)
          : 0;
      const entry = input?.entry ?? null;
      if (!entry) {
        if (s.contextFoldStreak === 0) return;   // 谓词 <> 0：0→0 不写
        s.contextFoldStreak = 0;
        return;
      }
      s.contextFoldStreak = streak;
      s.contextFoldLedger = [...(s.contextFoldLedger ?? []), entry].slice(-100);
    },
    async recordToolCall(input) {
      toolCalls.push(input);
      const s = sessions.get(input.sessionId);
      s.totalToolCalls += 1;
      return input;
    },
    async listSteps(sessionId) { return steps.get(sessionId) ?? []; },
    async listToolCalls() { return toolCalls; },
    async findChildren() { return []; },
    async getUsage(session) {
      const s = sessions.get(session.id);
      return {
        steps: s.totalSteps, tokensIn: s.totalTokensIn, tokensOut: s.totalTokensOut,
        toolCalls: s.totalToolCalls, startedAt: s.startedAt,
      };
    },
  };
}

/** 造一个可编程的 AiService 桩：按脚本逐次返回。 */
function makeAi(script) {
  let i = 0;
  return {
    _calls: [],
    async chatMultimodal(req) {
      this._calls.push(req);
      const r = script[Math.min(i, script.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
    async getActiveRoute() { return { provider: "qwen", model: "qwen-vl-max" }; },
  };
}

const usage = (tIn, tOut) => ({ tokensIn: tIn, tokensOut: tOut });

{
  // 场景：模型一次给出结论（不要求工具）→ succeeded
  const ss = makeSessionService();
  const ai = makeAi([{ content: "环境正常，无需处理。", usage: usage(100, 20), model: "qwen-vl-max" }]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  const outcome = await rt.run(session.id);

  check("模型一次给结论 → succeeded", outcome.status === "succeeded");
  check("  步数为 1", outcome.steps === 1);
  const fin = await ss.findById(session.id);
  check("  会话状态落库为 succeeded", fin.status === "succeeded");
  check("  summary 取结论首行（通知用）", fin.summary === "环境正常，无需处理。");
  check("  resultJson 存完整结论", fin.resultJson?.conclusion === "环境正常，无需处理。");
  check("  令牌用量已累加", fin.totalTokensIn === 100 && fin.totalTokensOut === 20);
  check("  传了 system prompt", ai._calls[0].messages[0].role === "system");
}
{
  // 场景：模型要求调工具，但 P2 未装配工具集 → 如实告知并继续
  const ss = makeSessionService();
  const ai = makeAi([
    {
      content: "",
      usage: usage(50, 10),
      model: "qwen-vl-max",
      toolCalls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: "{}" } }],
    },
    { content: "已确认。", usage: usage(30, 5), model: "qwen-vl-max" },
  ]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  const outcome = await rt.run(session.id);

  check("工具请求 → 继续循环直到模型给结论", outcome.status === "succeeded");
  check("  共 2 步（要工具 + 给结论）", outcome.steps === 2);
  check("  未装配工具时该调用记为 denied", ss._toolCalls[0]?.status === "denied");
  check("  denied 原因如实说明", /not available/.test(ss._toolCalls[0]?.errorMessage ?? ""));
  check("  第二轮能看到工具被拒的反馈", ai._calls[1].messages.some((m) => m.role === "tool"));
}
{
  // 场景：步数预算触顶 → budget_exceeded（模型每轮都要工具）
  const ss = makeSessionService();
  const infiniteTool = {
    content: "",
    usage: usage(10, 10),
    model: "qwen-vl-max",
    toolCalls: [{ id: "c", type: "function", function: { name: "list_tasks", arguments: "{}" } }],
  };
  // 脚本给足多轮（循环应被闸门拦住，而不是靠脚本耗尽）
  const ai = makeAi(Array(50).fill(infiniteTool));
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({
    kind: "ops_watch",
    triggerSource: "test",
    budget: { maxSteps: 3, maxTokens: 1e9, wallClockMs: 1e9, maxToolCalls: 1e9 },
  });
  const outcome = await rt.run(session.id);

  check("步数预算触顶 → budget_exceeded", outcome.status === "budget_exceeded", outcome.status);
  check("  超限项为 max_steps", /最大轮次/.test(outcome.reason ?? ""), outcome.reason);
  check("  恰好跑到 maxSteps 就停（未多跑一轮）", outcome.steps === 3, `steps=${outcome.steps}`);
  const fin = await ss.findById(session.id);
  check("  会话状态落库为 budget_exceeded", fin.status === "budget_exceeded");
  // 闸门在循环开头判定：跑满 3 步后第 4 轮开头被拦
  check("  模型调用次数等于步数（未在第 4 轮发起推理）", ai._calls.length === 3, `calls=${ai._calls.length}`);
}
{
  // 场景：令牌预算触顶
  const ss = makeSessionService();
  const ai = makeAi(Array(50).fill({
    content: "",
    usage: usage(1000, 1000),
    model: "qwen-vl-max",
    toolCalls: [{ id: "c", type: "function", function: { name: "list_tasks", arguments: "{}" } }],
  }));
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({
    kind: "ops_watch", triggerSource: "test",
    budget: { maxSteps: 100, maxTokens: 3000, wallClockMs: 1e9, maxToolCalls: 1e9 },
  });
  const outcome = await rt.run(session.id);
  check("令牌预算触顶 → budget_exceeded", outcome.status === "budget_exceeded");
  check("  超限项为 max_tokens", /令牌/.test(outcome.reason ?? ""), outcome.reason);
}
{
  // 场景：模型调用抛错 → failed（不是 budget_exceeded，语义不同）
  const ss = makeSessionService();
  const ai = makeAi([new Error("upstream 502")]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  const outcome = await rt.run(session.id);

  check("模型调用失败 → failed（非 budget_exceeded）", outcome.status === "failed", outcome.status);
  const fin = await ss.findById(session.id);
  check("  失败原因落库", /upstream 502/.test(fin.errorMessage ?? ""));
  check("  失败也被记录为一步（可复盘）", fin.totalSteps === 1);
}
{
  // 场景：幂等——终态会话不重复运行
  const ss = makeSessionService();
  const ai = makeAi([{ content: "done", usage: usage(1, 1), model: "m" }]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  await rt.run(session.id);
  const callsAfterFirst = ai._calls.length;

  const second = await rt.run(session.id);
  check("终态会话重复 run 不产生新推理", ai._calls.length === callsAfterFirst, `calls=${ai._calls.length}`);
  check("  第二次 run 直接返回终态", second.status === "succeeded");
}
{
  // 场景：可重入——已有 steps 的会话 run 时从 DB 重建 messages
  const ss = makeSessionService();
  const ai = makeAi([{ content: "继续完成", usage: usage(5, 5), model: "m" }]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  // 预置历史（模拟「挂起后恢复」/「进程重启后恢复」）
  await ss.appendStep(session.id, { role: "user", content: "排查 executor-03 离线" });
  await ss.appendStep(session.id, { role: "assistant", content: "我先看执行器状态" });

  await rt.run(session.id);

  const msgs = ai._calls[0].messages;
  // system(1) + 预置的 user(1) + 预置的 assistant(1) = 3
  check("重入时重建了历史 messages", msgs.length === 3, `len=${msgs.length}`);
  check("  system prompt 在最前", msgs[0].role === "system");
  check("  历史 user 消息在", msgs.some((m) => m.role === "user" && /executor-03/.test(String(m.content))));
  check("  历史 assistant 消息在", msgs.some((m) => m.role === "assistant" && /先看执行器状态/.test(String(m.content))));
  check("  重建顺序正确（system → user → assistant）",
    msgs[0].role === "system" && msgs[1].role === "user" && msgs[2].role === "assistant",
    msgs.map((m) => m.role).join(","));
}
{
  // 场景：startedAt 只在首次置位（墙钟预算不可被 resume 续命）
  const ss = makeSessionService();
  const ai = makeAi([{ content: "x", usage: usage(1, 1), model: "m" }]);
  const rt = new AgentRuntimeService(ss, new AgentBudgetService({ get: () => undefined }), ai);

  const session = await ss.create({ kind: "ops_watch", triggerSource: "test" });
  await rt.run(session.id);
  const firstStartedAt = (await ss.findById(session.id)).startedAt;

  // 人为重置为 running 再跑一次（模拟 resume）
  const s = await ss.findById(session.id);
  s.status = "running";
  await rt.run(session.id);
  const secondStartedAt = (await ss.findById(session.id)).startedAt;

  check("resume 不重置 startedAt（墙钟预算不可续命）",
    firstStartedAt.getTime() === secondStartedAt.getTime());
}

// ═══ 3. 指标埋点 ══════════════════════════════════════════════════
// 注意 harness 边界：本节用**打桩的** AgentSessionService 跑循环，因此
// 真正由 AgentSessionService 发出的埋点（sessions/tokens/tool_calls）不会
// 出现在 recorded 里——那是桩替身导致的，不是实现缺失。
// 故分两部分断言：
//   ① 运行时捕获：真实跑到的 AgentBudgetService 埋点；
//   ② 结构断言：AgentSessionService 的埋点代码确实在位（防被删/被绕过）。
console.log("\n── 3. 指标埋点 ──");
{
  // ① 运行时捕获
  const names = recorded.map((r) => r.name);
  check("预算触顶指标已埋点（运行时捕获）", names.includes("autoflow_agent_budget_exceeded_total"));
  const budgetEv = recorded.find((r) => r.name === "autoflow_agent_budget_exceeded_total");
  check("  带 reason 标签", typeof budgetEv?.labels?.reason === "string", JSON.stringify(budgetEv?.labels));
}

// ② 结构断言（纯源码文本）+ §4 队列隔离
// 见 `checkSourceTextGroups()` 头注：这两组是**纯文本**判据 ⇒ 同一份函数也能在
// `--selftest` 的夹具树上跑（自检测的是**判据本身**，不是抄一份）。
checkSourceTextGroups(root);

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部运行时断言通过 ===\n");
process.exit(failures ? 1 : 0);
