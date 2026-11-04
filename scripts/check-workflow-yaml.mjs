#!/usr/bin/env node
// WORKFLOW-YAML：`.github/workflows/*.yml|*.yaml` 的**语法可解析性**守卫。
//
// ## 为什么需要它（这不是假设，是 2026-11-04 实际发生的事故）
//
// commit `14209744` 往 `ci.yml` 加了一个 step，step 名里带 `report-only: plan`：
//
//     - name: Spec coupling surfaces (report-only: plan before moving a cluster)
//
// **YAML 规范禁止**「未加引号的纯量里出现 `: `（冒号+空格）」——解析器会认为那是
// 新的映射键。于是**整个 `ci.yml` 解析失败** ⇒ GitHub 侧 **38 个 job 一个都不跑**。
//
// 而当时**本仓所有守卫全绿**：没有任何守卫读 workflow 的 YAML 语法，
// `check-runner-labels` / `check-actions-pinned` / `check-image-pinned` 都是**按行正则**扫，
// 不需要文件可解析。⇒ **CI 整体失效时，所有绿都是假的。**
//
// 这个失效形态在方法论上是「守卫关灯」的极端版：不是某条判据失灵，而是**判据的执行者
// （CI）本身没了**。所以本守卫的价值不在于"多一条检查"，而在于**它守的是"检查还能不能跑"**。
//
// ## 两层判据
//
// **① 语法层（主）**：每个 workflow 文件必须能被 YAML 解析器解析。
//   **零依赖**：本仓 `node_modules/js-yaml` **并不存在**（实测），而既有守卫
//   （`check-protocol-three-way`）已确立「用**裸 `python3` + PyYAML** 做零依赖解析」的先例
//   ⇒ 本守卫照此办理，**不新增任何 npm 依赖**（CI 只保证 node，不保证 python/PyYAML）。
//   ⇒ 解析器不可用时 ⇒ **结构红**（不是跳过：跳过等于关灯）。
//
// **② 针对性层（补语法层抓不到的"侥幸"）**：抓「未加引号的纯量里含 `: `」这一形态并**点名行号**。
//   语法层已经会红，但解析器的报错是 `line N, column M`，不告诉你**是哪个字段**；
//   而且不同解析器/版本对同一输入的容忍度不同（实测 python `yaml.safe_load` 与
//   `js-yaml` 这次都在同一处炸，但这不是保证）。⇒ 针对性检查给出**可直接修的那一行**。
//
// ## 已知局限（如实）
//
// · 针对性层只覆盖 `name:` 一类（workflow 里最容易写错、也是本次事故的形态）。
//   其它键未加引号含 `: ` 的情况**靠语法层兜住**（会红，但报错不如针对性层精确）。
// · 不校验 GitHub Actions 的 schema（`uses:` 是否存在、`on:` 是否合法）——
//   那是另一条守卫的事；这条只保证"文件能被解析"。
//
// 用法：
//   node scripts/check-workflow-yaml.mjs              # 检查真实仓库
//   node scripts/check-workflow-yaml.mjs --selftest   # 验证判据本身
//   node scripts/check-workflow-yaml.mjs --root <dir> # selftest 专用
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = join(HERE, "..");
const WORKFLOW_DIR = ".github/workflows";

/**
 * 未加引号的纯量里含 `: `（冒号+空格）或**以 `:` 结尾** ⇒ YAML 禁止。
 *
 * 只查 `name:` 一类键的理由见文件头「已知局限」：它是 workflow 里最常见、也是
 * 2026-11-04 事故的实际形态；其余键由语法层兜底。
 *
 * 跳过的三类（都会产生假红）：
 * · 已加引号的值（`name: 'a: b'` / `name: "a: b"`）
 * · 注释行与行尾注释
 * · 块标量内部（`run: |` / `run: >` 之后缩进更深的内容，里面的冒号是脚本/文案，正常）
 */
export function findUnquotedColonValues(text) {
  const findings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let blockIndent = -1; // 块标量体内：> = 正在块里，缩进需比它深
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    // 块标量体：缩进比块标量键更深（或空行）⇒ 跳过
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^\s*#/.test(line)) continue; // 注释行
    const m = /^(\s*(?:-\s+)?)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[3];
    // 块标量开始：`|` / `>`（可带 +/- 与缩进指示）
    if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(value.trim())) {
      blockIndent = indent;
      continue;
    }
    if (value === "") continue; // 空值（嵌套块/下一行）——语法层负责
    const bare = value.split(/\s+#/)[0].trimEnd(); // 剥行尾注释
    const quoted = /^['"]/.test(bare);
    if (quoted) continue;
    // 冒号+空格、或以冒号结尾 ⇒ YAML 会当成映射
    if (/: /.test(bare) || /:$/.test(bare)) {
      findings.push({
        line: i + 1,
        key: m[2],
        value: bare,
        why: /:$/.test(bare)
          ? "未加引号的值以冒号结尾 ⇒ YAML 会把它当成映射键"
          : "未加引号的纯量里含「冒号+空格」⇒ YAML 会把它当成映射键",
      });
    }
  }
  return findings;
}

