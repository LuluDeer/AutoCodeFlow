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
 * 用法: node scripts/agent-trigger-check.mjs
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apiDir = join(root, "apps/admin-api");
const require = createRequire(join(apiDir, "package.json"));
require("reflect-metadata");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── 转译 ──────────────────────────────────────────────────────────
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

// ═══ 10. 触发器服务静态断言 ═══════════════════════════════════════
console.log("\n── 10. 触发器服务（静态）──");
{
  const src = readFileSync(join(apiDir, "src/modules/agent/trigger/agent-trigger.service.ts"), "utf8");

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
  check("事件触发的会话用空 scope（自动触发不该有写权限）", /scope: \{\}/.test(src));

  // 定时频率不过密
  check("定时巡检为每小时（非分钟级）", /@Cron\("0 5 \* \* \* \*"\)/.test(src));

  // 阈值覆盖传参正确（不应再有 config 篡改的 hack）
  check("聚合调用传阈值覆盖参数", /thresholdOverride,\s*\n\s*\);/.test(src));
  check("已移除 config 篡改 hack", !/observeWithThreshold/.test(src));
}

// ═══ 11. 模块装配 ═════════════════════════════════════════════════
console.log("\n── 11. 模块装配 ──");
{
  const mod = readFileSync(join(apiDir, "src/modules/agent/agent.module.ts"), "utf8");
  check("引入 SchedulerModule", /SchedulerModule/.test(mod));
  check("注册 AgentTriggerService", /AgentTriggerService,/.test(mod));
  check("注册 AgentEventAggregator", /AgentEventAggregator,/.test(mod));

  const cfg = readFileSync(join(apiDir, "src/config/configuration.ts"), "utf8");
  check("configuration 有 agent.trigger 段", /trigger: \{/.test(cfg));
  check("配置含 windowMs", /windowMs:/.test(cfg));
  check("配置含 threshold", /threshold:/.test(cfg));

  const app = readFileSync(join(apiDir, "src/app.module.ts"), "utf8");
  check("Joi 注册 AGENT_TRIGGER_WINDOW_MS", /AGENT_TRIGGER_WINDOW_MS:/.test(app));
  check("Joi 注册 AGENT_TRIGGER_THRESHOLD", /AGENT_TRIGGER_THRESHOLD:/.test(app));
}

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

  // ── 接线结构断言 ──
  const ssSrc = readFileSync(join(apiDir, "src/modules/agent/runtime/agent-session.service.ts"), "utf8");
  check("finish() 落库后调 sessionFinished（终态唯一收敛点）", /await this\.notify\.sessionFinished\(\{\s*\.\.\.session/.test(ssSrc));
  check("  传更新后的快照（新 summary 而非旧值）", /summary: options\.summary \?\? session\.summary,\s*errorMessage: options\.errorMessage \?\? null,\s*\}\);/.test(ssSrc));

  const teSrc = readFileSync(join(apiDir, "src/modules/agent/tools/tool-executor.service.ts"), "utf8");
  check("审批请求推送通知（P3 遗留项已兑现）", /this\.notify\.approvalRequested\(/.test(teSrc));

  const modN = readFileSync(join(apiDir, "src/modules/agent/agent.module.ts"), "utf8");
  check("模块注册 AgentNotifyService", /AgentNotifyService,/.test(modN));

  const cfgN = readFileSync(join(apiDir, "src/config/configuration.ts"), "utf8");
  check("configuration 有 agent.notify 段", /notify: \{\s*enabled: process\.env\.AGENT_NOTIFY_ENABLED/.test(cfgN));

  const appN = readFileSync(join(apiDir, "src/app.module.ts"), "utf8");
  check("Joi 注册 AGENT_NOTIFY_ENABLED", /AGENT_NOTIFY_ENABLED:/.test(appN));

  // .env.example 同步（agent.* 配置的三处同步纪律之一，P2 起曾漏）
  for (const f of [".env.example", "apps/admin-api/.env.example"]) {
    const env = readFileSync(join(root, f), "utf8");
    check(`${f} 文档化 AGENT_BUDGET_*`, /AGENT_BUDGET_MAX_STEPS=/.test(env));
    check(`${f} 文档化 AGENT_TRIGGER_*`, /AGENT_TRIGGER_WINDOW_MS=/.test(env) && /AGENT_TRIGGER_THRESHOLD=/.test(env));
    check(`${f} 文档化 AGENT_NOTIFY_ENABLED`, /AGENT_NOTIFY_ENABLED=/.test(env));
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部触发器断言通过 ===\n");
process.exit(failures ? 1 : 0);
