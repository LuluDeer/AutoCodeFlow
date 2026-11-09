#!/usr/bin/env node
/**
 * P4（agent-and-deployment）触发器验证 —— 核心验收点是**事件风暴合成**。
 *
 * 设计文档 02 §5.2 的关键断言：
 *   47 次执行失败 → 只产生 **1 个** incident 会话（不是 47 个）
 *
 * 只测「能触发」会退化成永真断言，所以本脚本同时断言：
 *   · 阈值未达 → 不触发
 *   · 达阈值 → 触发一次
 *   · 同窗口后续事件 → **不重复触发**
 *   · 窗口过后 → 可再次触发（不能被永久静默）
 *   · 非白名单事件 → 永不触发
 *   · 多副本 leader 门禁 → 非 leader 不建会话
 *   · 事件路径 fail-open（抛错不冒泡）
 *
 * 用法:
 *   node scripts/agent-trigger-check.mjs              # 主跑（需 admin-api 依赖）
 *   node scripts/agent-trigger-check.mjs --selftest   # 判据自检（零依赖，夹具内跑）
 *
 * ## R160：为什么有 `--selftest` 形态
 *
 * 判据③（`scripts/check-guards-wired.mjs`）要求「有自检的守卫，其自检必须被**本地
 * 与 CI 两面**真的执行到」。本守卫此前**没有** `--selftest` 形态 ⇒ 它的判据本体
 * 在任何一面上都没有「自检」可跑。
 *
 * 核事实结论：**判据本体没有被任何 jest spec 完全覆盖**（`agent-event-aggregator.
 * service.spec.ts` / `agent-trigger.service.spec.ts` 覆盖了行为面的大头，但
 * 「模块装配」「configuration/Joi 三处同步」「.env.example 同步」「触发器服务
 * 静态断言」「通知接线结构」这几组**零覆盖**）⇒ 不能用 `covered-elsewhere` 豁免。
 *
 * ## 自检的边界（**如实写明，不要读成「全判据都被自检覆盖」**）
 *
 * 主跑有两类断言：
 *   ① **需要转译 + 运行**的（聚合器行为、通知服务行为）⇒ 需要 admin-api 的
 *      typescript / reflect-metadata / @nestjs ⇒ **夹具里跑不了**（夹具刻意不含
 *      真仓库源码与 node_modules）；
 *   ② **纯源码文本**的（触发器服务静态断言、模块装配、三处配置同步、通知接线
 *      结构）⇒ 只 `readFileSync` 读源码做正则匹配 ⇒ **可在夹具里真跑**。
 *
 * ⇒ 本 `--selftest` 覆盖的是**第 ② 类**（判定「判据本体还在」的那部分），
 * 第 ① 类由 admin-api 的 jest spec 覆盖 + CI 的 `npm run test:agent` 主跑覆盖。
 * 这是「能证多少证多少」，**不是**「全部断言都有自检」。
 *
 * ## 为什么自检必须能跑在**夹具**上
 *
 * 判据③ 的本地面是零依赖的 `test:guards`（不装 admin-api 的 node_modules）。
 * 若自检需要真仓库的 admin-api 源码与依赖，它就**永远接不进本地面** ⇒ 只能
 * 「一面接线」（CI 的 admin-api job）——但那样本地就没有任何「判据还在吗」的
 * 信号。⇒ 自检必须**自带夹具**（`makeFixtureRepo`），且**夹具里不含真仓库的
 * admin-api 源码**：源码是夹具自造的最小副本，被测的是**判据本身**（正则是否
 * 还能识别出正确的形态、以及**错误形态必须被识别出来**）。
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

/**
 * `--root <dir>`：以 <dir> 为仓库根（**只给 selftest**：把夹具树当仓库根扫）。
 *
 * 为什么需要它：第 ② 类断言（纯源码文本）读的是 `apps/admin-api/src/...` 与
 * `packages/mcp-server/src/...` 的**相对路径** ⇒ 换根目录就能在夹具树上跑。
 */
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

// ── selftest（零依赖：夹具树 + 真子进程）────────────────────────────────
//
// ## 夹具为什么**不含**真仓库的 admin-api 源码
//
// 被测的是**判据本身**（正则还能不能识别出正确形态、错误形态会不会被漏掉），
// 不是 admin-api 的源码。所以夹具自造**最小副本**：形态对、规模小、不含真源码。
// ⇒ ① 夹具不含真仓库源码 ⇒ 自检不依赖 admin-api 的任何依赖 ⇒ 能进零依赖的
// `test:guards` 本地面；② 夹具形态与真源码一致 ⇒ 判据在夹具上红 ⇒ 真源码上也会红。
//
// ## 每条反例都配一条正例控制组
//
// 否则「expectExit 永远抛」也能让全部负例通过（harness 头注里点名的失效模式）。

