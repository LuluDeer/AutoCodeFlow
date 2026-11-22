#!/usr/bin/env node
/**
 * check-examples-code.mjs —— 示例任务「代码 ↔ 配置」一致性守卫（R467）。
 *
 * 由来：`check:task-examples` 只守 task.example.json 的**载荷**符合 CreateTaskDto，
 * 从不检查配置里的 entrypoint 是否真存在、runtime 与代码语言是否匹配、.js 语法
 * 是否合法。用户照抄示例时，配错文件路径 / runtime 与脚本语言不符 / 语法错都会
 * 在执行器端才炸——而那需要真环境。本守卫用确定判据在提交前拦住这些。
 *
 * 判据（只判确定能判的）：
 *   A. 每个示例目录的 task.example.json 的 entrypoint 指向的文件真实存在；
 *   B. runtime 与 entrypoint 扩展名匹配（node→.js、python→.py）；
 *   C. 每个示例的 .js 任务代码通过 node --check。
 *
 * 反假绿：json 数 / .js 数 / entrypoint 检查数有下界；任一事实源读不到即结构红。
 * 退出码：0 通过 / 1 判据失败或结构错 / 2 未捕获异常。import 不实扫、不 exit。
 *
 * 用法：node scripts/check-examples-code.mjs [--selftest] [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { printCoverageBanner } from "./lib/agent-coverage.mjs";
printCoverageBanner(import.meta.url, "subprocess");

export const EXAMPLES_REL = "examples";
export const MIN_JSON = 7;
export const MIN_JS = 7;
const RUNTIME_EXT = { node: ".js", python: ".py" };

function listJsonFiles(examplesDir) {
  const out = [];
  for (const name of readdirSync(examplesDir)) {
    const p = join(examplesDir, name, "task.example.json");
    if (existsSync(p)) out.push(p);
  }
  return out.sort();
}

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
function walkJs(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    // R472 review：开发者在 examples/ 里 npm install 后 node_modules 有海量 .js，
    // 逐个 node --check 会误报（浏览器/方言语法）+ 分钟级子进程负担。显式跳过。
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkJs(p, out);
    } else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** 从 JSON 文本里抽顶层字符串字段（避免引入 JSON5/注释解析依赖；示例是标准 JSON）。 */
