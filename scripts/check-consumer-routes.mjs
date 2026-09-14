#!/usr/bin/env node
// A4（DEEP_REVIEW §七 A4 · 契约单一事实源收口）：消费方路由面快照守卫
//
// 问题：admin-api 有 148 条 openapi 路径，而 mcp-server 与 acf-cli 各自
// **硬编码**了 70+ 条路由字符串（`'GET', \`/tasks/${id}\`` 之类）。两者之间
// 没有任何编译期耦合——它们不用生成的 api-types，也不 import admin-api。
// 于是 admin-api 改一次路由（重命名、改 HTTP 方法、删端点）在 admin-web 侧
// 会红（api-types drift 闸），在 mcp/CLI 侧却**完全静默**：只在用户真的调用
// 那个 MCP 工具 / CLI 子命令时才 404，且 404 会被信封拆包层吞成空错误体。
//
// 本脚本把「MCP/CLI 用到的每条路由都必须真实存在于 openapi.json」变成 CI 判据。
//
// 设计要点（踩过的坑都写在这）：
//  · 路径模板归一：`/tasks/${taskId}/stats` 与 openapi 的 `/tasks/{id}/stats`
//    字面不同但同构——统一把 `${...}` 与 `{...}` 都替换成 `{}` 再比对，
//    因此**参数名不同不算漂移**（MCP 侧叫 taskId、openapi 侧叫 id 是常态）。
//  · 查询串剥离：`/tasks?${params}` 的 `?` 之后不参与匹配。
//  · 扫描器自身带守卫（关键）：正则一旦因源码风格变化而匹配不到东西，
//    「0 条路由 → 0 条缺失」是**永真断言**，守卫会静默失效。故对每个来源
//    设规模下界，低于下界直接判失败（宁可红也不能假装绿）。
//
// 退出码：0 = 全部命中；1 = 存在 openapi 里没有的路由，或扫描器规模不达下界。
//
// 用法：node scripts/check-consumer-routes.mjs [--selftest]
//   --selftest：用内置 fixture 验证判据本身（不扫真实代码库）。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OPENAPI_PATH = "apps/admin-api/openapi.json";

// ── 扫描来源 ────────────────────────────────────────────────────────────────
// kind: "mcp"  → call<T>("METHOD", `path`)  /  call("METHOD", "path")
// kind: "cli"  → get|post|put|patch|del(`path`)   （del 即 DELETE）
const SOURCES = [
  {
    id: "mcp-server",
    kind: "mcp",
    files: ["packages/mcp-server/src/tools.ts"],
    // 规模下界：见上「扫描器自身带守卫」。低于此值说明正则失效而非路由变少。
    minRoutes: 20,
  },
  {
    id: "acf-cli",
    kind: "cli",
    dir: "packages/acf-cli/src/commands",
    minRoutes: 25,
  },
];

const METHOD_ALIASES = { del: "DELETE" };

/** 把源码里的路径模板归一成与 openapi 可比对的形式。返回 null 表示非字面量。 */
export function normalizePath(raw) {
  // 只接受以 "/" 开头的字面量路径——`get(url, {...})` 这类变量调用跳过。
  if (!raw.startsWith("/")) return null;
  const withoutQuery = raw.split("?")[0];
  // ${taskId} / {id} → {}（参数名不参与比对）
  const normalized = withoutQuery
    .replace(/\$\{[^}]*\}/g, "{}")
    .replace(/\{[^}]*\}/g, "{}");
  return normalized;
}

/** 从 openapi 取出 `METHOD /path`（path 已归一）集合。 */
export function collectOpenapiRoutes(doc) {
  const out = new Set();
  const methods = ["get", "put", "post", "delete", "patch"];
  for (const p of Object.keys(doc.paths ?? {})) {
    const norm = normalizePath(p);
    if (norm === null) continue;
    for (const m of methods) {
      if (doc.paths[p]?.[m]) out.add(`${m.toUpperCase()} ${norm}`);
    }
  }
  return out;
}

