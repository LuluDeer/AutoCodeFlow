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
 *   4) 起草并发布 3 条演示 SOP（demo-sop- 前缀，幂等：按 slug 查找，已发布不再动；
 *      platform 验收锚点引用步骤 2 建的任务 id——教程 05 的零配置演示包）
 *   5) 打印摘要与后续操作提示
 *
 * 用法：
 *   node scripts/demo-seed.mjs --base-url http://localhost:3105 \
 *     --username admin --password 'Admin@123456'
 *   环境变量 ACF_API_URL / ACF_USER / ACF_PASSWORD 亦可。
 *
 * 卸载：脚本创建的任务都在 demo- 前缀、SOP 都在 demo-sop- 前缀下，
 * `acf task delete` / UI 删除即可。
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

/** 纯函数：按 slug 找 SOP（幂等复用的依据；任务按 name，SOP 按 slug）。 */
export function findSop(sops, slug) {
  return (sops ?? []).find((s) => s.slug === slug);
}

/**
 * 纯函数：演示 SOP 定义（参数化演示任务 id）。
 *
 * 三条 SOP 的验收锚点全部用 kind=platform 的平台任务——这是唯一能
 * 「零配置机器可验」的形态：中台复核会话按 acceptance 真触发一次任务
 * （demo-cron-report / demo-hello-fixed 由本脚本先建好），演示域
 * example.com 只出现在叙事里，不构成外部依赖。
 * task 字段必须传**任务 id**（uuid）：复核会话的 scope 闸门按 id 放行
 * （agent-boundary.service validateScope 精确比对），传任务名会被拒。
 *
 * front-matter 是机器契约（04 §1 / sop-frontmatter.ts 严格校验）：
 * 未知键拒绝、capabilities 枚举封闭、acceptance 发布必填——这里的每条
 * YAML 都按发布门全绿写，教程改字段时对着 sop-frontmatter.ts 的规则改。
 */
