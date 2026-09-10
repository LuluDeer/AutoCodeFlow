#!/usr/bin/env node
/**
 * AutoFlow 故障演练演示包种子脚本（NF-08，Node 原生零依赖，需 Node >= 18）
 *
 * 对运行中的 admin-api 一键预置「故障演练四件套」，教程四篇可直接复现：
 *   ① 失败任务：demo-failure-fragile（manual，glue 故意 throw）+ 触发一次，
 *      终态 failed + failureReason（失败分类/错误详情演示，教程 01 §6 / 04 §5）；
 *   ② runbook：demo-failure-runbook（manual，带 markdown runbook 字段，
 *      FEAT-11——任务详情页展示 + 失败告警拼 Runbook 段，教程 04 §4）；
 *   ③ 死信：demo-failure-deadend 事件订阅（FEAT-07/19）——url 指向一个
 *      **公网形状但必然连不上** 的地址（SSRF 深校验只拒内网/环回/链路本地/
 *      云元数据等非公网段，公网 IP 不拒），触发一次 execution.failed 事件后
 *      派发 3 次重试全败 → event_subscription_dead_letters 落一行死信；
 *   ④ 审批待办：demo-failure-gated 应用（approvalRequired=true，DEP-04）+
 *      一次 deploy → pending_approval 行冻结（零派发），审批收件箱可演示。
 *
 * 用法：
 *   node scripts/demo-failure-seed.mjs --base-url http://localhost:3105 \
 *     --username admin --password 'Admin@123456'
 *   环境变量 ACF_API_URL / ACF_USER / ACF_PASSWORD 亦可（对齐 demo-seed.mjs）。
 *   --clean            清理四件套（任务/订阅/应用；死信与部署行随 FK/级联清）
 *   --skip-trigger     只建不触发（不产生失败执行/死信/审批行）
 *   --deadend-host X   覆盖死信端点主机（默认 203.0.113.1，TEST-NET-3 文档段）
 *
 * 幂等：全部资源带 demo-failure- 前缀，先查后建，重复跑不重复建。
 * 卸载：--clean，或 UI/CLI 删除 demo-failure- 前缀资源即可。
 */
import { pathToFileURL } from "node:url";
import process from "node:process";

/** 演练资源统一前缀（幂等查找与 --clean 的依据）。 */
export const DEMO_FAILURE_PREFIX = "demo-failure-";

/**
 * 死信端点主机裁定（NF-08 侦察结论）：
 * - assertSafeHttpUrl（safe-http.util.ts）只拒「非公网」风险段（RFC1918/
 *   环回/链路本地/CGNAT/基准测试 198.18/15/组播/保留段），公网 IP 一律放行；
 * - 203.0.113.0/24（RFC 5737 TEST-NET-3）是 IANA 文档专用段，不在
 *   SSRF_DENY_HOST_PATTERNS 表内 → **可创建**；该段保证不被路由（不应答），
 *   axios 出站 connect 超时/拒连 → 派发必失败 → 3 次重试后落死信。
 * - 本机 fake-ip/透明代理环境（DNS 把公网域名解析到 198.18.0.0/15）会把
 *   域名形态拒在创建门口，故用 IP 字面量绕开 DNS——IP 字面量走同步判定，
 *   不受本机 DNS 污染影响。
 */
export const DEFAULT_DEADEND_HOST = "203.0.113.1";

/** 演练任务定义（参数化便于 selftest 断言与多环境复用）。 */
export function failureTaskDefs() {
  return [
    {
      name: `${DEMO_FAILURE_PREFIX}fragile`,
      description: "[demo-failure] 故意失败的任务——失败分类/错误详情/重试演示",
      runtime: "node",
      triggerType: "manual",
      timeout: 30,
      maxRetry: 1,
      glueSource: `console.log('about to fail on purpose (failure drill)');
throw new Error('demo-failure drill: expected failure for failureReason demo');
`,
      glueLanguage: "javascript",
    },
    {
      name: `${DEMO_FAILURE_PREFIX}runbook`,
      description: "[demo-failure] 带 runbook 的任务——告警带排障步骤演示（FEAT-11）",
      runtime: "node",
      triggerType: "manual",
      timeout: 30,
      maxRetry: 1,
      runbook: [
        "## 排障步骤",
        "",
        "1. 打开「执行记录」看最近一次失败执行的错误信息与日志；",
        "2. 确认执行器在线（「执行器」页心跳时间）；",
        "3. 本任务是演练样本，失败为预期行为——无需升级。",
        "",
        "## 升级路径",
        "",
        "- 演练环境：直接删除本任务结束演练；",
        "- 生产环境：连续失败 3 次以上升级到平台值班（oncall），附 traceId。",
      ].join("\n"),
      glueSource: `console.log('runbook drill task: failing so the runbook shows up');
throw new Error('demo-failure drill: runbook task expected failure');
`,
      glueLanguage: "javascript",
    },
  ];
}