/** 夹具：一份**形态正确**的最小 admin-api 源码副本（正例控制组用）。 */
const FIXTURE_OK = {
  "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts": [
    '@Cron("0 5 * * * *")',
    "async scheduledWatch() {",
    "  if (!this.scheduler.getStats().isLeader()) {",
    "    // not the scheduler leader",
    "    return;",
    "  }",
    "}",
    "onModuleInit() {",
    "  this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.h);",
    "  this.bus.on(DOMAIN_EVENTS.EXECUTOR_OFFLINE, this.h);",
    "}",
    "onModuleDestroy() {",
    "  this.bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, this.h);",
    "}",
    "class AgentTriggerService implements OnModuleDestroy {",
    "// fail-open：事件路径不冒泡",
    "scope: this.buildEventScope(ev, key, payload),",
    "scope: {},",
    "this.aggregator.observe(type, key, payload, thresholdOverride,",
    ");",
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/agent/agent.module.ts": [
    "imports: [SchedulerModule]",
    "providers: [AgentTriggerService, AgentEventAggregator, AgentNotifyService,]",
    "",
  ].join("\n"),
  "apps/admin-api/src/config/configuration.ts": [
    "agent: {",
    "  trigger: { windowMs: 300000, threshold: 3 },",
    "  notify: { enabled: process.env.AGENT_NOTIFY_ENABLED },",
    "}",
    "",
  ].join("\n"),
  "apps/admin-api/src/app.module.ts": [
    "AGENT_TRIGGER_WINDOW_MS: Joi.number(),",
    "AGENT_TRIGGER_THRESHOLD: Joi.number(),",
    "AGENT_NOTIFY_ENABLED: Joi.boolean(),",
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts": [
    "await this.notify.sessionFinished({ ...session });",
    "summary: redactNullableText(options.summary ?? session.summary),",
    "",
  ].join("\n"),
  "apps/admin-api/src/modules/agent/tools/tool-executor.service.ts": [
    "this.notify.approvalRequested(session, tool, id, msg);",
    "",
  ].join("\n"),
  ".env.example": [
    "AGENT_BUDGET_MAX_STEPS=40",
    "AGENT_TRIGGER_WINDOW_MS=300000",
    "AGENT_TRIGGER_THRESHOLD=3",
    "AGENT_NOTIFY_ENABLED=true",
    "",
  ].join("\n"),
  "apps/admin-api/.env.example": [
    "AGENT_BUDGET_MAX_STEPS=40",
    "AGENT_TRIGGER_WINDOW_MS=300000",
    "AGENT_TRIGGER_THRESHOLD=3",
    "AGENT_NOTIFY_ENABLED=true",
    "",
  ].join("\n"),
};

/** 夹具：把某个文件的内容替换掉（用于制造「该红」的形态）。 */
function fixtureWith(rel, content) {
  return { ...FIXTURE_OK, [rel]: content };
}

