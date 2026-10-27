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
//   ④ bare-paths  —— 正文里用反引号写的**仓库相对路径**（`docs/…` / `scripts/…` /
//                  `apps/…` / `packages/…`）必须真实存在。
//                  为什么单列一条：①（死链）只认 Markdown 链接，而本仓的「证据出处」
//                  大量写成行内裸路径（尤其 PLAN-CLAIMS 的认领记录）。文件被移到
//                  docs/archive/ 或改名后，这类指针就**静默失效**——复核者点不开、
//                  也无法判断它是"结论的来源"还是"作者写错的名字"。判据①看不见它们，
//                  所以必须有一条专门盯它（2026-10-27 实测一次就抓到 15 处）。
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

/**
 * 判据 ④ 扫的形态：正文里用行内代码写出的**仓库相对路径**。
 *
 * 为什么单列一条：判据 ①（死链）只认 Markdown 链接，而本仓的「证据出处」大量写成
 * 行内裸路径（尤其 PLAN-CLAIMS 的认领记录）。文件被移到 docs/archive/ 或改名后，
 * 这类指针**静默失效**——复核者点不开，也无法判断它是结论的来源还是作者写错的名字。
 * 判据 ① 看不见它们，所以必须有一条专门盯它（2026-10-27 实测一次抓到 15 处）。
 *
 * 三种刻意豁免（不然这条会变成噪音源而被关掉）：
 *   · 围栏代码块整体跳过——里面的路径可能是示例/模板，本就不承诺指向仓内文件；
 *   · 含三个连续点的省略写法跳过——作者主动省略了中间目录，无法按字面解析；
 *   · 源文件在 docs/archive/ 的整篇豁免——归档是历史快照，改它等于篡改当时记录。
 *
 * 实现上刻意**不用正则匹配"带反引号的大表达式"**，而是按反引号切分取奇数段
 * （行内代码总是成对出现，奇数下标即代码段）。反引号在正则字面量里要转义，
 * 两层规则叠在一起既难读也容易写错——首版正是这么写坏的。
 */
const BACKTICK = String.fromCharCode(96);

const REPO_PATH_PREFIXES = ["docs/", "scripts/", "apps/", "packages/"];
const REPO_PATH_EXTS = [
  ".md", ".mjs", ".cjs", ".js", ".ts", ".tsx",
  ".sh", ".json", ".py", ".yml", ".yaml",
];

/** 去掉围栏代码块（按行状态机，不依赖正则转义）。 */
export function stripFencedCode(text) {
  const fence = BACKTICK + BACKTICK + BACKTICK;
  const kept = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith(fence)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n");
}

/** 取出一段 Markdown 里的所有行内代码内容（已剔除围栏块）。 */
export function extractInlineCode(text) {
  const parts = stripFencedCode(text).split(BACKTICK);
  return parts.filter((_, i) => i % 2 === 1);
}

/** 这段行内代码看起来是不是一个仓库相对路径？ */
export function looksLikeRepoPath(s) {
  const v = s.trim();
  if (!REPO_PATH_PREFIXES.some((p) => v.startsWith(p))) return false;
  if (v.includes(" ") || v.includes("*") || v.includes("<") || v.includes(">")) return false;
  return REPO_PATH_EXTS.some((e) => v.endsWith(e));
}

/**
 * 判据 ④：正文裸路径指针必须指向真实存在的文件。
 *
 * 解析顺序与判据 ①（链接）保持一致，否则会大量误伤**文档内相对路径**：
 * `apps/admin-web/lighthouserc.md` 里写的 `scripts/lhci-serve.cjs` 指的是
 * `apps/admin-web/scripts/lhci-serve.cjs`，不是仓库根的 `scripts/`。
 *   1) 先按仓库根解析（本仓多数证据指针是这种写法）；
 *   2) 再按文档所在目录解析（文档内相对引用）。
 *
 * 再叠加两类**写法约定**豁免：
 *   · 花括号简写（`src/routes/{execute,deploy}.ts`）——一条写多个文件，无法按字面解析；
 *   · 省略号（三个点或 `…`）——作者主动省略中间目录。
 * 这些不是"指针失效"，是"指针本来就是一组/一段"，强行展开只会让作者放弃写指针。
 */
export function checkBarePaths(root = REPO_ROOT) {
  const errors = [];
  for (const rel of listMarkdown(root)) {
    if (rel.startsWith("docs/archive/")) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const span of extractInlineCode(text)) {
      if (!looksLikeRepoPath(span)) continue;
      if (span.includes("...") || span.includes("…")) continue;
      if (span.includes("{") || span.includes("}")) continue;
      if (fs.existsSync(path.join(root, span))) continue;
      if (fs.existsSync(path.resolve(root, path.dirname(rel), span))) continue;
      errors.push(rel + " → " + span + "（正文裸路径指针指向不存在的文件）");
    }
  }
  return errors;
}

const CHECKS = {
  links: { run: checkLinks, label: "死链" },
  orphans: { run: checkOrphans, label: "孤儿文档" },
  "root-hygiene": { run: checkRootHygiene, label: "根目录洁癖" },
  "bare-paths": { run: checkBarePaths, label: "正文裸路径指针" },
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
