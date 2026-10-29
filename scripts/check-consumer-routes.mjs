#!/usr/bin/env node
// A4（DEEP_REVIEW §七 A4 · 契约单一事实源收口）：消费方路由面快照守卫
//
// 问题：admin-api 有 200+ 条 openapi 路径，而 mcp-server 与 acf-cli 各自
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
//  · **完整匹配，不是前缀匹配**：`GET /tasks` 不能靠 openapi 里的
//    `GET /tasks/{id}` 顶包（`has()` 是精确集合查找，不是 startsWith）。
//  · 扫描器自身带守卫（关键）：正则一旦因源码风格变化而匹配不到东西，
//    「0 条路由 → 0 条缺失」是**永真断言**，守卫会静默失效。故对每个来源
//    设规模下界，低于下界按**结构红**处理（宁可红也不能假装绿）。
//
// ## T4（第 4 轮守卫自检审计）修掉的假绿
//
//   · **注释算数（最贵的一条）**：旧 `scanFile` 直接对整段源码跑正则，
//     `// await call("GET", "/tasks")` 这种**注释里的示例**被当成真实调用。
//     于是一个模块的真调用全被注释掉、注释里留着 20+ 条路由字符串时，
//     `seen.size` 仍高于规模下界 → 守卫报绿（扫描已经瞎了却看不出来）。
//     现在先按 JS 词法剥注释（字符串里的 `//`、`/*` 不受影响，长度与换行保留），
//     再扫。反向也修了：注释里的「已下线端点」不再造成假红。
//   · **spec 文件进扫描面**：`resolveFiles` 只排除了 `.test.ts`，`.spec.ts`
//     里的 `get('/老端点')` 会要求 openapi 保留一个只存在于测试里的路由（假红），
//     而真正的命令文件被删掉时它又能把 `seen.size` 撑过下界（假绿）。
//     现在 `.spec.ts` / `.test.ts` / `.d.ts` 一律不进扫描面。
//   · **`--root` 缺失导致 selftest 测的是真实仓库**：旧 `checkConsumerRoutes`
//     通过 `readFile` 注入 fixture，但 `resolveFiles` 始终用 `process.cwd()`，
//     于是内存用例扫的其实是仓库真文件（碰巧命中）。现在路径一律相对 `root`。
//   · **只数条数**：旧 selftest 断言 `mcpRoutes.length === 3` 之类的函数级计数，
//     删掉 CLI 的 `process.exit(1)` 照样全绿。现在跑**真子进程**，逐条断言
//     退出码 + 关键文本（9 条）。
//   · **事实源缺失 = 崩栈**：openapi.json / tools.ts / commands 目录读不到时
//     旧实现抛 ENOENT 或静默「0 个文件 → 0 条路由」（下界能兜住一部分，
//     但报错是「规模不足」而不是「文件不在」）。现在事实源缺失 → **结构红**，
//     并点名缺的是哪个路径。
//   · **openapi 也要有下界**：openapi.json 被换成空对象时，
//     「所有路由都不在 openapi 中」虽然会红，但原因错；更糟的是两侧同时塌方时
//     可能全绿。现在 openapi 组合数低于下界 = 结构红。
//
// 退出码：0 = 全部命中；1 = 存在 openapi 里没有的路由，或判据本身失效（结构错）。
//
// 用法：node scripts/check-consumer-routes.mjs [--selftest] [--root <dir>]
//   --selftest：在临时 fixture 树里跑真脚本；断言退出码 + 关键文本 + <1s。
//   --root    ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const OPENAPI_REL = "apps/admin-api/openapi.json";

/** openapi 侧的扫描面下界（2026-10-29 实测 240 个 method+path 组合）。 */
export const MIN_OPENAPI_ROUTES = 100;

// ── 扫描来源 ────────────────────────────────────────────────────────────────
// kind: "mcp"  → call<T>("METHOD", `path`)  /  call("METHOD", "path")
// kind: "cli"  → get|post|put|patch|del(`path`)   （del 即 DELETE）
export const SOURCES = [
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

export const METHOD_ALIASES = { del: "DELETE" };

/** 把源码里的路径模板归一成与 openapi 可比对的形式。返回 null 表示非字面量。 */
export function normalizePath(raw) {
  // 只接受以 "/" 开头的字面量路径——`get(url, {...})` 这类变量调用跳过。
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  const withoutQuery = raw.split("?")[0];
  // ${taskId} / {id} → {}（参数名不参与比对）
  return withoutQuery.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[^}]*\}/g, "{}");
}