/**
 * 解析器：**裸 `python3` + PyYAML**（零 npm 依赖）。
 *
 * 为什么不用 `js-yaml`：本仓 `node_modules/js-yaml` **实测不存在**，而既有守卫
 * （`check-protocol-three-way`）已确立「裸 python3 + PyYAML」这条零依赖先例 ⇒ 照此办理。
 * 一次调用解析**全部**文件（避免每个文件起一次进程）。
 *
 * @returns {{ok: true, parse: (text: string) => {ok: boolean, message?: string}}
 *          |{ok: false, why: string}}
 */
function resolveParser() {
  const probe = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" });
  if (probe.error) {
    return { ok: false, why: `python3 不可用（${probe.error.code ?? probe.error.message}）` };
  }
  if (probe.status !== 0) {
    return { ok: false, why: "python3 存在但没有 PyYAML（import yaml 失败）" };
  }
  return { ok: true, parse: (text) => parseWithPython(text) };
}

/**
 * 用一次 python 调用解析一段 YAML 文本。
 * @param {string} text
 * @returns {{ok: boolean, message?: string}}
 */
function parseWithPython(text) {
  const py = [
    "import sys, yaml",
    "try:",
    "    yaml.safe_load(sys.stdin.read())",
    "    print('OK')",
    "except Exception as e:",
    "    msg = str(e).split(chr(10))[0]",
    "    print('ERR:' + msg)",
  ].join("\n");
  const r = spawnSync("python3", ["-c", py], { input: text, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return { ok: false, message: `解析器异常：${String(r.stderr ?? r.error?.message ?? "").split("\n")[0]}` };
  }
  const out = (r.stdout ?? "").trim();
  if (out === "OK") return { ok: true };
  return { ok: false, message: out.startsWith("ERR:") ? out.slice(4) : out || "未知解析错误" };
}

/** 取 workflow 文件列表（相对 root 的 POSIX 路径）。 */
export function listWorkflows(rootDir) {
  const dir = join(rootDir, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `${WORKFLOW_DIR}/${f}`);
}

/**
 * 主检查。
 *
 * @param {{root?: string}} [opts]
 * @returns {{errors: string[], structure: string[], files: string[]}}
 *   `structure` = 判据不可信（解析器缺失 / 工作流目录塌陷）；`errors` = 真问题。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const structure = [];
  const files = listWorkflows(root);
  if (files.length === 0) {
    structure.push(
      `读不到任何 workflow 文件（${WORKFLOW_DIR} 下没有 .yml/.yaml）—— ` +
        `扫描面塌陷会让本守卫变成"零命中全绿"，这是关灯形态。`,
    );
    return { errors, structure, files };
  }
  // 解析器：裸 `python3` + PyYAML（**零 npm 依赖**，与 `check-protocol-three-way` 同一先例）。
  // 不可用 ⇒ 结构红（跳过 = 关灯）。
  const parser = resolveParser();
  if (!parser.ok) {
    structure.push(
      `YAML 解析器不可用（${parser.why}）—— 语法层无法执行。` +
        "**不要**因此跳过：跳过等于把这条守卫关灯。" +
        "本仓零依赖先例是「裸 python3 + PyYAML」（见 check-protocol-three-way）；" +
        "若 CI 环境确实没有 python3/PyYAML，请改用其它零依赖方案，但**不允许**降级为" +
        "「只做针对性检查」而不报结构错。",
    );
  }
  for (const rel of files) {
    const text = readFileSync(join(root, rel), "utf-8");
    // ① 语法层
    if (parser.ok) {
      const r = parser.parse(text);
      if (!r.ok) {
        errors.push(
          `${rel}: **YAML 解析失败** —— ${r.message}。` +
            `整个 workflow 文件不会被 GitHub 接受 ⇒ **该文件里的所有 job 都不跑**。`,
        );
      }
    }
    // ② 针对性层
    for (const f of findUnquotedColonValues(text)) {
      errors.push(
        `${rel}:${f.line} \`${f.key}:\` 的值 \`${f.value}\` ${f.why}。` +
          `修法：整个值加引号（\`${f.key}: '${f.value}'\`）。`,
      );
    }
  }
  return { errors, structure, files };
}

/**
 * 主入口。
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  // 覆盖计数哨兵：判据④靠这一行判断「这个守卫还有没有用例」。
  // ⚠️ 必须在**任何**早退之前打印（含结构错路径）—— 计数不出来就报 0，哨兵会结构红。
  printCoverageBanner(import.meta.url, "expectExit");
  if (argv.includes("--selftest")) return selftest();
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : REPO_ROOT;
  const { errors, structure, files } = check({ root });
  if (structure.length > 0) {
    console.error("✖ workflow 语法守卫的结构错（判据不可信）：");
    for (const s of structure) console.error(`  · ${s}`);
    return 1;
  }
  if (errors.length > 0) {
    console.error(`✖ ${errors.length} 处 workflow 语法问题：`);
    for (const e of errors) console.error(`  · ${e}`);
    console.error(
      "  历史教训（2026-11-04）：一处非法 YAML ⇒ 整个 ci.yml 解析失败 ⇒ 38 个 job 全不跑，" +
        "而当天所有守卫仍然全绿。",
    );
    return 1;
  }
  console.log(
    `✔ ${files.length} 个 workflow 全部可解析，且无可疑的未加引号冒号值（${files.join(" / ")}）`,
  );
  return 0;
}

function selftest() {
  const GUARD = join(HERE, "check-workflow-yaml.mjs");
  /** 造一个 fixture 仓库并跑守卫（--root 指过去）。 */
  const runOn = (files) => {
    const repo = makeFixtureRepo({
      "package.json": JSON.stringify({ name: "fixture" }),
      ...files,
    });
    const result = runGuard(GUARD, { args: ["--root", repo.dir] });
    return { result, cleanup: repo.cleanup };
  };

  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  // ① 未加引号的 `: ` ⇒ 红（2026-11-04 的真实形态）
  add("① 未加引号的「冒号+空格」⇒ 红（2026-11-04 事故形态）", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: X (report-only: plan before)\n        run: echo hi\n",
    });
    try {
      expectExit(result, { code: 1, contains: ["report-only: plan"] });
    } finally {
      cleanup();
    }
  });

  // ② 已加引号 ⇒ 绿
  add("② 已加引号 ⇒ 绿", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: 'X (report-only: plan before)'\n        run: echo hi\n",
    });
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  // ③ `run: |` 块标量里的冒号 ⇒ 绿（不误报）
  add("③ `run: |` 块标量里的冒号 ⇒ 绿（不误报）", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - run: |\n          echo 'a: b'\n          echo c: d\n",
    });
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  // ④ 注释里的冒号 ⇒ 绿（不误报）
  add("④ 注释里的冒号 ⇒ 绿（不误报）", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "# note: comment with colon\njobs:\n  a:\n    steps:\n      - run: echo hi\n",
    });
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  // ⑤ 未加引号的值以冒号结尾 ⇒ 红
  add("⑤ 未加引号的值以冒号结尾 ⇒ 红", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: label:\n        run: echo hi\n",
    });
    try {
      expectExit(result, { code: 1 });
    } finally {
      cleanup();
    }
  });

  // ⑥ 扫描面塌陷（没有 workflow 目录）⇒ 红（不是"零命中全绿"）
  add("⑥ 扫描面塌陷（无 workflow 目录）⇒ 红（防空转）", () => {
    const repo = makeFixtureRepo({ "package.json": JSON.stringify({ name: "f" }) });
    try {
      const result = runGuard(GUARD, { args: ["--root", repo.dir] });
      expectExit(result, { code: 1, contains: ["扫描面塌陷"] });
    } finally {
      repo.cleanup();
    }
  });

  // ⑦ 语法层真的会抓「结构性非法 YAML」（不是只有针对性层在抓）
  add("⑦ 结构性非法 YAML（缩进错乱）⇒ 语法层红", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - run: echo hi\n   bad_indent: 1\n",
    });
    try {
      expectExit(result, { code: 1, contains: ["YAML 解析失败"] });
    } finally {
      cleanup();
    }
  });

  // ⑧ 真实仓库 ⇒ 绿（控制组）
  add("⑧ 真实仓库 ⇒ 绿（控制组）", () => {
    expectExit(runGuard(GUARD, { args: ["--root", REPO_ROOT] }), { code: 0 });
  });

  const failed = reportCases(cases, { title: "check-workflow-yaml" });
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