function field(jsonText, key) {
  const m = jsonText.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

/**
 * 纯判据函数（selftest 直接喂坏样本）。
 * inputs = { jsonFiles:[{rel,text}], jsFiles:[rel], fileExists:(rel)=>bool, syntaxOk:(rel)=>bool, root }
 */
export function evaluate(inputs) {
  const problems = [];
  const { jsonFiles, jsFiles, fileExists, syntaxOk } = inputs;
  if (jsonFiles.length < MIN_JSON) {
    problems.push(`结构红：task.example.json 只扫到 ${jsonFiles.length} 份（下界 ${MIN_JSON}）——扫描面退化`);
  }
  if (jsFiles.length < MIN_JS) {
    problems.push(`结构红：示例 .js 只扫到 ${jsFiles.length} 个（下界 ${MIN_JS}）——扫描面退化`);
  }
  let entryChecks = 0;
  for (const jf of jsonFiles) {
    let data;
    try { data = JSON.parse(jf.text); } catch (e) {
      problems.push(`${jf.rel}: JSON 解析失败 ${e.message}`);
      continue;
    }
    const entrypoint = field(jf.text, "entrypoint") ?? data.entrypoint;
    const runtime = field(jf.text, "runtime") ?? data.runtime;
    if (!entrypoint) { problems.push(`${jf.rel}: 缺 entrypoint`); continue; }
    entryChecks++;
    if (!fileExists(entrypoint)) {
      problems.push(`${jf.rel}: entrypoint 指向的文件不存在 — ${entrypoint}`);
    }
    const wantExt = RUNTIME_EXT[runtime];
    if (!wantExt) {
      problems.push(`${jf.rel}: 未知 runtime「${runtime}」（无法判扩展名）`);
    } else if (!entrypoint.endsWith(wantExt)) {
      problems.push(`${jf.rel}: runtime=${runtime} 要求 ${wantExt}，但 entrypoint 是 ${entrypoint}`);
    }
  }
  if (jsonFiles.length >= MIN_JSON && entryChecks !== jsonFiles.length) {
    problems.push(`结构红：entrypoint 检查 ${entryChecks}/${jsonFiles.length}——不得静默跳过`);
  }
  for (const js of jsFiles) {
    if (!syntaxOk(js)) problems.push(`${js}: node --check 语法失败`);
  }
  return { ok: problems.length === 0, problems, stats: { json: jsonFiles.length, js: jsFiles.length, entryChecks } };
}

/** 实扫仓库。 */
export function check({ root = process.cwd() } = {}) {
  const examplesDir = join(root, EXAMPLES_REL);
  if (!existsSync(examplesDir)) {
    return { ok: false, problems: [`结构红：examples/ 目录不存在（root=${root}）`], stats: { json: 0, js: 0, entryChecks: 0 } };
  }
  const jsonFiles = listJsonFiles(examplesDir).map((p) => ({
    rel: p.slice(root.length + 1),
    text: readFileSync(p, "utf8"),
  }));
  const jsFiles = walkJs(examplesDir).map((p) => p.slice(root.length + 1));
  return evaluate({
    jsonFiles,
    jsFiles,
    fileExists: (rel) => existsSync(join(root, rel)),
    syntaxOk: (rel) => {
      try { execFileSync(process.execPath, ["--check", join(root, rel)], { stdio: "ignore" }); return true; }
      catch { return false; }
    },
  });
}

/** 内置 selftest：用内存坏样本直接打 evaluate 的判据，不碰文件系统。 */
export function selftest() {
  const goodJson = (entry, rt) => ({ rel: "ex/task.example.json", text: JSON.stringify({ entrypoint: entry, runtime: rt }) });
  const base = (over = {}) => ({
    jsonFiles: Array.from({ length: MIN_JSON }, (_, i) => goodJson(`ex${i}/main.js`, "node")),
    jsFiles: Array.from({ length: MIN_JS }, (_, i) => `ex${i}/main.js`),
    fileExists: () => true,
    syntaxOk: () => true,
    ...over,
  });
  const cases = [
    ["正常样本全绿", () => evaluate(base()), true],
    ["entrypoint 文件不存在转红", () => evaluate(base({ fileExists: (rel) => !rel.includes("ex0/") })), false],
    ["runtime 与扩展名不符转红", () => {
      const jf = base().jsonFiles.map((x, i) => i === 0 ? goodJson("ex0/main.js", "python") : x);
      return evaluate(base({ jsonFiles: jf }));
    }, false],
    ["js 语法错转红", () => evaluate(base({ syntaxOk: (rel) => !rel.includes("ex0/") })), false],
    ["反假绿：json 数归零转红", () => evaluate(base({ jsonFiles: [] })), false],
    ["反假绿：js 数归零转红", () => evaluate(base({ jsFiles: [] })), false],
  ];
  let pass = 0;
  for (const [name, fn, wantOk] of cases) {
    let got;
    try { got = fn(); } catch (e) { got = { ok: false, problems: [e.message] }; }
    const ok = got.ok === wantOk;
    console.log(`  ${ok ? "✓" : "✘"} ${name}${ok ? "" : ` — 期望 ok=${wantOk} 实得 ${got.ok}: ${got.problems.join(";")}`}`);
    if (ok) pass++;
  }
  console.log(`\nSELFTEST ${pass}/${cases.length} 通过` + (pass === cases.length ? "（全部符合预期）" : "（有用例不通过）"));
  return pass === cases.length;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest() ? 0 : 1;
  const root = resolve(argValue(argv, "--root") ?? process.cwd());
  const r = check({ root });
  if (!r.ok) {
    console.error(`✗ examples 代码/配置一致性失败（json=${r.stats.json} js=${r.stats.js} entryChecks=${r.stats.entryChecks}）：`);
    for (const p of r.problems) console.error(`  · ${p}`);
    return 1;
  }
  console.log(`✔ examples 代码/配置一致：${r.stats.json} 份配置 entrypoint 全存在且 runtime 匹配，${r.stats.js} 个 .js 语法通过`);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invoked) {
  try { process.exit(main()); }
  catch (e) { console.error("check-examples-code 结构错:", e.message); process.exit(2); }
}
