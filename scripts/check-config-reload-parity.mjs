#!/usr/bin/env node
/**
 * config reload 的 `adminApiUrl → internal` 派生**跨端静态对拍守卫**。
 *
 * 缺陷背景：admin-api 只下发 `adminApiUrl`（不显式给 internal）时，两端必须在
 * 同一条件下把它派生进 internal 基址：
 *   · node:    apps/executor-node/src/routes/config.ts:244-246
 *              `if (body.adminApiUrlInternal === undefined && body.adminApiUrls === undefined) { config.adminApiUrlInternal = body.adminApiUrl; }`
 *   · python:  apps/executor-python/routers/config.py:229-230
 *              `if req.admin_api_url_internal is None: settings.admin_api_url_internal = req.admin_api_url`
 * 派生缺失是**静默**的：`get_admin_api_base_url()` 的优先级是 external > internal >
 * admin_api_url（apps/executor-python/admin_api.py:14-23），仍会返回旧的 internal，
 * 热更答 success:true 但拓扑纹丝不动，没有任何单测会红。
 *
 * 判据（全部从两端**源码文本现解析**，不硬编码期望值）：
 *   ① 结构锚点（下界 7/7）：reload 路由 + adminApiUrl 赋值 + internal 缺省条件
 *      （node 另有 adminApiUrls 缺省条件）。任一抽不到 = 路径/正则失效 ⇒ 结构红。
 *   ② 派生赋值：node `config.adminApiUrlInternal = body.adminApiUrl` /
 *      python `settings.admin_api_url_internal = req.admin_api_url`，且必须落在
 *      ①的**同一条件分支内**（TS 花括号配对 / Python 缩进块判定）。
 *      条件解析不到或派生在分支外 ⇒ 结构红（反永真，绝不静默绿）。
 *   ③ 两侧都有 ⇒ exit 0；任一侧没有 ⇒ exit 1 并点名缺失侧 + file:line。
 *
 * python 侧没有 admin_api_urls 字段（ConfigReloadRequest 与 _KNOWN_CONFIG_FIELDS
 * 已由 CodeGraph 核对：adminApiUrls 只由 node 支持），故 python 只判 internal 一个
 * 条件；node 侧仍要求 internal 与 adminApiUrls 两个缺省条件同时在分支头上。
 *
 * 用法：
 *   node scripts/check-config-reload-parity.mjs                     # 真仓库
 *   node scripts/check-config-reload-parity.mjs --root <dir>        # 夹具仓库
 *   node scripts/check-config-reload-parity.mjs --selftest          # 自检（真子进程）
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

// 覆盖哨兵：用例数 = 本文件里 `subprocess(` 的调用点数（每条 selftest 用例一个）。
printCoverageBanner(import.meta.url, "subprocess");

export const NODE_REL = "apps/executor-node/src/routes/config.ts";
export const PY_REL = "apps/executor-python/routers/config.py";
/** 结构锚点下界（node 4 + python 3），反「零命中全绿」。 */
export const MIN_ANCHORS = 7;