/** 死信订阅定义（url 指向必然连不上的公网形状地址）。 */
export function deadLetterSubDef(deadendHost = DEFAULT_DEADEND_HOST) {
  return {
    name: `${DEMO_FAILURE_PREFIX}deadend`,
    url: `http://${deadendHost}/hooks/autoflow-drill`,
    eventTypes: ["execution.failed"],
  };
}

/** 审批演示应用定义（approvalRequired=true，DEP-04 冻结语义）。 */
export function approvalAppDef() {
  return {
    name: `${DEMO_FAILURE_PREFIX}gated`,
    description: "[demo-failure] 审批门禁演示应用——部署需第二人审批（DEP-04）",
    approvalRequired: true,
  };
}

/** 纯函数：从列表里找同名资源（幂等复用依据，对齐 demo-seed.findExisting）。 */
export function findExisting(items, name, key = "name") {
  return (items ?? []).find((it) => it?.[key] === name);
}

/** 拆包 admin-api 全局 {code,message,data} 信封（非信封 passthrough）。 */
export function unwrap(raw) {
  if (raw && typeof raw === "object" && "data" in raw && ("code" in raw || "message" in raw)) {
    return raw.data;
  }
  return raw;
}

/** 纯函数：从执行列表判定是否已存在某任务的失败执行（幂等跳过触发依据）。 */
export function hasFailedExecution(execItems, taskId) {
  return (execItems ?? []).some((e) => e?.taskId === taskId && e?.status === "failed");
}

/** 纯函数：从部署列表判定某应用是否已有待审批行（幂等跳过依据）。 */
export function hasPendingApproval(deployItems, applicationId) {
  return (deployItems ?? []).some(
    (d) => d?.applicationId === applicationId && d?.approvalStatus === "pending_approval",
  );
}

/** 纯函数：从订阅列表判定死信订阅是否已存在（按 url 匹配，读面无 name 字段）。 */
export function findSubByUrl(subs, url) {
  return (subs ?? []).find((s) => s?.url === url);
}

