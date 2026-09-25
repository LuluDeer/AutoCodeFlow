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
 * 用法: node scripts/agent-runtime-check.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apiDir = join(root, "apps/admin-api");
const require = createRequire(join(apiDir, "package.json"));

// TypeORM 实体装饰器需要 reflect-metadata 先就位
require("reflect-metadata");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

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
    async markRunning(id) {
      const s = sessions.get(id);
      s.status = "running";
      if (!s.startedAt) s.startedAt = new Date();
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
  const names = recorded.map((r) => r.name);
  check("预算触顶指标已埋点（运行时捕获）", names.includes("autoflow_agent_budget_exceeded_total"));
  const budgetEv = recorded.find((r) => r.name === "autoflow_agent_budget_exceeded_total");
  check("  带 reason 标签", typeof budgetEv?.labels?.reason === "string", JSON.stringify(budgetEv?.labels));

  // ② 结构断言——会话服务是埋点的主出口
  const sess = readFileSync(join(apiDir, "src/modules/agent/runtime/agent-session.service.ts"), "utf8");
  check("会话终态埋点存在", /recordRuntime\("autoflow_agent_sessions_total"/.test(sess));
  check("  带 kind + status 标签", /autoflow_agent_sessions_total",\s*\{\s*kind: session\.kind,\s*status,/s.test(sess));
  check("令牌埋点存在（成本归因）", /recordRuntime\("autoflow_agent_tokens_total"/.test(sess));
  check("  令牌按 in/out 分别计", /direction: "in"/.test(sess) && /direction: "out"/.test(sess));
  check("  带 provider/model 标签", /provider: input\.provider/.test(sess) && /model: input\.model/.test(sess));
  check("工具调用埋点存在", /recordRuntime\("autoflow_agent_tool_calls_total"/.test(sess));
  check("  带 tool/tier/status 标签", /tool: input\.toolName/.test(sess) && /tier: input\.tier/.test(sess));

  // 指标名必须在注册表里（否则 recordRuntime 静默忽略，埋点形同虚设）
  const reg = readFileSync(join(apiDir, "src/modules/metrics/runtime-metrics.ts"), "utf8");
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
  const proc = readFileSync(join(apiDir, "src/modules/agent/runtime/agent.processor.ts"), "utf8");
  check("队列名独立于 task-queue", /AGENT_QUEUE_NAME = "agent-jobs"/.test(proc));
  check("并发上限固定为 2（不随 CPU 弹性扩）", /AGENT_QUEUE_CONCURRENCY = 2/.test(proc));
  check("未预期异常不重抛（避免重复副作用）", /不重抛/.test(proc));

  const mod = readFileSync(join(apiDir, "src/modules/agent/agent.module.ts"), "utf8");
  check("模块注册独立队列", /BullModule\.registerQueue\(\{ name: AGENT_QUEUE_NAME \}\)/.test(mod));
  check("模块未被业务模块依赖的注释纪律在", /单向依赖/.test(mod));
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部运行时断言通过 ===\n");
process.exit(failures ? 1 : 0);