export function demoSopDefs(taskIds) {
  const helloId = taskIds?.["demo-hello-fixed"];
  const cronId = taskIds?.["demo-cron-report"];
  if (!helloId || !cronId) {
    throw new Error(
      "demoSopDefs 需要 demo-hello-fixed 与 demo-cron-report 的任务 id（platform 验收锚点）",
    );
  }
  return [
    {
      slug: "demo-sop-portal-morning-check",
      title: "[demo] 门户晨检（browser 能力域）",
      frontMatterYaml: `target:
  application: Chrome
capabilities:
  - browser
acceptance:
  - kind: platform
    check: trigger_task_and_expect_status
    task: ${cronId}
    expect: SUCCEEDED
    timeoutSec: 300
constraints:
  maxDurationSec: 900
  allowedDomains:
    - example.com
clarification:
  owner: center-agent
  maxRounds: 3
`,
      bodyMarkdown: `## 要做什么
检查演示门户 https://example.com 是否可访问：打开首页、确认标题包含
"Example Domain"、记录页面响应时间。这是 browser 能力域的最小演示 SOP。

## 验收
- 平台任务 \`demo-cron-report\` 触发并到 SUCCEEDED（演示形态的机器可验锚点：
  真实 SOP 的 platform 验收会挂业务任务本身；演示里用种子任务代表「门户健康」
  的平台侧事实源）

## 已知情况
- example.com 是 IANA 演示域，稳定可达；真实部署换成企业门户域名并同步
  front-matter 的 \`constraints.allowedDomains\`（裸域名，不含协议/路径）
- allowedDomains 是浏览器工具的导航闸——域外导航会被平台直接拒绝

## 你不必照做
上面没说怎么实现。可以用 Playwright 打开页面，也可以先 curl 探活再决定
是否值得开浏览器——**以平台验收通过为准**。
`,
    },
    {
      slug: "demo-sop-incident-log-archiver",
      title: "[demo] 失败执行归档（filesystem 能力域）",
      frontMatterYaml: `target:
  runtime: node
capabilities:
  - filesystem
acceptance:
  - kind: platform
    check: trigger_task_and_expect_status
    task: ${helloId}
    expect: SUCCEEDED
    timeoutSec: 300
constraints:
  maxDurationSec: 600
clarification:
  owner: human
  maxRounds: 2
`,
      bodyMarkdown: `## 要做什么
把执行记录里最近一条失败执行（任务 \`demo-fragile\`，seed 会先触发它一次）
的失败分类与错误信息整理成一份归档笔记，写到执行器工作区
\`incident-notes/notes.md\`（不存在则创建目录）。

## 验收
- 平台任务 \`demo-hello-fixed\` 触发并到 SUCCEEDED（演示形态的机器可验锚点，
  代表「归档动作完成后的健康检查」；真实 SOP 的 platform 验收会挂业务任务）
- 归档笔记包含失败分类（failure 分类枚举之一）与原始错误信息——人工复核时看

## 已知情况
- \`demo-fragile\` 是故意失败的任务：每次触发都抛
  "demo intentional failure"，失败分类与错误信息稳定可复现
- 工作区路径相对执行器 workspace 解析，不需要绝对路径

## 你不必照做
可以调平台 API 拉执行记录，也可以从任务详情页的时间线手工整理（如果这是
一次性值班动作）——**以平台验收通过为准**。
`,
    },
    {
      slug: "demo-sop-gui-x11-hello",
      title: "[demo] X11 会话 GUI 演示（gui 能力域，Linux）",
      frontMatterYaml: `target:
  application: xterm
capabilities:
  - gui
acceptance:
  - kind: platform
    check: trigger_task_and_expect_status
    task: ${helloId}
    expect: SUCCEEDED
    timeoutSec: 300
constraints:
  maxDurationSec: 600
clarification:
  owner: human
  maxRounds: 3
`,
      bodyMarkdown: `## 要做什么
在 X11/XWayland 会话里对 \`xterm\` 完成 GUI 动作演示：聚焦窗口 → 键入
\`echo gui-demo-ok > gui-demo-marker.txt\` → 回车 → 对目标窗口截图留档。

## 前置条件（缺一即如实不可用，能力上报不含 gui）
- Linux 执行器 + X11/XWayland 会话（含 Xvfb 无头形态）；xdotool + ffmpeg 已装
- 执行器本地权限档 \`hostAccess=app-scoped\` 且白名单含 \`xterm\`
- 中台 \`AGENT_SOP_POLICY_ALLOWED\` 已放宽（把 \`app-scoped\` 加入允许集）——
  中台 standard 档会把本地 app-scoped 钳回 none（roadmap §9.9）

## 验收
- 平台任务 \`demo-hello-fixed\` 触发并到 SUCCEEDED（演示形态的机器可验锚点；
  GUI 动作本身的产物 marker 文件留在工作区供人工核对）

## 已知情况
- GNOME Wayland 原生窗口如实不可达（枚举树里看不到、注入不达）——
  XWayland 客户端（xterm/Electron 应用）不受影响，见 12 号侦察稿 §2.2
- GUI 动作受逐动作白名单复核：每步先核对前台窗口进程名 == xterm，
  坐标越出目标窗口矩形即拒

## 你不必照做
可以先聚焦再键入，也可以用剪贴板粘贴路线绕开输入法——**以平台验收
通过为准**，但每步都会被逐动作复核，绕不开白名单。
`,
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

/**
 * SOP 列表的页数（{items,total} 形态：无 totalPages/pageSize 元数据，页数由
 * total 推导——与 tasks 端点全元数据形态不同，故不走 pageCount 的严格校验）。
 */
export function sopPageCount(data, pageSize = API_PAGE_SIZE) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("invalid sop pageSize");
  }
  const total = Number(data?.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("sop list response missing valid total");
  }
  return Math.ceil(total / pageSize);
}

/** 聚合 SOP 分页结果：total 对账 + 全局唯一 id，缺失/重复显式失败。 */
export function aggregateSopPages(firstData, subsequentData) {
  const firstItems = pageItems(firstData);
  const total = Number(firstData?.total);
  const pages = sopPageCount(firstData);
  if (!Array.isArray(subsequentData) || subsequentData.length !== Math.max(0, pages - 1)) {
    throw new Error(
      `sop list incomplete: expected ${Math.max(0, pages - 1)} subsequent pages, received ${String(subsequentData?.length)}`,
    );
  }
  const items = [firstItems, ...subsequentData.map((d) => pageItems(d))].flat();
  if (items.length !== total) {
    throw new Error(`sop list incomplete: expected ${total} items, received ${items.length}`);
  }
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("sop list item missing valid id");
    }
    if (ids.has(item.id)) {
      throw new Error(`sop list duplicate id: ${item.id}`);
    }
    ids.add(item.id);
  }
  return items;
}

