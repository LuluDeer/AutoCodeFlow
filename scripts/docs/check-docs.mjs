#!/usr/bin/env node
// DOC-GOV：文档仓库守卫（死链 / 孤儿 / 根目录洁癖）。
//
// 为什么需要它：治理前仓库有 51 条死链、77 篇孤儿文档、13 份一次性报告堆在
// 根目录，而且**没有任何东西会读它们**——问题可以静默存在几个月。本脚本把
// 这三类退化变成 CI 红灯。
//
// 三个判据（可用 --only=<name> 单独跑）：
//   ① links     —— Markdown 相对链接必须可解析。支持三种约定：
//                  · 原样路径存在
//                  · 无扩展名 → 补 `.md`（VitePress / GitHub 约定）
//                  · 目录 → 目录下存在 README.md 或 index.md
//   ② orphans   —— docs/ 下的文档必须能从「入口文件」沿链接走到，
//                  入口 = docs/README.md、仓库根 README.md、docs/atlas/README.md。
//                  archive/ 豁免（归档区不要求入链，见 docs/archive/README.md）。
//   ③ root-hygiene —— 仓库根目录只允许白名单内的 Markdown（README / LICENSE /
//                  CHANGELOG / CONTRIBUTING / AGENTS 等）。一次性报告一律进
//                  docs/archive/。
//
// 零依赖：仅 node:fs / node:path，node ≥ 18 可直接跑。
// 用法：node scripts/docs/check-docs.mjs [--only=links|orphans|root-hygiene] [--json]
// 自检：node scripts/docs/check-docs.selftest.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

// 不参与扫描的目录：依赖 / 产物 / 本地索引 / 第三方包
const SKIP_DIR = new Set([
  "node_modules", ".git", ".codegraph", ".turbo", "dist", "coverage",
  ".vitepress", "dist-electron", "dist-selftest", "build", ".next",
  "test-results", "playwright-report", ".pytest_cache", ".cache",
  ".workbuddy", ".workbuddy-ai", ".kiro", ".qoder", ".zcode",
  ".codeartsdoer", ".devin", ".vscode", ".venv", "venv", "site-packages",
]);

// 仓库根允许存在的 Markdown（其余必须进 docs/archive/）
// 注：README.en.md / README.zh.md 是 readme-sync workflow 从 README.md 拆出的
// **构建产物**（CI 自动生成并提交），必须留在根目录供 GitHub / npm 直接读取。
export const ROOT_MD_ALLOWLIST = new Set([
  "README.md",
  "README.en.md",
  "README.zh.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "AGENTS.md",
]);

// 孤儿检查的入口（从这里出发沿链接遍历，走不到的 docs 文档即孤儿）
export const ENTRY_POINTS = ["docs/README.md", "README.md", "docs/atlas/README.md"];

// 孤儿检查豁免的前缀
export const ORPHAN_EXEMPT = ["docs/archive/"];

const norm = (p) => p.replace(/\\/g, "/");

/** 递归列出仓库内的 Markdown 文件（仓库相对路径）。 */
export function listMarkdown(root = REPO_ROOT) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".md")) out.push(norm(path.relative(root, abs)));
    }
  })(root);
  return out.sort();
}

/** 抽取一段 Markdown 里的所有内联链接目标（跳过外链与纯锚点）。 */
export function extractLinks(text) {
  const links = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(text))) {
    const url = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // http:, mailto:, data:
    if (url.startsWith("#")) continue;
    links.push(url.split("#")[0]);
  }
  return links.filter(Boolean);
}

/** 把链接解析成仓库内实际存在的目标；解析不到返回 null。 */
export function resolveTarget(root, fromRel, url) {
  const base = url.startsWith("/")
    ? path.join(root, url.slice(1))
    : path.resolve(root, path.dirname(fromRel), url);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return norm(path.relative(root, base));
  // 目录 → README.md / index.md
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const idx of ["README.md", "index.md"]) {
      const p = path.join(base, idx);
      if (fs.existsSync(p)) return norm(path.relative(root, p));
    }
    return null;
  }
  // 无扩展名约定 → 补 .md
  if (!path.extname(base) && fs.existsSync(`${base}.md`)) {
    return norm(path.relative(root, `${base}.md`));
  }
  return null;
}

/** 判据 ①：死链。 */
export function checkLinks(root = REPO_ROOT) {
  const errors = [];
  for (const rel of listMarkdown(root)) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const url of extractLinks(text)) {
      if (resolveTarget(root, rel, url) === null) errors.push(`${rel} → ${url}`);
    }
  }
  return errors;
}

/** 判据 ②：孤儿文档（docs/ 下从入口走不到的文档）。 */
export function checkOrphans(root = REPO_ROOT) {
  const reachable = new Set();
  const queue = ENTRY_POINTS.filter((p) => fs.existsSync(path.join(root, p)));
  for (const p of queue) reachable.add(p);
  while (queue.length) {
    const cur = queue.shift();
    const text = fs.readFileSync(path.join(root, cur), "utf8");
    for (const url of extractLinks(text)) {
      const target = resolveTarget(root, cur, url);
      if (!target || !target.endsWith(".md")) continue;
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  return listMarkdown(root)
    .filter((rel) => rel.startsWith("docs/"))
    .filter((rel) => !ORPHAN_EXEMPT.some((p) => rel.startsWith(p)))
    .filter((rel) => !reachable.has(rel));
}

/** 判据 ③：根目录 Markdown 洁癖。 */
export function checkRootHygiene(root = REPO_ROOT) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .filter((name) => !ROOT_MD_ALLOWLIST.has(name))
    .map((name) => `${name}（根目录不允许放一次性文档，请移入 docs/archive/）`);
}

const CHECKS = {
  links: { run: checkLinks, label: "死链" },
  orphans: { run: checkOrphans, label: "孤儿文档" },
  "root-hygiene": { run: checkRootHygiene, label: "根目录洁癖" },
};

function main(argv) {
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const asJson = argv.includes("--json");
  const names = onlyArg ? onlyArg.slice("--only=".length).split(",") : Object.keys(CHECKS);

  let failed = 0;
  const report = {};
  for (const name of names) {
    const check = CHECKS[name];
    if (!check) {
      console.error(`未知判据：${name}（可选：${Object.keys(CHECKS).join(" / ")}）`);
      return 2;
    }
    const errors = check.run();
    report[name] = errors;
    if (errors.length) failed++;
    if (!asJson) {
      if (errors.length === 0) {
        console.log(`✔ ${check.label}检查通过`);
      } else {
        console.error(`✘ ${check.label}：${errors.length} 项`);
        errors.forEach((e) => console.error(`   · ${e}`));
      }
    }
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