async function apiFetch(baseUrl, path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

/** 分页拉全（/api/tasks、/api/executions 等分页端点的通用取面）。 */
async function listAll(baseUrl, path, token, pageSize = 500) {
  const res = await apiFetch(baseUrl, `${path}?page=1&pageSize=${pageSize}`, { token });
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const data = unwrap(res.data);
  return data?.items ?? data ?? [];
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (flag, def = undefined) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : process.env[`ACF_${flag.replace("--", "").toUpperCase()}`] ?? def;
  };
  const baseUrl = (argOf("--base-url") ?? "http://localhost:3105").replace(/\/+$/, "");
  const username = argOf("--username") ?? "admin";
  const password = argOf("--password");
  const skipTrigger = args.includes("--skip-trigger");
  const clean = args.includes("--clean");
  const deadendHost = argOf("--deadend-host") ?? DEFAULT_DEADEND_HOST;

  if (!password) {
    console.error("[demo-failure-seed] missing --password (or ACF_PASSWORD env)");
    process.exit(1);
  }

  console.log(`[demo-failure-seed] admin-api: ${baseUrl}`);
  const login = await apiFetch(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  if (!login.ok) {
    console.error(
      `[demo-failure-seed] login failed (${login.status}): ${JSON.stringify(login.data).slice(0, 200)}`,
    );
    process.exit(1);
  }
  const token = unwrap(login.data)?.accessToken;
  if (!token) {
    console.error("[demo-failure-seed] login response missing accessToken");
    process.exit(1);
  }
  console.log("[demo-failure-seed] logged in");

  // ─── --clean：逆序清理四件套（死信/部署行随 FK 级联，无需单独删） ──────────
  if (clean) {
    // 订阅：读面无 name，按 url 前缀匹配（死信 FK ON DELETE CASCADE 级联清）。
    const subs = await listAll(baseUrl, "/api/event-subscriptions", token);
    for (const s of subs.filter((s) => String(s?.url ?? "").includes(DEMO_FAILURE_PREFIX))) {
      const del = await apiFetch(baseUrl, `/api/event-subscriptions/${s.id}`, { method: "DELETE", token });
      console.log(`[demo-failure-seed] subscription deleted: ${s.url} (${del.ok ? "ok" : del.status})`);
    }
    // 任务（执行记录随任务删除）。
    const tasks = await listAll(baseUrl, "/api/tasks", token);
    for (const t of tasks.filter((t) => String(t?.name ?? "").startsWith(DEMO_FAILURE_PREFIX))) {
      const del = await apiFetch(baseUrl, `/api/tasks/${t.id}`, { method: "DELETE", token });
      console.log(`[demo-failure-seed] task deleted: ${t.name} (${del.ok ? "ok" : del.status})`);
    }
    // 应用（部署行随应用删除级联清）。
    const apps = await listAll(baseUrl, "/api/applications", token);
    for (const a of apps.filter((a) => String(a?.name ?? "").startsWith(DEMO_FAILURE_PREFIX))) {
      const del = await apiFetch(baseUrl, `/api/applications/${a.id}`, { method: "DELETE", token });
      console.log(`[demo-failure-seed] application deleted: ${a.name} (${del.ok ? "ok" : del.status})`);
    }
    console.log("[demo-failure-seed] clean done.");
    return;
  }

  // ─── ①② 演练任务（失败样本 + runbook 样本） ─────────────────────────────
  const tasks = await listAll(baseUrl, "/api/tasks", token);
  const taskIds = {};
  for (const def of failureTaskDefs()) {
    const existing = findExisting(tasks, def.name);
    if (existing) {
      console.log(`[demo-failure-seed] task exists, reusing: ${def.name}`);
      taskIds[def.name] = existing.id;
      continue;
    }
    const res = await apiFetch(baseUrl, "/api/tasks", { method: "POST", token, body: def });
    if (!res.ok) {
      console.error(
        `[demo-failure-seed] create ${def.name} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`,
      );
      process.exit(1);
    }
    const id = unwrap(res.data)?.id;
    console.log(`[demo-failure-seed] task created: ${def.name} (${id})`);
    taskIds[def.name] = id;
  }

  // ─── ③ 死信订阅（公网形状但必然连不上 → 派发必败 → 死信） ────────────────
  const subDef = deadLetterSubDef(deadendHost);
  const subs = await listAll(baseUrl, "/api/event-subscriptions", token);
  let sub = findSubByUrl(subs, subDef.url);
  if (sub) {
    console.log(`[demo-failure-seed] subscription exists, reusing: ${subDef.url}`);
  } else {
    const res = await apiFetch(baseUrl, "/api/event-subscriptions", {
      method: "POST",
      token,
      body: { url: subDef.url, eventTypes: subDef.eventTypes },
    });
    if (!res.ok) {
      // SSRF 深校验拒绝（如本机 fake-ip 代理把该 IP 也劫持）时如实报错退出：
      // 演练者可换 --deadend-host 指定一个真实公网但不可达的 IP。
      console.error(
        `[demo-failure-seed] create subscription failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}\n` +
          `  提示：SSRF 校验拒绝了该地址？用 --deadend-host 换一个公网但不可达的 IP 重试。`,
      );
      process.exit(1);
    }
    sub = unwrap(res.data)?.subscription ?? unwrap(res.data);
    console.log(`[demo-failure-seed] subscription created: ${subDef.url} (${sub?.id})`);
  }
  const subId = sub?.id;

  // ─── ④ 审批门禁应用 + 待审批部署行 ──────────────────────────────────────
  const appDef = approvalAppDef();
  const apps = await listAll(baseUrl, "/api/applications", token);
  let app = findExisting(apps, appDef.name);
  if (app) {
    console.log(`[demo-failure-seed] application exists, reusing: ${appDef.name}`);
  } else {
    const res = await apiFetch(baseUrl, "/api/applications", { method: "POST", token, body: appDef });
    if (!res.ok) {
      console.error(
        `[demo-failure-seed] create application failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`,
      );
      process.exit(1);
    }
    app = unwrap(res.data);
    console.log(`[demo-failure-seed] application created: ${appDef.name} (${app?.id})`);
  }
  const appId = app?.id;

  // ─── 触发面（--skip-trigger 跳过）：失败执行 / 死信 / 审批行 ─────────────
  if (!skipTrigger) {
    const execs = await listAll(baseUrl, "/api/executions", token);

    // ① 失败执行：两个演练任务各触发一次（已有 failed 记录则跳过，幂等）。
    for (const def of failureTaskDefs()) {
      const taskId = taskIds[def.name];
      if (!taskId) continue;
      if (hasFailedExecution(execs, taskId)) {
        console.log(`[demo-failure-seed] failed execution exists for ${def.name}, skip trigger`);
        continue;
      }
      const res = await apiFetch(baseUrl, `/api/tasks/${taskId}/trigger`, { method: "POST", token, body: {} });
      console.log(`[demo-failure-seed] triggered ${def.name}: ${res.ok ? "ok" : `failed (${res.status})`}`);
    }

    // ③ 死信：再触发一次失败任务 → execution.failed 事件 → 订阅派发 3 连败
    //    → event_subscription_dead_letters 落行（重试退避 1s+2s，约 5-10s 后可查）。
    if (subId) {
      const fragileId = taskIds[`${DEMO_FAILURE_PREFIX}fragile`];
      if (fragileId) {
        const res = await apiFetch(baseUrl, `/api/tasks/${fragileId}/trigger`, { method: "POST", token, body: {} });
        console.log(
          `[demo-failure-seed] triggered fragile again for dead-letter drill: ${res.ok ? "ok" : `failed (${res.status})`}`,
        );
        console.log("[demo-failure-seed] dead letter will appear after ~10s (3 attempts, backoff 1s+2s):");
        console.log(`  GET /api/event-subscriptions/${subId}/dead-letters`);
      }
    }

    // ④ 审批待办：对门禁应用发起一次部署 → pending_approval 冻结行（零派发）。
    if (appId) {
      const deploys = await listAll(baseUrl, "/api/app-deployments", token);
      if (hasPendingApproval(deploys, appId)) {
        console.log("[demo-failure-seed] pending approval row exists, skip deploy");
      } else {
        const res = await apiFetch(baseUrl, `/api/app-deployments/applications/${appId}/deploy`, {
          method: "POST",
          token,
          body: {},
        });
        if (res.ok) {
          console.log("[demo-failure-seed] deployment request frozen as pending_approval (DEP-04)");
        } else if (res.status === 409 || res.status === 503) {
          // 409=已有在途/待审批行；503=无在线执行器（executorId 选不出来）。
          // 两者都不算演练失败：409 本身就是幂等语义；503 提示先注册执行器。
          console.log(
            `[demo-failure-seed] deploy not frozen (${res.status}): ${JSON.stringify(res.data).slice(0, 160)}`,
          );
          if (res.status === 503) {
            console.log("  提示：审批冻结需要至少一台在线执行器（deploy 先选执行器再冻结）。");
          }
        } else {
          console.error(
            `[demo-failure-seed] deploy failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`,
          );
        }
      }
    }
  }

  console.log(`
[demo-failure-seed] done. 四件套验收路径（教程四篇零配置可复现）：
  ① 失败任务  demo-failure-fragile → 执行记录里一条 failed（含 failureReason 分类）
  ② runbook   demo-failure-runbook → 任务详情页 runbook 段（markdown 渲染）
  ③ 死信      「事件订阅」页 demo-failure-deadend → 死信列表（触发后约 10s 落行）
  ④ 审批待办  「审批收件箱」demo-failure-gated 的 pending_approval 行（零派发）
清理：node scripts/demo-failure-seed.mjs --clean（或 UI 删除 demo-failure- 前缀资源）。`);
}

// 仅直接执行时运行（selftest 可 import 纯函数）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("[demo-failure-seed] fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