function runSelftest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  /** 在夹具树上跑本脚本的 `--root` 形态（真子进程，跑真判据）。 */
  const runOn = (files) => {
    const repo = makeFixtureRepo(files, { prefix: "agent-trigger-selftest-" });
    const result = runGuard(SELF, { args: ["--root", repo.dir] });
    return { result, cleanup: repo.cleanup };
  };

  // ① 正例控制组：形态正确 ⇒ 全绿（否则「expectExit 永远红」也能让下面全过）
  add("① 正例控制组：形态正确的夹具 ⇒ 全绿（0 失败）", () => {
    const { result, cleanup } = runOn(FIXTURE_OK);
    try {
      expectExit(result, {
        code: 0,
        contains: ["全部触发器断言通过"],
        absent: ["✘"],
        label: "控制组",
      });
    } finally {
      cleanup();
    }
  });

  // ② 反证：退订配对被删（只有 on、没有 off）⇒ 必须红
  add("② 反证：退订配对被删（无 bus.off）⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
        "onModuleInit() { this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.h); }\n",
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["退订配对"], label: "退订配对" });
    } finally {
      cleanup();
    }
  });

  // ③ 反证：leader 门禁被删 ⇒ 必须红（多副本重复触发的防线没了）
  add("③ 反证：leader 门禁被删 ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
        "async scheduledWatch() { return; }\n",
      ),
    );
    try {
      expectExit(result, {
        code: 1,
        contains: ["定时触发有 leader 门禁"],
        label: "leader 门禁",
      });
    } finally {
      cleanup();
    }
  });

  // ④ 反证：事件路径退回硬编码空 scope（SCOPE-BIND 回退）⇒ 必须红
  add("④ 反证：事件路径硬编码 scope: {} ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
        "scope: {},\n",
      ),
    );
    try {
      expectExit(result, {
        code: 1,
        contains: ["事件触发的会话走 buildEventScope"],
        label: "事件 scope",
      });
    } finally {
      cleanup();
    }
  });

  // ⑤ 反证：阈值覆盖的 config 篡改 hack 回来了 ⇒ 必须红
  add("⑤ 反证：observeWithThreshold hack 回来 ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
        "this.aggregator.observeWithThreshold(type, key, payload);\n",
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["已移除 config 篡改 hack"], label: "config hack" });
    } finally {
      cleanup();
    }
  });

  // ⑥ 反证：Joi 漏注册 AGENT_TRIGGER_THRESHOLD ⇒ 必须红（三处同步纪律）
  add("⑥ 反证：Joi 漏注册 AGENT_TRIGGER_THRESHOLD ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/app.module.ts",
        "AGENT_TRIGGER_WINDOW_MS: Joi.number(),\nAGENT_NOTIFY_ENABLED: Joi.boolean(),\n",
      ),
    );
    try {
      expectExit(result, {
        code: 1,
        contains: ["Joi 注册 AGENT_TRIGGER_THRESHOLD"],
        label: "Joi 同步",
      });
    } finally {
      cleanup();
    }
  });

  // ⑦ 反证：.env.example 漏文档化 AGENT_NOTIFY_ENABLED ⇒ 必须红
  add("⑦ 反证：.env.example 漏 AGENT_NOTIFY_ENABLED ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(".env.example", "AGENT_BUDGET_MAX_STEPS=40\nAGENT_TRIGGER_WINDOW_MS=300000\n"),
    );
    try {
      expectExit(result, {
        code: 1,
        contains: [".env.example 文档化 AGENT_NOTIFY_ENABLED"],
        label: ".env.example 同步",
      });
    } finally {
      cleanup();
    }
  });

  // ⑧ 反证：模块漏注册 AgentTriggerService ⇒ 必须红
  add("⑧ 反证：模块漏注册 AgentTriggerService ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/agent.module.ts",
        "providers: [AgentEventAggregator]\n",
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["注册 AgentTriggerService"], label: "模块装配" });
    } finally {
      cleanup();
    }
  });

  // ⑨ 反证：Cron 频率被改成分钟级 ⇒ 必须红（巡检不该过密）
  add("⑨ 反证：Cron 改成分钟级 ⇒ 红", () => {
    const { result, cleanup } = runOn(
      fixtureWith(
        "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
        "@Cron(\"0 */10 * * * *\")\n",
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["定时巡检为每小时"], label: "Cron 频率" });
    } finally {
      cleanup();
    }
  });

  const failed = reportCases(cases, { title: "agent-trigger-check selftest" });
  return failed > 0 ? 1 : 0;
}

// ── 入口分派（**必须在任何依赖 require 之前**）────────────────────────
//
// 为什么要分派在前：`require("typescript")` / `require("reflect-metadata")` 需要
// `apps/admin-api/node_modules`，而 `--selftest` 的夹具树**刻意没有**它 ⇒
// 若分派写在依赖之后，夹具跑自检会在 require 处直接崩（正是本仓反复踩的
// 「崩了 vs 零用例」混淆形态）。
//
// 三种形态：
//   · `--selftest`         → 跑自检（自己造夹具、自己跑子进程）
//   · `--root <dir>`       → **只跑第 ② 类（纯文本）判据**，以 <dir> 为仓库根。
//                            夹具自检靠它：同一份 `checkSourceTextGroups()` 在夹具
//                            树上真跑（不是抄一份判据）。
//   · （无参数）            → 主跑：第 ① 类（转译+运行）+ 第 ② 类，全量。
if (argv.includes("--selftest")) {
  // 依赖 require 之前先分派（见上）。自检与主跑**同文件** ⇒ 不必新增伴生文件
  // （本文件已登记为「无 export 的可执行 CLI」，加 export 会踩 main-guard）。
  process.exit(runSelftest());
}

if (argv.includes("--root")) {
  const rootDir = argRoot(argv);
  console.log(`\n=== P4 触发器验证（纯文本判据面，根 = ${rootDir}）===\n`);
  checkSourceTextGroups(rootDir);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部触发器断言通过 ===\n");
  process.exit(failures ? 1 : 0);
}