/**
 * 分页拉全 SOP（/api/sop 专用的 {items,total} 契约）。
 * pageSize 请求 100 = 后端钳制上限（sop.service.list Math.min(100, ...)）。
 */
export async function listAllSops(baseUrl, token) {
  const getPage = async (page) => {
    const res = await apiFetch(baseUrl, `/api/sop?page=${page}&pageSize=${API_PAGE_SIZE}`, { token });
    if (!res.ok) {
      throw new Error(`GET /api/sop failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return unwrap(res.data);
  };

  const first = await getPage(1);
  const pages = [];
  for (let page = 2; page <= sopPageCount(first); page += 1) {
    pages.push(await getPage(page));
  }
  return aggregateSopPages(first, pages);
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

  // ── SOP 种子（demo-sop- 前缀，N-08）──
  // 三条演示 SOP：draft → 无版本才 publish（幂等：发布态不动、工作副本
  // 不覆盖——演示期间的人工改动不回滚）。指派不做：需要 agent 执行器在
  // 线，属教程 05 的前置步骤，不是 seed 的职责。
  const taskMap = Object.fromEntries(created.map(({ def, id }) => [def.name, id]));
  let sopDefs;
  try {
    sopDefs = demoSopDefs(taskMap);
  } catch (e) {
    console.error(`[demo-seed] skip SOP seed: ${e instanceof Error ? e.message : String(e)}`);
    sopDefs = [];
  }
  const existingSops = await listAllSops(baseUrl, token);
  const sops = [];
  for (const def of sopDefs) {
    const existing = findSop(existingSops, def.slug);
    let sopId;
    if (existing) {
      sopId = existing.id;
      console.log(`[demo-seed] sop exists, reusing: ${def.slug}`);
    } else {
      const res = await apiFetch(baseUrl, "/api/sop", {
        method: "POST",
        token,
        body: {
          slug: def.slug,
          title: def.title,
          frontMatterYaml: def.frontMatterYaml,
          bodyMarkdown: def.bodyMarkdown,
        },
      });
      if (!res.ok) {
        console.error(`[demo-seed] draft ${def.slug} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
        process.exit(1);
      }
      sopId = unwrap(res.data)?.id;
      console.log(`[demo-seed] sop drafted: ${def.slug} (${sopId})`);
    }
    // listVersions 返回裸数组（非分页）；有版本 = 已发布过，不再发布。
    const versions = await listAll(baseUrl, `/api/sop/${sopId}/versions`, token, { paginated: false });
    if (versions.length === 0) {
      const res = await apiFetch(baseUrl, `/api/sop/${sopId}/publish`, {
        method: "POST",
        token,
        body: { changelog: "demo seed 初版" },
      });
      if (!res.ok) {
        console.error(`[demo-seed] publish ${def.slug} failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
        process.exit(1);
      }
      // publish 返回 { sop, version: SopVersion 实体 }——版本号在 version.version
      const v = unwrap(res.data)?.version;
      console.log(`[demo-seed] sop published: ${def.slug} v${typeof v === "string" ? v : (v?.version ?? "?")}`);
    } else {
      console.log(`[demo-seed] sop already published (${versions.length} version(s)), keeping: ${def.slug}`);
    }
    sops.push({ slug: def.slug, id: sopId });
  }

  const sopLines = sops.map(({ slug, id }) => `    - ${slug} (${id})`).join("\n");
  console.log(`
[demo-seed] done. Open ${baseUrl.replace(":3105", "")} (admin web) and check:
  - 执行记录（demo-fragile 应有一条 failed，含失败分类与错误信息）
  - demo-hello-fixed 将每 15s 产生一条成功执行
  - 任务详情页的「依赖 DAG」/ 配置历史 / 通知设置可继续演示
  - SOP 页面三条 demo-sop- 前缀的演示 SOP（已发布 v1.0.0）：
${sopLines}
    教程：docs/tutorials/05-sop-agent-demo.md（指派/执行/GUI 演示的步骤与前置）
卸载：删除 demo- 前缀任务与 demo-sop- 前缀 SOP 即可。`);
}

// 仅直接执行时运行（selftest 可 import 纯函数）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("[demo-seed] fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
