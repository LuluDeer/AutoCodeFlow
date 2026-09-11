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
export const API_PAGE_SIZE = 100;

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

/**
 * 选择脚本应主动触发的演示任务，并按名称去重。
 * fixed_rate 由调度器负责；其余演示任务每次运行脚本最多触发一次。
 */
export function triggerTargets(created) {
  const seen = new Set();
  return (created ?? []).filter((entry) => {
    const name = entry?.def?.name;
    const triggerType = entry?.def?.triggerType;
    if (!name || !["manual", "cron"].includes(triggerType) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
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

/** 后端 PaginationDto 的 total/totalPages 共同决定需要读取的页数。 */
export function pageCount(data, pageSize = API_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("invalid pagination pageSize");
  }
  const total = Number(data?.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("paginated response missing valid total");
  }
  const expectedPages = Math.ceil(total / pageSize);
  const reportedPages = Number(data?.totalPages);
  if (!Number.isInteger(reportedPages) || reportedPages < 0 || reportedPages !== expectedPages) {
    throw new Error(
      `paginated response totalPages mismatch: expected ${expectedPages}, received ${String(data?.totalPages)}`,
    );
  }
  if (data?.pageSize !== undefined && Number(data.pageSize) !== pageSize) {
    throw new Error(
      `paginated response pageSize mismatch: expected ${pageSize}, received ${String(data.pageSize)}`,
    );
  }
  return expectedPages;
}

function pageItems(data) {
  const items = Array.isArray(data) ? data : data?.items ?? data?.list ?? data?.data;
  if (!Array.isArray(items)) {
    throw new Error("paginated response missing items/list/data array");
  }
  return items;
}

function expectedItemsOnPage(total, totalPages, page) {
  if (total === 0 && page === 1 && totalPages === 0) return 0;
  if (page < 1 || page > totalPages) return null;
  return page < totalPages ? API_PAGE_SIZE : total - API_PAGE_SIZE * (totalPages - 1);
}

function validatePage(data, requestedPage, expectedTotal, expectedTotalPages) {
  const items = pageItems(data);
  if (!Number.isInteger(Number(data?.page)) || Number(data.page) !== requestedPage) {
    throw new Error(
      `paginated response page mismatch: requested ${requestedPage}, received ${String(data?.page)}`,
    );
  }
  if (!Number.isInteger(Number(data?.pageSize)) || Number(data.pageSize) !== API_PAGE_SIZE) {
    throw new Error(
      `paginated response pageSize mismatch: expected ${API_PAGE_SIZE}, received ${String(data?.pageSize)}`,
    );
  }
  if (!Number.isInteger(Number(data?.total)) || Number(data.total) !== expectedTotal) {
    throw new Error(
      `paginated response total mismatch: expected ${expectedTotal}, received ${String(data?.total)}`,
    );
  }
  if (!Number.isInteger(Number(data?.totalPages)) || Number(data.totalPages) !== expectedTotalPages) {
    throw new Error(
      `paginated response totalPages mismatch: expected ${expectedTotalPages}, received ${String(data?.totalPages)}`,
    );
  }
  const expectedItems = expectedItemsOnPage(expectedTotal, expectedTotalPages, requestedPage);
  if (expectedItems === null || items.length !== expectedItems) {
    throw new Error(
      `paginated response incomplete: page ${requestedPage} expected ${String(expectedItems)} items, received ${items.length}`,
    );
  }
  return items;
}

/** 聚合分页结果，严格校验元数据、每页数量和全局唯一 id。 */
export function aggregatePages(firstData, subsequentData) {
  const firstTotal = Number(firstData?.total);
  const totalPages = pageCount(firstData);
  const firstItems = validatePage(firstData, 1, firstTotal, totalPages);
  if (!Array.isArray(subsequentData) || subsequentData.length !== Math.max(0, totalPages - 1)) {
    throw new Error(
      `paginated response incomplete: expected ${Math.max(0, totalPages - 1)} subsequent pages, received ${String(subsequentData?.length)}`,
    );
  }
  const allItems = [firstItems];
  for (let index = 0; index < subsequentData.length; index += 1) {
    allItems.push(validatePage(subsequentData[index], index + 2, firstTotal, totalPages));
  }
  const items = allItems.flat();
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("paginated response item missing valid id");
    }
    if (ids.has(item.id)) {
      throw new Error(`paginated response duplicate id: ${item.id}`);
    }
    ids.add(item.id);
  }
  if (items.length !== firstTotal) {
    throw new Error(`paginated response incomplete: expected ${firstTotal} items, received ${items.length}`);
  }
  return items;
}

/** 分页拉全资源；每次请求遵守后端 page-size 上限，不静默截断。 */
export async function listAll(baseUrl, path, token, { paginated = true } = {}) {
  const getPage = async (page) => {
    const requestPath = paginated
      ? `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=${API_PAGE_SIZE}`
      : path;
    const res = await apiFetch(baseUrl, requestPath, { token });
    if (!res.ok) {
      throw new Error(`GET ${path} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return unwrap(res.data);
  };

  const first = await getPage(1);
  if (!paginated || Array.isArray(first)) return pageItems(first);

  const pages = [];
  for (let page = 2; page <= pageCount(first); page += 1) {
    pages.push(await getPage(page));
  }
  return aggregatePages(first, pages);
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

  const existingTasks = await listAll(baseUrl, "/api/tasks", token);

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
    // fixed_rate 由调度器自动跑；cron/manual 演示任务各只主动触发一次。
    for (const { def, id } of triggerTargets(created)) {
      const res = await apiFetch(baseUrl, `/api/tasks/${id}/trigger`, {
        method: "POST",
        token,
        body: {},
      });
      console.log(`[demo-seed] triggered ${def.name}: ${res.ok ? "ok" : `failed (${res.status})`}`);
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