/**
 * 剥掉 JS/TS 注释，**保留字符串字面量**，并保持长度与换行不变。
 *
 * 手写状态机而不是正则：路由字符串本身在引号里，必须保留；而 `"http://x"`
 * 里的 `//` 不能被当成注释起点（否则后文整段消失、路由一起丢）。
 * 长度与换行不变 ⇒ `scanFile` 报出的行号仍对应源文件。
 */
export function stripJsComments(src) {
  const s = String(src ?? "");
  let out = "";
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) {
          out += n;
          i += 1;
        }
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      if (i < s.length) out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < s.length) {
        out += "  ";
        i += 1;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** 从 openapi 取出 `METHOD /path`（path 已归一）集合。 */
export function collectOpenapiRoutes(doc) {
  const out = new Set();
  const methods = ["get", "put", "post", "delete", "patch"];
  for (const p of Object.keys(doc?.paths ?? {})) {
    const norm = normalizePath(p);
    if (norm === null) continue;
    for (const m of methods) {
      if (doc.paths[p]?.[m]) out.add(`${m.toUpperCase()} ${norm}`);
    }
  }
  return out;
}

/** 扫描单个文件，返回 [{ method, path, raw, line }]（注释不算）。 */
export function scanFile(text, kind) {
  const clean = stripJsComments(text);
  const routes = [];
  const push = (method, raw, index) => {
    const norm = normalizePath(raw);
    if (norm === null) return;
    routes.push({
      method,
      path: norm,
      raw,
      line: clean.slice(0, index).split("\n").length,
    });
  };

  if (kind === "mcp") {
    // call<X>("GET", `/tasks/${id}`) —— 方法名是独立的大写字符串字面量
    const re = /"(GET|POST|PUT|PATCH|DELETE)",\s*[`"]([^`"]*)[`"]/g;
    let m;
    while ((m = re.exec(clean)) !== null) push(m[1], m[2], m.index);
  } else {
    // get|post|...(`/tasks/${id}`) —— 方法名是调用的函数名
    const re = /\b(get|post|put|patch|del|delete)(?:\s*<[^>]*>)?\s*\(\s*[`"']([^`"']*)[`"']/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const method = (METHOD_ALIASES[m[1]] ?? m[1]).toUpperCase();
      push(method, m[2], m.index);
    }
  }
  return routes;
}

/** 不进扫描面的文件名（测试与类型声明）。 */
export function isScannable(name) {
  return (
    /\.(ts|tsx|js|mjs|cjs)$/.test(name) &&
    !/\.(spec|test)\.[cm]?[jt]sx?$/.test(name) &&
    !/\.d\.[cm]?ts$/.test(name)
  );
}

/**
 * 展开一个来源的文件列表（**相对 root 的 POSIX 路径**）。
 *
 * @returns {{files: string[], missing: string[]}} missing = 事实源缺失的路径（结构红用）
 */
export function resolveFiles(source, root = process.cwd()) {
  if (source.files) {
    const missing = source.files.filter((f) => !existsSync(join(root, f)));
    return { files: source.files.filter((f) => existsSync(join(root, f))), missing };
  }
  if (source.dir) {
    const abs = join(root, source.dir);
    if (!existsSync(abs)) return { files: [], missing: [source.dir] };
    return {
      files: readdirSync(abs)
        .filter(isScannable)
        .sort()
        .map((f) => `${source.dir}/${f}`),
      missing: [],
    };
  }
  return { files: [], missing: [] };
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], counts: {id:string,routes:number,files:number}[],
 *            openapiSize: number}}
 *   `errors` = 真实漂移；`structure` = **判据本身不可信**（事实源缺失、扫描面塌方）。
 */