/** 扫描单个文件，返回 [{ method, path, line }]。 */
export function scanFile(text, kind) {
  const routes = [];
  const push = (method, raw, index) => {
    const norm = normalizePath(raw);
    if (norm === null) return;
    routes.push({
      method,
      path: norm,
      raw,
      line: text.slice(0, index).split("\n").length,
    });
  };

  if (kind === "mcp") {
    // call<X>("GET", `/tasks/${id}`) —— 方法名是独立的大写字符串字面量
    const re = /"(GET|POST|PUT|PATCH|DELETE)",\s*[`"]([^`"]*)[`"]/g;
    let m;
    while ((m = re.exec(text)) !== null) push(m[1], m[2], m.index);
  } else {
    // get|post|...(`/tasks/${id}`) —— 方法名是调用的函数名
    const re = /\b(get|post|put|patch|del|delete)(?:\s*<[^>]*>)?\s*\(\s*[`"']([^`"']*)[`"']/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const method = (METHOD_ALIASES[m[1]] ?? m[1]).toUpperCase();
      push(method, m[2], m.index);
    }
  }
  return routes;
}

/** 展开一个来源的文件列表。 */
function resolveFiles(source) {
  if (source.files) return source.files.filter((f) => existsSync(f));
  if (source.dir && existsSync(source.dir)) {
    return readdirSync(source.dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(source.dir, f));
  }
  return [];
}

/** 主判据：返回 { ok, problems, counts }。 */
export function checkConsumerRoutes({ openapiDoc, readFile = readFileSync }) {
  const openapi = collectOpenapiRoutes(openapiDoc);
  const problems = [];
  const counts = [];

  for (const source of SOURCES) {
    const files = resolveFiles(source);
    const seen = new Map(); // "METHOD path" → first occurrence 文件:行
    for (const file of files) {
      const text = readFile(file, "utf8");
      for (const r of scanFile(text, source.kind)) {
        const key = `${r.method} ${r.path}`;
        if (!seen.has(key)) seen.set(key, `${file}:${r.line} (${r.raw})`);
      }
    }
    counts.push({ id: source.id, routes: seen.size });

    // 扫描器自身守卫：规模不达下界 → 判据本身已失效，按失败处理。
    if (seen.size < source.minRoutes) {
      problems.push(
        `${source.id}: 只扫到 ${seen.size} 条路由，低于规模下界 ${source.minRoutes} —— ` +
          `扫描正则很可能已失效（源码风格变化？）。判据失效比漂移更危险，按失败处理。`,
      );
    }

    for (const [key, where] of [...seen.entries()].sort()) {
      if (!openapi.has(key)) problems.push(`${source.id}: ${key} 不在 openapi 中 —— ${where}`);
    }
  }

  return { ok: problems.length === 0, problems, counts, openapiSize: openapi.size };
}

// ── selftest：验证判据本身（不碰真实代码库）────────────────────────────────
function selftest() {
  const failures = [];
  const ok = (cond, name) => {
    if (!cond) failures.push(name);
  };

  // ① 归一：${x} 与 {x} 同构；查询串剥离；非字面量返回 null
  ok(normalizePath("/tasks/${taskId}/stats") === "/tasks/{}/stats", "归一 ${} 为占位");
  ok(normalizePath("/tasks/{id}/stats") === "/tasks/{}/stats", "归一 {} 为占位");
  ok(normalizePath("/tasks?${params}") === "/tasks", "剥离查询串");
  ok(normalizePath("/audit?page=1") === "/audit", "剥离静态查询串");
  ok(normalizePath("url") === null, "非字面量路径返回 null");

  // ② mcp 扫描：能抓到 call<T>("GET", `...`) 与 call("POST", "...") 两种写法
  const mcpSrc = [
    'const a = await call<unknown>("GET", `/tasks/${taskId}/stats`);',
    'const b = await call<unknown>("POST", "/tasks", body);',
    'const c = await call<unknown>(',
    '  "PATCH", `/tasks/${taskId}`',
    ');',
  ].join("\n");
  const mcpRoutes = scanFile(mcpSrc, "mcp");
  ok(mcpRoutes.length === 3, `mcp 扫到 3 条（实际 ${mcpRoutes.length}）`);
  ok(mcpRoutes[0].method === "GET" && mcpRoutes[0].path === "/tasks/{}/stats", "mcp 跨行调用可抓");
  ok(mcpRoutes[1].method === "POST" && mcpRoutes[1].path === "/tasks", "mcp 单行双引号可抓");

  // ③ cli 扫描：del → DELETE；跳过变量路径 get(url, ...)
  const cliSrc = [
    "const a = await del(`/tasks/${id}`);",
    "const b = await get<Task>(`/tasks/${id}`);",
    "const c = await get(url, { responseType: 'stream' });",
    "const d = await post<{ id?: string }>('/executors');",
  ].join("\n");
  const cliRoutes = scanFile(cliSrc, "cli");
  ok(cliRoutes.length === 3, `cli 扫到 3 条、跳过变量路径（实际 ${cliRoutes.length}）`);
  ok(cliRoutes[0].method === "DELETE", "cli del → DELETE");
  ok(cliRoutes[2].path === "/executors", "cli 单引号字面量可抓");

  // ④ 判据有牙：openapi 里删掉一条 → 必须报缺失
  const doc = {
    paths: {
      "/tasks": { get: {}, post: {} },
      "/tasks/{id}": { get: {}, patch: {}, delete: {} },
      "/tasks/{id}/stats": { get: {} },
      "/executors": { get: {}, post: {} },
    },
  };
  // 注意：真实 SOURCES 有规模下界，纯 fixture 下必然触发（fixture 只有几条路由），
  // 所以「干净」只指**没有缺失项**，不代表 problems 为空——下界逻辑由 ⑤ 单独覆盖。
  const clean = checkConsumerRoutes({
    openapiDoc: doc,
    readFile: (f) => (f.endsWith("tools.ts") ? mcpSrc : cliSrc),
  });
  ok(
    !clean.problems.some((p) => p.includes("不在 openapi 中")),
    `基线：全部命中时不报缺失（实际 ${JSON.stringify(clean.problems)}）`,
  );

  const missingStats = checkConsumerRoutes({
    openapiDoc: {
      paths: {
        "/tasks": { get: {}, post: {} },
        "/tasks/{id}": { get: {}, patch: {}, delete: {} },
        "/executors": { get: {}, post: {} },
      },
    },
    readFile: (f) => (f.endsWith("tools.ts") ? mcpSrc : cliSrc),
  });
  const statsProblem = missingStats.problems.filter((p) => p.includes("不在 openapi 中"));
  ok(
    statsProblem.length === 1 && statsProblem[0].includes("GET /tasks/{}/stats"),
    `删掉 /tasks/{id}/stats 的 GET → 精确报缺失（实际 ${JSON.stringify(statsProblem)}）`,
  );

  // ⑤ 扫描器自守卫有牙：源码风格一变（正则全失效）→ 规模不达下界即红，
  //    而不是「0 条路由 0 条缺失」的永真通过。
  const emptyScan = checkConsumerRoutes({
    openapiDoc: doc,
    readFile: () => "// 完全没有路由调用\n",
  });
  ok(!emptyScan.ok, "空扫描必须失败（不能永真通过）");
  ok(
    emptyScan.problems.some((p) => p.includes("规模下界")),
    `空扫描报的是规模下界而非别的（实际 ${JSON.stringify(emptyScan.problems)}）`,
  );

  if (failures.length) {
    console.error("selftest FAILED:");
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("check-consumer-routes selftest: OK");
}

// ── main ────────────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const doc = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
  const { ok, problems, counts, openapiSize } = checkConsumerRoutes({ openapiDoc: doc });

  const summary = counts.map((c) => `${c.id} ${c.routes} 条`).join(" · ");
  if (ok) {
    console.log(
      `consumer-routes guard OK：${summary}；openapi ${openapiSize} 个 method+path 组合，全部命中。`,
    );
  } else {
    console.error(`consumer-routes guard FAILED（openapi ${openapiSize} 个组合，${summary}）：`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }
}
