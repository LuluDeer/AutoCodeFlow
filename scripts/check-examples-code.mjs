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
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
printCoverageBanner(import.meta.url, "subprocess");

/** 本脚本自身的绝对路径 —— 黑盒 selftest 用 runGuard(SELF, ...) 起真子进程。 */
const SELF = fileURLToPath(import.meta.url);

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
 * 纯判据函数（保留导出；selftest 已改为真子进程 CLI 黑盒，不再进程内直调）。
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

/**
 * 内置 selftest（R-黑盒化）：每条用例都起**真子进程**跑本脚本 CLI
 * （`runGuard(SELF, ...)` + `expectExit`），不再进程内直调 `evaluate()`。
 *
 * 为什么必须黑盒：旧版只在内存里喂 `evaluate()` 假样本，`main()` 的失败
 * `return 1` 零覆盖 —— 把它改成 `return 0`，CLI 照样打印 ✘ 却 exit 0、CI 转绿，
 * 而旧 selftest 6/6 仍全绿（同族 categories / api-error-format /
 * agent-event-causation 已收口）。黑盒后「exit 0/1 + stdout/stderr」本身是断言面。
 *
 * ⚠️ 本守卫 main 的 `--root` 是**空格分离形态**（`argValue(argv, "--root")` →
 * `argv[i+1]`），不是 `--root=<dir>`，夹具一律用 `args: ["--root", dir]`。
 *
 * 六个夹具场景与旧版逐条对应（正常 / entrypoint 缺失 / runtime 不符 /
 * js 语法错 / json 数归零 / js 数归零），语义不变，只改「怎么调」。
 */
export function selftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  const N = Math.max(MIN_JSON, MIN_JS);
  const GOOD_JS = "module.exports = 1;\n";
  /** 健康夹具：N 个示例目录，每个都有 task.example.json + 真实 .js，runtime=node。 */
  const healthy = () => {
    const files = {};
    for (let i = 0; i < N; i++) {
      files[`examples/ex${i}/task.example.json`] = JSON.stringify({
        entrypoint: `examples/ex${i}/main.js`,
        runtime: "node",
      });
      files[`examples/ex${i}/main.js`] = GOOD_JS;
    }
    return files;
  };

  /** 起一个真子进程跑本脚本 CLI，断言退出码 + stdout/stderr 观测文本。 */
  const subprocess = (name, files, expectations) => {
    push(name, () => {
      const repo = makeFixtureRepo(files, { prefix: "examples-code-selftest-" });
      try {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          ...expectations,
          label: name,
        });
      } finally {
        repo.cleanup();
      }
    });
  };

  subprocess("正常样本全绿 ⇒ CLI exit 0（正例控制组）", healthy(), {
    code: 0,
    contains: ["✔ examples 代码/配置一致"],
    absent: ["✗ examples 代码/配置一致性失败", "结构红"],
  });

  subprocess(
    "entrypoint 文件不存在转红 ⇒ CLI exit 1 + 点名缺失路径",
    {
      ...healthy(),
      "examples/ex0/task.example.json": JSON.stringify({ entrypoint: "examples/ex0/missing.js", runtime: "node" }),
    },
    {
      code: 1,
      contains: ["✗ examples 代码/配置一致性失败", "entrypoint 指向的文件不存在", "examples/ex0/missing.js"],
      absent: ["✔ examples 代码/配置一致"],
    },
  );

  subprocess(
    "runtime 与扩展名不符转红 ⇒ CLI exit 1 + 点名 runtime/扩展名",
    {
      ...healthy(),
      "examples/ex0/task.example.json": JSON.stringify({ entrypoint: "examples/ex0/main.js", runtime: "python" }),
    },
    {
      code: 1,
      contains: ["✗ examples 代码/配置一致性失败", "runtime=python 要求 .py"],
      absent: ["✔ examples 代码/配置一致"],
    },
  );

  subprocess(
    "js 语法错转红 ⇒ CLI exit 1 + 报 node --check 失败",
    { ...healthy(), "examples/ex0/main.js": "function ( {\n" },
    {
      code: 1,
      contains: ["✗ examples 代码/配置一致性失败", "examples/ex0/main.js", "node --check 语法失败"],
      absent: ["✔ examples 代码/配置一致"],
    },
  );

  // 反假绿①：没有 task.example.json（.js 仍在）⇒ 扫到 0 份配置必须结构红。
  const noJson = {};
  for (let i = 0; i < N; i++) noJson[`examples/ex${i}/main.js`] = GOOD_JS;
  subprocess("反假绿：json 数归零转红 ⇒ CLI exit 1", noJson, {
    code: 1,
    contains: ["✗ examples 代码/配置一致性失败", "task.example.json 只扫到 0 份", "结构红"],
    absent: ["✔ examples 代码/配置一致"],
  });

  // 反假绿②：没有任何 .js（配置改用 python/.py 保持 entrypoint 真存在）⇒ 扫到 0 个 .js 必须结构红。
  const noJs = {};
  for (let i = 0; i < N; i++) {
    noJs[`examples/ex${i}/task.example.json`] = JSON.stringify({
      entrypoint: `examples/ex${i}/main.py`,
      runtime: "python",
    });
    noJs[`examples/ex${i}/main.py`] = "print('ok')\n";
  }
  subprocess("反假绿：js 数归零转红 ⇒ CLI exit 1", noJs, {
    code: 1,
    contains: ["✗ examples 代码/配置一致性失败", "示例 .js 只扫到 0 个", "结构红"],
    absent: ["✔ examples 代码/配置一致"],
  });

  const failed = reportCases(cases, { title: "check-examples-code selftest" });
  return failed === 0;
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