export function check(root = process.cwd()) {
  const errors = [];
  const structure = [];
  const counts = [];

  // ── ① openapi 面 ─────────────────────────────────────────────────────────
  const openapiAbs = join(root, OPENAPI_REL);
  /** @type {Set<string>|null} */
  let openapi = null;
  if (!existsSync(openapiAbs)) {
    structure.push(
      `事实源缺失：${OPENAPI_REL} —— 判据无从比对（产物未生成/路径改名都会这样，不是「没问题」）。`,
    );
  } else {
    try {
      openapi = collectOpenapiRoutes(JSON.parse(readFileSync(openapiAbs, "utf8")));
    } catch (error) {
      structure.push(
        `${OPENAPI_REL} 不是合法 JSON（${error.message}）—— 判据无从比对，先修产物。`,
      );
    }
    if (openapi !== null && openapi.size < MIN_OPENAPI_ROUTES) {
      structure.push(
        `只从 ${OPENAPI_REL} 读到 ${openapi.size} 个 method+path 组合（下界 ${MIN_OPENAPI_ROUTES}）—— ` +
          "openapi 产物塌方，两侧同时变空时会「全部命中」，按结构错处理。",
      );
      openapi = null;
    }
  }

  // ── ② 各消费方来源 ────────────────────────────────────────────────────────
  for (const source of SOURCES) {
    const { files, missing } = resolveFiles(source, root);
    if (missing.length > 0) {
      structure.push(
        `事实源缺失：${missing.join("、")} —— ${source.id} 的扫描面不在（路径改名/目录没生成），` +
          "「0 条路由」不是「全部命中」。",
      );
      continue;
    }

    const seen = new Map(); // "METHOD path" → first occurrence 文件:行
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      for (const r of scanFile(text, source.kind)) {
        const key = `${r.method} ${r.path}`;
        if (!seen.has(key)) seen.set(key, `${rel}:${r.line} (${r.raw})`);
      }
    }
    counts.push({ id: source.id, routes: seen.size, files: files.length });

    // 扫描器自身守卫：规模不达下界 → 判据本身已失效（结构红）。
    if (seen.size < source.minRoutes) {
      structure.push(
        `${source.id}: 只扫到 ${seen.size} 条路由（下界 ${source.minRoutes}，${files.length} 个文件）—— ` +
          "扫描正则很可能已失效（源码风格变化？真调用被注释掉了？）。判据失效比漂移更危险。",
      );
      continue;
    }

    if (openapi === null) continue; // openapi 已结构红，不再逐条报噪声

    for (const [key, where] of [...seen.entries()].sort()) {
      if (!openapi.has(key)) errors.push(`${source.id}: ${key} 不在 openapi 中 —— ${where}`);
    }
  }

  return { errors, structure, counts, openapiSize: openapi?.size ?? 0 };
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const MCP_ROUTES = 22;
const CLI_ROUTES = 27;
/** 60 条 filler 路径 × get/post = 120 个组合，顶过 MIN_OPENAPI_ROUTES=100。 */
const FILLER_PATHS = 60;

const mcpSource = (prefix = "/mcp", n = MCP_ROUTES) =>
  Array.from(
    { length: n },
    (_, i) => `const r${i} = await call<unknown>("GET", "${prefix}/${i}");`,
  ).join("\n") + "\n";

const cliSource = (prefix = "/cli", n = CLI_ROUTES) =>
  Array.from({ length: n }, (_, i) => "export const r" + i + " = await get(`" + prefix + "/" + i + "`);").join(
    "\n",
  ) + "\n";

/** 所有来源用到的路由（openapi fixture 必须包含它们）。 */
const sourceRoutePaths = (mcpPrefix = "/mcp", cliPrefix = "/cli") => [
  ...Array.from({ length: MCP_ROUTES }, (_, i) => [`${mcpPrefix}/${i}`, ["get"]]),
  ...Array.from({ length: CLI_ROUTES }, (_, i) => [`${cliPrefix}/${i}`, ["get"]]),
];

/** openapi fixture：`filler` 条 × get/post + 显式 extra 路径（[path, methods][]）。 */
const openapiFixture = ({ filler = FILLER_PATHS, extra = sourceRoutePaths() } = {}) => {
  const paths = {};
  for (let i = 0; i < filler; i += 1) paths[`/filler/${i}`] = { get: {}, post: {} };
  for (const [p, methods] of extra) {
    paths[p] = Object.fromEntries(methods.map((m) => [m, {}]));
  }
  return { openapi: "3.0.0", info: { title: "fixture", version: "0.0.1" }, paths };
};

/**
 * fixture 树。
 * @param {{openapi?: object|null, mcp?: string|null, cli?: string|null, cliExtra?: Record<string,string>}} [opts]
 */
const tree = ({ openapi = openapiFixture(), mcp = mcpSource(), cli = cliSource(), cliExtra = {} } = {}) => {
  const files = { "package.json": { name: "fixture", private: true } };
  if (openapi !== null) files[OPENAPI_REL] = openapi;
  if (mcp !== null) files[SOURCES[0].files[0]] = mcp;
  if (cli !== null) files[`${SOURCES[1].dir}/tasks.ts`] = cli;
  for (const [name, content] of Object.entries(cliExtra)) {
    files[`${SOURCES[1].dir}/${name}`] = content;
  }
  return files;
};

