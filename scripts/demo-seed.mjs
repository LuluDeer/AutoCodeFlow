#!/usr/bin/env node
/**
 * AutoFlow 演示数据种子脚本（DOC-03，Node 原生零依赖，需 Node >= 18）
 *
 * 对运行中的 admin-api 造一套可立即演示的数据，新用户 5 分钟看到完整 UI：
 *   1) 登录取 JWT
 *   2) 创建 3 个演示任务（幂等：按 name 查找，已存在则复用）：
 *      - demo-hello-fixed：fixed_rate 15s，node glue（持续产生成功执行）
 *      - demo-cron-report：cron 每 5 分钟，python glue
 *      - demo-fragile：manual，node glue，故意抛错（产生失败样本供详情页/失败分类演示）
 *   3) 触发 demo-fragile 与 demo-cron-report 各一次（fixed_rate 会自行跑起来）
 *   4) 打印摘要与后续操作提示
 *
 * 用法：
 *   node scripts/demo-seed.mjs --base-url http://localhost:3105 \
 *     --username admin --password 'Admin@123456'
 *   环境变量 ACF_API_URL / ACF_USER / ACF_PASSWORD 亦可。
 *
 * 卸载：脚本创建的任务都在 demo- 前缀下，`acf task delete` 或 UI 删除即可。
 */
import { pathToFileURL } from "node:url";
import process from "node:process";

const DEMO_PREFIX = "demo-";

/** 纯函数：从任务列表里找同名演示任务（幂等复用的依据） */
export function findExisting(tasks, name) {
  return (tasks ?? []).find((t) => t.name === name);
}

/** 纯函数：演示任务定义（参数化 base 以便多环境重复使用） */
export function demoTaskDefs() {
  return [
    {
      name: `${DEMO_PREFIX}hello-fixed`,
      description: "[demo] 15s 固定频率 node glue——持续产生成功执行",
      runtime: "node",
      triggerType: "fixed_rate",
      fixedRate: 15,
      timeout: 30,
      maxRetry: 1,
      glueSource: `const msg = 'hello from AutoCodeFlow at ' + new Date().toISOString();
console.log(msg);
ctx.log.info('demo run complete');
return { ok: true, msg };`,
      glueLanguage: "javascript",
    },
    {
      name: `${DEMO_PREFIX}cron-report`,
      description: "[demo] 每 5 分钟 python glue——cron + timezone 演示",
      runtime: "python",
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      timeout: 60,
      maxRetry: 1,
      glueSource: `import json
print('demo cron report')
result = {"ok": True, "rows": 42}
print(json.dumps(result))
`,
      glueLanguage: "python",
    },
    {
      name: `${DEMO_PREFIX}fragile`,
      description: "[demo] 故意失败的任务——供失败分类/重试/告警演示",
      runtime: "node",
      triggerType: "manual",
      timeout: 30,
      maxRetry: 1,
      glueSource: `console.log('about to fail on purpose');
throw new Error('demo intentional failure: check failureReason & error message');
`,
      glueLanguage: "javascript",
    },
  ];
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

/** 拆包 admin-api 全局 {code,message,data} 信封（非信封 passthrough） */
export function unwrap(raw) {
  if (raw && typeof raw === "object" && "data" in raw && ("code" in raw || "message" in raw)) {
    return raw.data;
  }
  return raw;
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

  if (!password) {
    console.error("[demo-seed] missing --password (or ACF_PASSWORD env)");
    process.exit(1);
  }

  console.log(`[demo-seed] admin-api: ${baseUrl}`);
  const login = await apiFetch(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  if (!login.ok) {
    console.error(`[demo-seed] login failed (${login.status}): ${JSON.stringify(login.data).slice(0, 200)}`);
    process.exit(1);
  }
  const token = unwrap(login.data)?.accessToken;
  if (!token) {
    console.error("[demo-seed] login response missing accessToken");
    process.exit(1);
  }
  console.log("[demo-seed] logged in");

  const list = await apiFetch(baseUrl, "/api/tasks?page=1&pageSize=500", { token });
  const existingTasks = unwrap(list.data)?.items ?? [];

  const created = [];
  for (const def of demoTaskDefs()) {
    const existing = findExisting(existingTasks, def.name);
    if (existing) {
      console.log(`[demo-seed] task exists, reusing: ${def.name}`);
      created.push({ def, id: existing.id, reused: true });
      continue;
    }
    const res = await apiFetch(baseUrl, "/api/tasks", {
      method: "POST",
      token,
      body: def,
    });
    if (!res.ok) {
      console.error(`[demo-seed] create ${def.name} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
      process.exit(1);
    }
    const id = unwrap(res.data)?.id;
    console.log(`[demo-seed] task created: ${def.name} (${id})`);
    created.push({ def, id, reused: false });
  }

  if (!skipTrigger) {
    for (const { def, id } of created) {
      if (def.triggerType !== "manual" && def.triggerType !== "cron") continue;
      const res = await apiFetch(baseUrl, `/api/tasks/${id}/trigger`, {
        method: "POST",
        token,
        body: {},
      });
      console.log(`[demo-seed] triggered ${def.name}: ${res.ok ? "ok" : `failed (${res.status})`}`);
    }
    // fixed_rate 由调度器自动跑；manual 的 fragile 也触发一次拿失败样本
    const fragile = created.find((c) => c.def.name === `${DEMO_PREFIX}fragile`);
    if (fragile) {
      await apiFetch(baseUrl, `/api/tasks/${fragile.id}/trigger`, { method: "POST", token, body: {} });
    }
  }

  console.log(`
[demo-seed] done. Open ${baseUrl.replace(":3105", "")} (admin web) and check:
  - 执行记录（demo-fragile 应有一条 failed，含失败分类与错误信息）
  - demo-hello-fixed 将每 15s 产生一条成功执行
  - 任务详情页的「依赖 DAG」/ 配置历史 / 通知设置可继续演示
卸载：删除 demo- 前缀任务即可。`);
}

// 仅直接执行时运行（selftest 可 import 纯函数）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("[demo-seed] fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