// ── 转译 ──────────────────────────────────────────────────────────
require("reflect-metadata");
const ts = require("typescript");
const scratch = join(apiDir, ".trigger-check");
mkdirSync(scratch, { recursive: true });
const transpiled = new Set();
function transpileOne(relPath) {
  const src = readFileSync(join(apiDir, relPath), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
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

let aggMod;
try {
  transpileGraph("src/modules/agent/trigger/agent-event-aggregator.service.ts");
  aggMod = require(join(scratch, "src/modules/agent/trigger/agent-event-aggregator.service.js"));
} catch (err) {
  console.error(`\n[FATAL] 转译失败: ${err.message}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const { AgentEventAggregator } = aggMod;

function makeAgg(values = {}) {
  return new AgentEventAggregator({ get: (k) => values[k] });
}

/**
 * 第 ② 类断言：**纯源码文本**的那几组（触发器服务静态断言 / 模块装配 /
 * 三处配置同步 / 通知接线结构）。
 *
 * 抽成函数并以 `rootDir` 为参数 ⇒ **同一份判据**既能被主跑在真仓库上跑，也能被
 * `--selftest` 在夹具树上跑（这是「自检测的是判据、不是抄一份判据」的关键：
 * 两处共用同一个函数 ⇒ 抄一份副本的漂移形态被排除）。
 *
 * @param {string} rootDir 仓库根（主跑 = 真仓库；自检 = 夹具树）
 * @returns {number} 本组失败条数（走全局 failures 计数）
 */
function checkSourceTextGroups(rootDir) {
  const api = join(rootDir, "apps/admin-api");

  // ═══ 10. 触发器服务静态断言 ═══════════════════════════════════════
  console.log("\n── 10. 触发器服务（静态）──");
  {
    const src = readFileSync(join(api, "src/modules/agent/trigger/agent-trigger.service.ts"), "utf8");

    check("订阅了 execution.failed", /bus\.on\(DOMAIN_EVENTS\.EXECUTION_FAILED/.test(src));
    check("订阅了 executor.offline", /bus\.on\(DOMAIN_EVENTS\.EXECUTOR_OFFLINE/.test(src));
    check("退订配对（OnModuleDestroy）", /OnModuleDestroy/.test(src) && /bus\.off\(/.test(src));

    // ★ 多副本 leader 门禁——这是 P4 最容易漏的
    check("定时触发有 leader 门禁", /isLeader\(\)/.test(src));
    check("非 leader 时跳过建会话", /not the scheduler leader/.test(src));
    check("复用 SchedulerService.getStats().isLeader（不另造选举）", /scheduler\.getStats\(\)\.isLeader/.test(src));

    // 事件路径 fail-open
    check("事件路径 fail-open（不冒泡影响主链）", /fail-open/.test(src));

    // 自动触发的会话作用域保守（空 scope = 不可操作任何资源）
    // ⚠️ R160：**这条判据在 SCOPE-BIND（2026-10-27 审计轮 #11 / A2）之后已经失真**。
    // 实现早已改成 `scope: this.buildEventScope(...)`（事件路径）与 `scope: {}`
    // （**cron 巡检**路径，见 agent-trigger.service.ts:514）⇒ 字面量 `scope: {}`
    // 命中的是 cron 路径，不是「事件触发的会话」。真正的「事件会话 scope 保守」
    // 由 `buildEventScope` 的**识别不出就返回空**那条保证（jest spec 已覆盖）。
    // ⇒ 这里改成**分别断言两条路径**（事件路径必须走 buildEventScope；cron 巡检
    // 路径才允许空 scope），不再用一条含混的字面量断言冒充两者。
    check("事件触发的会话走 buildEventScope（不是硬编码空 scope）", /scope: this\.buildEventScope\(/.test(src));
    check("cron 巡检会话用空 scope（自动触发不该有写权限）", /scope: \{\},/.test(src));

    // 定时频率不过密
    check("定时巡检为每小时（非分钟级）", /@Cron\("0 5 \* \* \* \*"\)/.test(src));

    // 阈值覆盖传参正确（不应再有 config 篡改的 hack）
    check("聚合调用传阈值覆盖参数", /thresholdOverride,\s*\n\s*\);/.test(src));
    check("已移除 config 篡改 hack", !/observeWithThreshold/.test(src));
  }

  // ═══ 11. 模块装配 ═════════════════════════════════════════════════
  console.log("\n── 11. 模块装配 ──");
  {
    const mod = readFileSync(join(api, "src/modules/agent/agent.module.ts"), "utf8");
    check("引入 SchedulerModule", /SchedulerModule/.test(mod));
    check("注册 AgentTriggerService", /AgentTriggerService,/.test(mod));
    check("注册 AgentEventAggregator", /AgentEventAggregator,/.test(mod));

    const cfg = readFileSync(join(api, "src/config/configuration.ts"), "utf8");
    check("configuration 有 agent.trigger 段", /trigger: \{/.test(cfg));
    check("配置含 windowMs", /windowMs:/.test(cfg));
    check("配置含 threshold", /threshold:/.test(cfg));

    const app = readFileSync(join(api, "src/app.module.ts"), "utf8");
    check("Joi 注册 AGENT_TRIGGER_WINDOW_MS", /AGENT_TRIGGER_WINDOW_MS:/.test(app));
    check("Joi 注册 AGENT_TRIGGER_THRESHOLD", /AGENT_TRIGGER_THRESHOLD:/.test(app));
  }

  // ═══ 12b. 通知接线结构（纯文本部分）══════════════════════════════
  // ⚠️ 与 §12 的**行为**部分（转译 + 打桩运行）分开：这里只断言「接线在不在」，
  // 那是纯文本 ⇒ 可在夹具里跑；行为面留给主跑与 jest spec。
  console.log("\n── 12b. 通知接线（静态）──");
  {
    const ssSrc = readFileSync(join(api, "src/modules/agent/runtime/agent-session.service.ts"), "utf8");
    check("finish() 落库后调 sessionFinished（终态唯一收敛点）", /await this\.notify\.sessionFinished\(\{\s*\.\.\.session/.test(ssSrc));
    // 2026-11-02：判据从「字面匹配三行」改为**语义断言**。
    // 原因：`finish()` 的这三列现在都过脱敏（`redactNullableText(...)`，候选 N10 的会话行脱敏），
    //   旧正则要求的是**裸** `options.summary ?? session.summary` ⇒ 失配。
    // 但这条判据的**语义**没变：「传更新后的快照，而不是旧值」——
    //   即 `options.summary ?? session.summary` 这个**回退表达式**必须还在。
    // ⇒ 验「回退表达式在」+「它被包在 finish 的写入里」，而不是验三行的字面形状。
    // （本会话反复的教训：**格式断言不是语义断言**。）
    check(
      "  传更新后的快照（新 summary 而非旧值）",
      /summary:\s*[^,\n]*options\.summary\s*\?\?\s*session\.summary/.test(ssSrc),
    );

    const teSrc = readFileSync(join(api, "src/modules/agent/tools/tool-executor.service.ts"), "utf8");
    check("审批请求推送通知（P3 遗留项已兑现）", /this\.notify\.approvalRequested\(/.test(teSrc));

    const modN = readFileSync(join(api, "src/modules/agent/agent.module.ts"), "utf8");
    check("模块注册 AgentNotifyService", /AgentNotifyService,/.test(modN));

    const cfgN = readFileSync(join(api, "src/config/configuration.ts"), "utf8");
    check("configuration 有 agent.notify 段", /notify: \{\s*enabled: process\.env\.AGENT_NOTIFY_ENABLED/.test(cfgN));

    const appN = readFileSync(join(api, "src/app.module.ts"), "utf8");
    check("Joi 注册 AGENT_NOTIFY_ENABLED", /AGENT_NOTIFY_ENABLED:/.test(appN));

    // .env.example 同步（agent.* 配置的三处同步纪律之一，P2 起曾漏）
    for (const f of [".env.example", "apps/admin-api/.env.example"]) {
      const env = readFileSync(join(rootDir, f), "utf8");
      check(`${f} 文档化 AGENT_BUDGET_*`, /AGENT_BUDGET_MAX_STEPS=/.test(env));
      check(`${f} 文档化 AGENT_TRIGGER_*`, /AGENT_TRIGGER_WINDOW_MS=/.test(env) && /AGENT_TRIGGER_THRESHOLD=/.test(env));
      check(`${f} 文档化 AGENT_NOTIFY_ENABLED`, /AGENT_NOTIFY_ENABLED=/.test(env));
    }
  }
}

console.log("\n=== P4 触发器验证（风暴合成）===\n");

// ═══ 1. 默认参数 ══════════════════════════════════════════════════
console.log("── 1. 默认参数 ──");
{
  const agg = makeAgg();
  check("默认窗口 5 分钟", agg.resolveWindowMs() === 300000, `${agg.resolveWindowMs()}`);
  check("默认阈值 3", agg.resolveThreshold() === 3, `${agg.resolveThreshold()}`);
  check("配置可覆盖窗口", makeAgg({ "agent.trigger.windowMs": 60000 }).resolveWindowMs() === 60000);
  check("配置可覆盖阈值", makeAgg({ "agent.trigger.threshold": 7 }).resolveThreshold() === 7);
  // 脏配置回落（阈值脏 → 不能变成 0 而让每次事件都触发）
  check("脏阈值回落默认（防每次都触发）", makeAgg({ "agent.trigger.threshold": "abc" }).resolveThreshold() === 3);
  check("负阈值回落默认", makeAgg({ "agent.trigger.threshold": -1 }).resolveThreshold() === 3);
}

// ═══ 2. 核心：事件风暴合成 ════════════════════════════════════════
console.log("\n── 2. 事件风暴合成（核心验收）──");
{
  const agg = makeAgg();  // 阈值 3
  let fired = [];
  for (let i = 0; i < 47; i++) {
    const v = agg.observe("execution.failed", "executor-03", { i });
    if (v.action === "fire") fired.push(v.trigger);
  }
  check("47 条事件只触发 1 次", fired.length === 1, `fired=${fired.length}`);
  check("  触发时计数为 3（达阈值即触发，不等满窗口）", fired[0]?.count === 3, `count=${fired[0]?.count}`);
  check("  触发携带资源键", fired[0]?.resourceKey === "executor-03");
  check("  触发携带事件类型", fired[0]?.eventType === "execution.failed");
  check("  触发携带样例（供 Agent 看上下文）", Array.isArray(fired[0]?.samples) && fired[0].samples.length > 0);
  check("  样例最多 5 条（防内存增长）", fired[0]?.samples.length <= 5, `${fired[0]?.samples.length}`);
}

// ═══ 3. 阈值未达不触发 ════════════════════════════════════════════
console.log("\n── 3. 阈值未达 ──");
{
  const agg = makeAgg();
  const v1 = agg.observe("execution.failed", "t1", {});
  check("第 1 条 → accumulate", v1.action === "accumulate", v1.action);
  check("  返回当前计数", v1.action === "accumulate" && v1.count === 1);
  const v2 = agg.observe("execution.failed", "t1", {});
  check("第 2 条 → accumulate（仍未触发）", v2.action === "accumulate" && v2.count === 2);
  const v3 = agg.observe("execution.failed", "t1", {});
  check("第 3 条 → fire（达阈值）", v3.action === "fire", v3.action);
}

// ═══ 4. 同窗口不重复触发 ══════════════════════════════════════════
console.log("\n── 4. 同窗口不重复触发 ──");
{
  const agg = makeAgg({ "agent.trigger.threshold": 2 });
  agg.observe("execution.failed", "t1", {});
  const fire = agg.observe("execution.failed", "t1", {});
  check("阈值 2 → 第 2 条触发", fire.action === "fire");

  // 继续灌 20 条：绝不能再触发
  let more = 0;
  for (let i = 0; i < 20; i++) {
    if (agg.observe("execution.failed", "t1", {}).action === "fire") more++;
  }
  check("同窗口后续 20 条不再触发（每个窗口只一次）", more === 0, `more=${more}`);
}

// ═══ 5. 不同资源各自独立 ══════════════════════════════════════════
console.log("\n── 5. 资源维度隔离 ──");
{
  const agg = makeAgg({ "agent.trigger.threshold": 2 });
  // 两个不同执行器各自失败
  agg.observe("execution.failed", "exec-A", {});
  const a = agg.observe("execution.failed", "exec-A", {});
  agg.observe("execution.failed", "exec-B", {});
  const b = agg.observe("execution.failed", "exec-B", {});
  check("exec-A 达阈值触发", a.action === "fire");
  check("exec-B 独立计数也触发", b.action === "fire");
  check("两者是不同的桶", a.trigger.resourceKey !== b.trigger.resourceKey);

  // 不同事件类型也隔离
  const agg2 = makeAgg({ "agent.trigger.threshold": 2 });
  agg2.observe("execution.failed", "x", {});
  agg2.observe("execution.killed", "x", {});
  check("不同事件类型不互相累计", agg2.observe("execution.failed", "x", {}).action === "fire");
}

// ═══ 6. 窗口过期后可再触发 ════════════════════════════════════════
console.log("\n── 6. 窗口过期（不能被永久静默）──");
{
  // 用极小窗口模拟过期
  const agg = makeAgg({ "agent.trigger.threshold": 1, "agent.trigger.windowMs": 1 });
  const v1 = agg.observe("execution.failed", "t1", {});
  check("阈值 1 → 立即触发", v1.action === "fire", v1.action);
  // drain（模拟触发后的收尾）
  agg.drain("execution.failed", "t1");
  // 下一次观察：因为窗口 1ms 已过，应能再触发
  const v2 = agg.observe("execution.failed", "t1", {});
  check("drain + 新窗口后可再次触发", v2.action === "fire", v2.action);
}

// ═══ 7. 白名单过滤 ════════════════════════════════════════════════
console.log("\n── 7. 白名单过滤 ──");
{
  const agg = makeAgg({ "agent.trigger.threshold": 1 });
  // 非白名单事件永不被触发（避免 Agent 被无关事件唤醒）
  for (const ev of ["execution.completed", "executor.online", "user.created", "task.updated"]) {
    const v = agg.observe(ev, "x", {});
    check(`非白名单事件 ${ev} → ignored`, v.action === "ignored", v.action);
  }
  // 灌 100 条也不触发
  let fired = 0;
  for (let i = 0; i < 100; i++) {
    if (agg.observe("execution.completed", "x", {}).action === "fire") fired++;
  }
  check("100 条非白名单事件仍不触发", fired === 0);

  // 白名单内事件确实可触发
  for (const ev of ["execution.failed", "execution.killed", "executor.offline", "deployment.completed"]) {
    const v = makeAgg({ "agent.trigger.threshold": 1 }).observe(ev, "x", {});
    check(`白名单事件 ${ev} 可触发`, v.action === "fire", v.action);
  }
}

// ═══ 8. 阈值覆盖（离线单次即重要）═════════════════════════════════
console.log("\n── 8. 阈值覆盖 ──");
{
  const agg = makeAgg();  // 默认阈值 3
  // 默认阈值下离线事件要 3 条才触发
  check("默认阈值下离线第 1 条不触发", agg.observe("executor.offline", "e1", {}).action !== "fire");
  // 覆盖为 1 → 单次即触发（设计：执行器离线单次就值得关注）
  const v = agg.observe("executor.offline", "e2", {}, 1);
  check("阈值覆盖为 1 → 离线单次即触发", v.action === "fire", v.action);
  // 覆盖为 0 视为无效，回落默认
  check("覆盖为 0 无效（回落默认 3）", agg.observe("executor.offline", "e3", {}, 0).action !== "fire");
}

// ═══ 9. 清理与内存 ════════════════════════════════════════════════
console.log("\n── 9. 清理（防内存泄漏）──");
{
  // 注意：sweep 的判据是 `now - windowStart >= windowMs`，而三次 observe
  // 与 sweep 若发生在**同一毫秒**内，差值恒为 0 —— 窗口再小也不过期。
  // 故这里必须真实等待越过窗口（await sleep），否则是测试自身的时序假象。
  const agg = makeAgg({ "agent.trigger.windowMs": 5 });
  agg.observe("execution.failed", "a", {});
  agg.observe("execution.failed", "b", {});
  agg.observe("execution.failed", "c", {});
  check("桶按资源增长", agg.bucketCount() === 3, `${agg.bucketCount()}`);

  const removedBeforeWait = agg.sweep();
  check("未过窗口时不清（0 条，符合判据）", removedBeforeWait === 0, `removed=${removedBeforeWait}`);

  await new Promise((r) => setTimeout(r, 10));
  const removed = agg.sweep();
  check("越过窗口后清理全部 3 个桶", removed === 3, `removed=${removed}`);
  check("清理后桶数为 0", agg.bucketCount() === 0, `${agg.bucketCount()}`);

  agg.reset();
  check("reset 清空", agg.bucketCount() === 0);
}

// ═══ 10 / 11 / 12b. 纯源码文本断言组（真仓库）────────────────────────
// 见 `checkSourceTextGroups()` 的头注：这三组是**纯文本**判据 ⇒ 同一份函数
// 也能在 `--selftest` 的夹具树上跑（自检测的是**判据本身**，不是抄一份）。
checkSourceTextGroups(root);

// ═══ 12. 会话通知（设计文档 02 §7.2）═════════════════════════════
console.log("\n── 12. 会话通知（AgentNotifyService）──");
{
  // agent-notify.service.ts 依赖 NotificationService，后者的 import 图很大
  // （六个渠道 + 配置存储 + TypeORM 实体）。按本 harness 的「依赖打桩」
  // 边界：转译产物里的 require 改写到本地 stub，只测 notify 服务自身的
  // **行为**（分级 / 静默 / fail-open），不测渠道投递（那是通知模块的
  // 既有测试面）。
  const notifyRel = "src/modules/agent/runtime/agent-notify.service.ts";
  transpileGraph(notifyRel);
  const notifyJs = join(scratch, notifyRel.replace(/\.ts$/, ".js"));
  let code = readFileSync(notifyJs, "utf8");
  code = code.replace(
    /require\("(?:\.\.\/)+notification\/notification\.service"\)/,
    `require("./notification.service.stub")`,
  );
  writeFileSync(notifyJs, code);
  writeFileSync(
    join(scratch, "src/modules/agent/runtime/notification.service.stub.js"),
    [
      "class NotificationService {}",
      `const AlertLevel = { INFO: "info", WARNING: "warning", ERROR: "error", CRITICAL: "critical" };`,
      "module.exports = { NotificationService, AlertLevel };",
      "",
    ].join("\n"),
  );
  const { AgentNotifyService } = require(notifyJs);

  // 构造器签名未变（DB 打桩场景下外部 new 时参数位置不能漂移）
  check("构造依赖为 (NotificationService, ConfigService)", AgentNotifyService.length === 2);

  const makeNotify = (values = {}) => {
    const calls = [];
    const svc = new AgentNotifyService(
      { notify: async (...a) => calls.push(a) },
      { get: (k) => values[k] },
    );
    return { svc, calls };
  };
  const S = (over = {}) => ({
    id: "sess-1",
    kind: "ops_watch",
    status: "running",
    title: "定时环境巡检",
    triggerSource: "cron",
    totalSteps: 3,
    totalTokensIn: 10,
    totalTokensOut: 20,
    summary: null,
    errorMessage: null,
    ...over,
  });

  // §7.2 行 1：成功且有实质结论 → INFO + 摘要
  {
    const { svc, calls } = makeNotify();
    await svc.sessionFinished(S({ status: "succeeded", summary: "发现 exec-03 磁盘 92%" }));
    check("成功且有结论 → 通知一次", calls.length === 1, `${calls.length}`);
    check("  级别 INFO", calls[0]?.[2] === "info", `${calls[0]?.[2]}`);
    check("  内容含摘要", String(calls[0]?.[1]).includes("磁盘 92%"));
    check("  内容含会话标识", String(calls[0]?.[1]).includes("sess-1"));
  }

  // §7.2 行 4：静默会话（无结论）→ **不通知**
  {
    const { svc, calls } = makeNotify();
    await svc.sessionFinished(S({ status: "succeeded", summary: null }));
    check("成功无结论 → 静默不通知", calls.length === 0, `${calls.length}`);
    await svc.sessionFinished(S({ status: "succeeded", summary: "" }));
    check("空串结论同样静默", calls.length === 0, `${calls.length}`);
  }

  // §7.2 行 2：失败 / 预算超限 → ERROR（升级通知）
  {
    const { svc, calls } = makeNotify();
    await svc.sessionFinished(S({ status: "failed", errorMessage: "LLM call failed: 502" }));
    check("失败 → ERROR 级通知", calls.length === 1 && calls[0][2] === "error", `${calls[0]?.[2]}`);
    check("  内容含失败原因", String(calls[0]?.[1]).includes("502"));
  }
  {
    const { svc, calls } = makeNotify();
    await svc.sessionFinished(S({ status: "budget_exceeded", summary: "预算触顶（steps）" }));
    check("预算超限 → ERROR 级通知", calls.length === 1 && calls[0][2] === "error", `${calls[0]?.[2]}`);
  }

  // aborted 是管理员自己的动作 → 不回推
  {
    const { svc, calls } = makeNotify();
    await svc.sessionFinished(S({ status: "aborted", errorMessage: "killed by admin" }));
    check("aborted 不回推通知", calls.length === 0, `${calls.length}`);
  }

  // §7.2 行 3：待审批 → WARNING
  {
    const { svc, calls } = makeNotify();
    await svc.approvalRequested(S(), "deploy_application", "apr-sess-1-1", "write-tier 工具需人工确认");
    check("待审批 → WARNING 级通知", calls.length === 1 && calls[0][2] === "warning", `${calls[0]?.[2]}`);
    check("  内容含工具名", String(calls[0]?.[1]).includes("deploy_application"));
    check("  内容含审批单 id", String(calls[0]?.[1]).includes("apr-sess-1-1"));
  }

  // 开关关闭 → 全静默（但静默策略不受开关影响——开关只关「有事说话」）
  {
    const { svc, calls } = makeNotify({ "agent.notify.enabled": "false" });
    await svc.sessionFinished(S({ status: "succeeded", summary: "x" }));
    await svc.approvalRequested(S(), "t", "apr-1", "r");
    check("开关关闭 → 通知全停", calls.length === 0, `${calls.length}`);
  }

  // fail-open：通知服务整体抛错也不上抛（调用方是推理循环/收敛路径）
  {
    const boom = new AgentNotifyService(
      { notify: async () => { throw new Error("channels down"); } },
      { get: () => undefined },
    );
    let threw = false;
    try {
      await boom.sessionFinished(S({ status: "succeeded", summary: "x" }));
      await boom.approvalRequested(S(), "t", "apr-1", "r");
    } catch {
      threw = true;
    }
    check("通知服务挂掉不上抛（fail-open）", !threw);
  }
  // ⚠️ 本节的**接线结构断言**（finish→sessionFinished / summary 回退表达式 /
  // tool-executor→approvalRequested / module 注册 / configuration 段 /
  // Joi / .env.example 同步）已抽到 `checkSourceTextGroups()` 的 §12b ——
  // 那里是**纯文本**判据 ⇒ 可在 `--selftest` 的夹具树上跑（这里是转译+运行面）。
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部触发器断言通过 ===\n");
process.exit(failures ? 1 : 0);