/**
 * 自检：9 条子进程用例。
 *
 * 每条都断言退出码 + 关键文本（文件:行 也钉住）：本脚本的历史事故形态在
 * **扫描面**（注释/测试文件/前缀匹配）与 **CLI 层**（`process.exit` 是否执行、
 * 事实源缺失是崩栈还是结构红），旧版函数级 selftest 对这两层都盲。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "consumer-routes-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 合规树：22 条 MCP + 27 条 CLI 全在 openapi → 绿", tree(), {
    code: 0,
    contains: [
      "consumer-routes guard OK",
      `mcp-server ${MCP_ROUTES} 条`,
      `acf-cli ${CLI_ROUTES} 条`,
      "全部命中",
    ],
    absent: ["✗", "结构错误", "guard FAILED"],
  });

  subprocess(
    "② 删掉 openapi 里的 GET /mcp/3 → 红（精确到 文件:行）",
    tree({
      openapi: openapiFixture({
        extra: sourceRoutePaths().filter(([p]) => p !== "/mcp/3"),
      }),
    }),
    {
      code: 1,
      contains: [
        "mcp-server: GET /mcp/3 不在 openapi 中",
        "tools.ts:4",
        "guard FAILED",
      ],
      absent: ["guard OK"],
    },
  );

  subprocess(
    "③ 【反证·注释算数】MCP 的真调用全被注释、注释里留 22 条路由 → 红（不能靠注释充数）",
    tree({
      mcp: Array.from(
        { length: MCP_ROUTES },
        (_, i) => `// await call<unknown>("GET", "/ghost/${i}"); // 已下线，留作示例`,
      ).join("\n") + "\n",
      // ghost 路径都在 openapi 里：旧实现会把它们当真调用、条数够 → 绿
      openapi: openapiFixture({
        extra: [...sourceRoutePaths(), ...Array.from({ length: MCP_ROUTES }, (_, i) => [`/ghost/${i}`, ["get"]])],
      }),
    }),
    {
      code: 1,
      contains: ["结构错误", "mcp-server: 只扫到 0 条路由", "下界 20"],
      absent: ["不在 openapi 中", "guard OK"],
    },
  );

  subprocess(
    "④ 【反证·spec 进扫描面】.spec.ts 里的私有路由不算消费方 → 仍绿",
    tree({
      cliExtra: {
        "routes.spec.ts": "export const t = await get('/only-in-spec');\n",
        "routes.test.ts": "export const t2 = await get('/only-in-test');\n",
        "types.d.ts": "declare const t3: '/only-in-dts';\n",
      },
    }),
    {
      code: 0,
      contains: ["guard OK", `acf-cli ${CLI_ROUTES} 条`],
      absent: ["only-in-spec", "only-in-test", "only-in-dts", "结构错误"],
    },
  );

  subprocess(
    "⑤ 【反证·前缀误配】源码 GET /tasks、openapi 只有 /tasks/{id} → 红（不是前缀匹配）",
    tree({
      cli: "export const t = await get('/tasks');\n" + cliSource(),
      openapi: openapiFixture({
        extra: [...sourceRoutePaths(), ["/tasks/{id}", ["get"]]],
      }),
    }),
    {
      code: 1,
      contains: ["acf-cli: GET /tasks 不在 openapi 中"],
      absent: ["guard OK"],
    },
  );

  subprocess(
    "⑥ 事实源缺失（openapi.json 不在）→ 结构红，不是崩栈也不是绿",
    tree({ openapi: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${OPENAPI_REL}`],
      absent: ["guard OK", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "⑦ 【反证·扫描面】openapi 只剩 6 个组合 → 结构红（不是「全部命中」）",
    tree({ openapi: openapiFixture({ filler: 3, extra: [] }) }),
    {
      code: 1,
      contains: ["结构错误", "读到 6 个 method+path 组合", `下界 ${MIN_OPENAPI_ROUTES}`],
      absent: ["guard OK"],
    },
  );

  subprocess(
    "⑧ 事实源缺失（mcp-server tools.ts 不在）→ 结构红并点名路径",
    tree({ mcp: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${SOURCES[0].files[0]}`],
      absent: ["guard OK", "Error:"],
    },
  );

  subprocess(
    "⑨ 事实源缺失（acf-cli commands 目录不在）→ 结构红并点名路径",
    tree({ cli: null }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${SOURCES[1].dir}`],
      absent: ["guard OK", "Error:"],
    },
  );

  const failed = reportCases(cases, { title: "check-consumer-routes selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-consumer-routes.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, counts, openapiSize } = check(root);
    const summary = counts.map((c) => `${c.id} ${c.routes} 条`).join(" · ");

    if (structure.length > 0) {
      console.error("");
      console.error("✖ consumer-routes 守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (errors.length > 0) {
      console.error(
        `consumer-routes guard FAILED（openapi ${openapiSize} 个组合，${summary}）：`,
      );
      for (const p of errors) console.error("  ✗ " + p);
      process.exit(1);
    }

    console.log(
      `consumer-routes guard OK：${summary}；openapi ${openapiSize} 个 method+path 组合，全部命中。`,
    );
  }
}