/** 两端的被测对象：锚点 + 派生赋值 + 条件分支词，全为源码文本形态。 */
export const SIDES = [
  {
    key: "node",
    label: "node",
    rel: NODE_REL,
    lang: "ts",
    anchors: [
      { name: "reload 路由", re: /configRouter\.post\(['"]\/config\/reload['"]/ },
      { name: "adminApiUrl 赋值", re: /config\.adminApiUrl\s*=\s*body\.adminApiUrl\b/ },
      { name: "internal 缺省条件", re: /body\.adminApiUrlInternal\s*===\s*undefined/ },
      { name: "adminApiUrls 缺省条件", re: /body\.adminApiUrls\s*===\s*undefined/ },
    ],
    derive: /config\.adminApiUrlInternal\s*=\s*body\.adminApiUrl\b/,
    cond: [
      /body\.adminApiUrlInternal\s*===\s*undefined/,
      /body\.adminApiUrls\s*===\s*undefined/,
    ],
    deriveHint: "config.adminApiUrlInternal = body.adminApiUrl",
    condHint: "body.adminApiUrlInternal === undefined && body.adminApiUrls === undefined",
  },
  {
    key: "python",
    label: "python",
    rel: PY_REL,
    lang: "py",
    anchors: [
      { name: "reload 路由", re: /@router\.post\(['"]\/config\/reload['"]/ },
      { name: "admin_api_url 赋值", re: /settings\.admin_api_url\s*=\s*req\.admin_api_url\b/ },
      { name: "internal 缺省条件", re: /\badmin_api_url_internal\s+is\s+None\b/ },
    ],
    derive: /settings\.admin_api_url_internal\s*=\s*req\.admin_api_url\b/,
    cond: [/\badmin_api_url_internal\s+is\s+None\b/],
    deriveHint: "settings.admin_api_url_internal = req.admin_api_url",
    condHint: "req.admin_api_url_internal is None",
  },
];

/** 剥注释但**保留行号与行数**：注释里引用的派生写法不算真实实现。 */
export function cleanLines(src, lang) {
  const lines = String(src ?? "").split(/\r?\n/);
  if (lang === "py") {
    return lines.map((line) => {
      const at = line.indexOf("#");
      return at < 0 ? line : line.slice(0, at) + " ".repeat(line.length - at);
    });
  }
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) return " ".repeat(line.length);
      line = " ".repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    let out = "";
    for (let i = 0; i < line.length; i += 1) {
      if (line.startsWith("/*", i)) {
        const end = line.indexOf("*/", i + 2);
        if (end < 0) {
          out += " ".repeat(line.length - i);
          inBlock = true;
          break;
        }
        out += " ".repeat(end + 2 - i);
        i = end + 1;
        continue;
      }
      // 只认空白/行首后的 //，躲开字符串里的 http://
      if (line.startsWith("//", i) && (i === 0 || /\s/.test(line[i - 1]))) {
        out += " ".repeat(line.length - i);
        break;
      }
      out += line[i];
    }
    return out;
  });
}

/** TS：从 `{` 起做花括号配对，返回配对 `}` 所在行号（0-based），失配返回 -1。 */
function braceBlockEnd(lines, openLine, openAt) {
  let depth = 0;
  for (let i = openLine; i < lines.length; i += 1) {
    for (let j = i === openLine ? openAt : 0; j < lines[i].length; j += 1) {
      if (lines[i][j] === "{") depth += 1;
      else if (lines[i][j] === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/** TS 派生必须落在 `if (internal === undefined && adminApiUrls === undefined) { … }` 内。 */
function nodeInside(lines, deriveIdx) {
  const from = Math.max(0, deriveIdx - 12);
  for (let i = deriveIdx; i >= from; i -= 1) {
    if (!/\bif\s*\(/.test(lines[i])) continue;
    let header = "";
    for (let j = i; j < Math.min(lines.length, i + 8); j += 1) {
      header += "\n" + lines[j];
      const open = lines[j].indexOf("{");
      if (open < 0) continue;
      if (!SIDES[0].cond.every((re) => re.test(header))) {
        return { ok: false, why: "if 条件头缺少 internal/adminApiUrls 缺省判断" };
      }
      const end = braceBlockEnd(lines, j, open);
      if (end < 0) return { ok: false, why: "条件分支花括号不配平（源码被截断）" };
      return {
        ok: deriveIdx > j && deriveIdx < end,
        condLine: i + 1,
        why: "派生赋值不在该条件分支内",
      };
    }
  }
  return { ok: false, why: "解析不到 if 条件分支（源码被搬走/改名/正则失配）" };
}

/** Python 派生必须落在 `if req.admin_api_url_internal is None:` 的缩进块内。 */
function pyInside(lines, deriveIdx) {
  const deriveIndent = /^\s*/.exec(lines[deriveIdx])[0].length;
  const from = Math.max(0, deriveIdx - 12);
  for (let i = deriveIdx - 1; i >= from; i -= 1) {
    const header = lines[i];
    if (!/^\s*if\s+/.test(header) || !/:\s*$/.test(header)) continue;
    if (!SIDES[1].cond.every((re) => re.test(header))) continue;
    const indent = /^\s*/.exec(header)[0].length;
    if (deriveIndent <= indent) {
      return { ok: false, why: "派生赋值没有缩进进条件分支", condLine: i + 1 };
    }
    for (let j = i + 1; j < deriveIdx; j += 1) {
      if (lines[j].trim() === "") continue;
      if (/^\s*/.exec(lines[j])[0].length <= indent) {
        return { ok: false, why: "派生赋值已滑出条件分支", condLine: i + 1 };
      }
    }
    return { ok: true, condLine: i + 1 };
  }
  return { ok: false, why: "解析不到 if 条件分支（源码被搬走/改名/正则失配）" };
}

/**
 * 纯判定：返回 { structural, missing, facts, anchorCount }。
 * structural = 判据瞎了（文件缺失 / 锚点不住 / 条件解析不到）⇒ 必须 exit 1；
 * missing    = 真实派生缺口（点名侧 + file:line）；facts = 两侧解析到的行号。
 */
export function checkConfigReloadParity({ root }) {
  const structural = [];
  const missing = [];
  const facts = [];
  let anchorCount = 0;

  for (const side of SIDES) {
    const abs = join(root, side.rel);
    if (!existsSync(abs)) {
      structural.push(
        `读不到 ${side.label} 侧源码 ${side.rel} —— 路径变了/文件被移走，判据瞎了（不是「两侧都没有」）。`,
      );
      continue;
    }
    const lines = cleanLines(readFileSync(abs, "utf8"), side.lang);
    for (const a of side.anchors) {
      if (lines.some((line) => a.re.test(line))) anchorCount += 1;
      else {
        structural.push(
          `${side.label} 侧 ${side.rel} 抽不到结构锚点「${a.name}」—— 扫描面塌方/正则失配，判结构红。`,
        );
      }
    }

    const deriveIdxs = [];
    lines.forEach((line, i) => {
      if (side.derive.test(line)) deriveIdxs.push(i);
    });
    if (deriveIdxs.length === 0) {
      const baseIdx = lines.findIndex((line) => side.anchors[1].re.test(line));
      missing.push({
        side: side.label,
        rel: side.rel,
        line: baseIdx >= 0 ? baseIdx + 1 : 1,
        hint: side.deriveHint,
        cond: side.condHint,
      });
      continue;
    }

    const deriveIdx = deriveIdxs[0];
    const inside = side.lang === "ts" ? nodeInside(lines, deriveIdx) : pyInside(lines, deriveIdx);
    if (!inside.ok) {
      structural.push(
        `${side.label} 侧 ${side.rel}:${deriveIdx + 1} 的派生没有落在预期条件分支内` +
          `（${inside.why}）—— 判结构红，绝不静默绿；期望条件 ${side.condHint}。`,
      );
      continue;
    }
    facts.push({
      side: side.label,
      rel: side.rel,
      deriveLine: deriveIdx + 1,
      condLine: inside.condLine,
    });
  }

  if (anchorCount < MIN_ANCHORS) {
    structural.push(`结构锚点只命中 ${anchorCount}/${MIN_ANCHORS} —— 扫描面下界不足（反永真）。`);
  }
  return { structural, missing, facts, anchorCount };
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    runSelftest();
    return;
  }
  const rootArg = argValue(argv, "--root");
  const root = resolve(rootArg ?? process.cwd());
  const { structural, missing, facts, anchorCount } = checkConfigReloadParity({ root });

  if (structural.length > 0) {
    console.error("");
    console.error("✖ config reload 派生守卫结构错误（判据本身不可信，绝不判绿）：");
    for (const e of structural) console.error("  · " + e);
    console.error("");
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error("");
    console.error(`✖ config reload adminApiUrl→internal 派生缺口：${missing.length} 侧缺失`);
    for (const m of missing) {
      console.error(
        `  · 缺失侧 ${m.side}：${m.rel}:${m.line} 未发现 \`${m.hint}\`` +
          `（应在 ${m.cond} 条件分支内）。`,
      );
    }
    console.error(
      "  修法：补上缺省派生（internal 未显式给时 = adminApiUrl），保持两端同形；不要改守卫放行。",
    );
    console.error("");
    process.exit(1);
  }
  console.log(
    "✔ config reload adminApiUrl→internal 派生两侧一致：" +
      facts.map((f) => `${f.side} ${f.rel}:${f.deriveLine}（条件 :${f.condLine}）`).join(" / ") +
      `；结构锚点 ${anchorCount}/${MIN_ANCHORS}。`,
  );
}

// ── 自检：临时夹具 + 真子进程（退出码 + 关键报错文本）──────────────────────
const SELF = fileURLToPath(import.meta.url);

const NODE_GOOD = `
import { Router } from 'express';
export const configRouter = Router();
configRouter.post('/config/reload', async (req, res) => {
  const body = req.body;
  if (body.adminApiUrl !== undefined) {
    config.adminApiUrl = body.adminApiUrl;
    if (body.adminApiUrlInternal === undefined && body.adminApiUrls === undefined) {
      config.adminApiUrlInternal = body.adminApiUrl;
    }
  }
});
`;

const PY_GOOD = `
@router.post('/config/reload', response_model=ConfigReloadResponse)
async def reload_config(req: ConfigReloadRequest, request: Request) -> ConfigReloadResponse:
    if req.admin_api_url is not None:
        if req.admin_api_url.strip():
            settings.admin_api_url = req.admin_api_url
            if req.admin_api_url_internal is None:
                settings.admin_api_url_internal = req.admin_api_url
`;

const fixtureTree = ({ node = NODE_GOOD, py = PY_GOOD, dropPy = false } = {}) => ({
  "package.json": { name: "config-reload-fixture", private: true },
  [NODE_REL]: node,
  ...(dropPy ? {} : { [PY_REL]: py }),
});

function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "config-reload-parity-selftest-" });
        try {
          expectExit(
            runGuard(SELF, { args: ["--root", repo.dir], cwd: repo.dir }),
            { ...expect, withinMs: 5000, label: name },
          );
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess(
    "① 两侧都有派生 ⇒ 绿",
    fixtureTree(),
    {
      code: 0,
      contains: ["两侧一致", "config.ts:", "config.py:"],
      absent: ["结构错误", "缺失侧"],
    },
  );

  subprocess(
    "② python 缺派生 ⇒ 红且点名 python 与 file:line",
    fixtureTree({
      py: PY_GOOD.replace("                settings.admin_api_url_internal = req.admin_api_url\n", ""),
    }),
    { code: 1, contains: ["缺失侧 python", "config.py:", "admin_api_url_internal is None"] },
  );

  subprocess(
    "③ node 缺派生 ⇒ 红且点名 node 与 file:line",
    fixtureTree({
      node: NODE_GOOD.replace("      config.adminApiUrlInternal = body.adminApiUrl;\n", ""),
    }),
    { code: 1, contains: ["缺失侧 node", "config.ts:", "adminApiUrlInternal === undefined"] },
  );

  subprocess(
    "④ 派生在条件分支外（node）⇒ 结构红（反永真）",
    fixtureTree({
      node: NODE_GOOD.replace(
        "      config.adminApiUrlInternal = body.adminApiUrl;\n    }\n",
        "    }\n    config.adminApiUrlInternal = body.adminApiUrl;\n",
      ),
    }),
    { code: 1, contains: ["结构错误", "条件分支"] },
  );

  subprocess(
    "⑤ python 侧文件被搬走 ⇒ 结构红（不静默绿）",
    fixtureTree({ dropPy: true }),
    { code: 1, contains: ["结构错误", PY_REL] },
  );

  const failed = reportCases(cases, { title: "check-config-reload-parity selftest" });
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
