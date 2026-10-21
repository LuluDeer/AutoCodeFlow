#!/usr/bin/env node
/**
 * 「同族实现」雷达（**只报告、永不失败**）。
 *
 * 由来：R74-A1 在 executor-node 修掉一个 SSRF 绕过之后，R77 才**偶然**发现 admin-api 里还有一份
 * 更硬的实现、而 python 侧还有第三份。三次发现全是「撞上了」而不是「查过了」。
 * 本仓的重复实现不是意外 —— 一个 monorepo 里同一安全概念被多个 app 各实现一遍，是结构性的。
 *
 * 这个脚本把「记得去搜」变成「跑一下」：按**安全概念**列出现存的实现点，按 app 归组。
 * 它**不判断对错**，只回答一个问题：
 *
 *   **这个概念，除了我刚改的这一处，还有几处？**
 *
 * 用法：node scripts/report-sibling-implementations.mjs [--concept=ssrf]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "dist", "build", "out", "coverage", ".git",
  "resources", "generated", "__snapshots__", "dist-selftest",
]);
const SKIP_FILE_RE = /\.(spec|test)\.(ts|tsx|js|mjs)$|_test\.py$|^test_.*\.py$|\.d\.ts$/;

/**
 * 概念表。每个概念用若干正则识别「这里在实现它」；命中文件数 ≥2 个 app 的即为**同族候选**。
 * 正则刻意宽松（宁可多看几行，也别漏实现点）—— 这是雷达，不是门禁。
 */
const CONCEPTS = [
  {
    id: "ssrf",
    title: "SSRF / 私网地址判定",
    patterns: [/169\.254/, /fe80::/, /is_global/, /isPrivateIp|isRestrictedIpv/i, /::ffff/i],
  },
  {
    id: "constant-time",
    title: "凭据比较（恒定时间）",
    patterns: [/timingSafeEqual/, /constant[-_ ]?time/i, /secrets\.compare_digest/],
  },
  {
    id: "zip-slip",
    title: "解压路径穿越（zip-slip）",
    patterns: [/zip[-_ ]?slip/i, /assertSafeZip|safeExtractZip|assert_safe_zip/i, /\.\.\/.*entries|entryPath/i],
  },
  {
    id: "secret-redaction",
    title: "密钥脱敏（日志/响应）",
    patterns: [/REDACT|redact/i, /maskSecret|mask_secret/i, /\*\*\*\*\*\*/],
  },
  {
    id: "atomic-write",
    title: "原子写（tmp + rename）",
    patterns: [/\.tmp['\"`]|tmpPath|tmp_path/, /renameSync|os\.replace|os\.rename/],
  },
  {
    id: "token-hash",
    title: "凭据存储（哈希而非明文）",
    patterns: [/bcrypt|argon2|scrypt|pbkdf2/i, /tokenHash|token_hash/i],
  },
  {
    id: "callback-signature",
    title: "回调签名（HMAC）",
    patterns: [/createHmac|hmac\.new|HmacSHA/i],
  },
  {
    id: "path-containment",
    title: "路径包含性校验（目录逃逸）",
    patterns: [/resolve\(.*\)\.startsWith|isWithinRoot|assertWithinRoot|commonpath|realpath/i],
  },
];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|mjs|py)$/.test(e.name) && !SKIP_FILE_RE.test(e.name)) {
      out.push(p);
    }
  }
}

const files = [];
for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);

/** `apps/<app>/…` 或 `packages/<pkg>/…` → app 标签；其余归 misc。 */
function appOf(rel) {
  const parts = rel.split("/");
  if (parts.length >= 2 && (parts[0] === "apps" || parts[0] === "packages")) {
    return parts[1];
  }
  return "misc";
}

const wanted = process.argv.find((a) => a.startsWith("--concept="));
const only = wanted ? wanted.slice("--concept=".length) : null;

let siblingFound = 0;
console.log("同族实现雷达 · 扫描 " + files.length + " 个源文件");
console.log("（只报告，不判断对错。问题只有一个：这个概念除了你刚改的那处，还有几处？）");

for (const c of CONCEPTS) {
  if (only && c.id !== only) continue;
  const byApp = new Map();
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join("/");
    const src = readFileSync(f, "utf8");
    // 排除**守卫自己的豁免标记行**：`constant-time-exempt: …` 这类注释里带着概念词，
    // 会被当成「这里实现了该概念」—— 那是**测量工具污染自己的测量结果**。
    // 实测：R81 给桌面端三处加豁免注释后，本雷达立刻把 `executor-desktop` 报成
    // 「新增一个 app 的恒定时间实现」（4 app/12 文件 → 5 app/16 文件），而那里一行实现都没有。
    const sourceWithoutMarkers = src
      .split("\n")
      .filter((line) => !line.includes("-exempt"))
      .join("\n");
    if (!c.patterns.some((p) => p.test(sourceWithoutMarkers))) continue;
    const app = appOf(rel);
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app).push(rel);
  }
  if (byApp.size === 0) continue;
  const total = [...byApp.values()].reduce((n, v) => n + v.length, 0);
  const tag = byApp.size >= 2 ? "⚠ 同族候选" : "  单处";
  if (byApp.size >= 2) siblingFound++;
  console.log("");
  console.log(tag + " · " + c.title + "（" + byApp.size + " 个 app / " + total + " 个文件）");
  for (const [app, list] of [...byApp.entries()].sort()) {
    console.log("    " + app + "（" + list.length + "）");
    for (const f of list.slice(0, 4)) console.log("      " + f);
    if (list.length > 4) console.log("      … 另 " + (list.length - 4) + " 个");
  }
}

console.log("");
console.log(
  "ℹ 共 " + siblingFound + " 个概念跨 ≥2 个 app —— 每一个都是「改一处、漏一处」的候选。",
);
console.log("  真正的处置不是把它们合并成一个包（成本高），而是像 R77/R79 那样：");
console.log("  **用一张共享矩阵 + 一个 parity 守卫钉住两侧**。");
