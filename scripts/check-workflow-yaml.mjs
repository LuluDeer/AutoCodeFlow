#!/usr/bin/env node
/**
 * WORKFLOW-YAML：`.github/workflows/*.yml|*.yaml` 的**语法可解析性**守卫。
 *
 * ## 为什么需要它（这不是假设，是 2026-11-04 实际发生的事故）
 *
 * commit `14209744` 往 `ci.yml` 加了一个 step，step 名里带 `report-only: plan`：
 *
 *     - name: Spec coupling surfaces (report-only: plan before moving a cluster)
 *
 * **YAML 规范禁止**「未加引号的纯量里出现 `: `（冒号+空格）」——解析器会认为那是
 * 新的映射键。于是**整个 `ci.yml` 解析失败** ⇒ GitHub 侧**所有 job 一个都不跑**。
 *
 * 而当时**本仓所有守卫全绿**：没有任何守卫读 workflow 的 YAML 语法，
 * `check-runner-labels` / `check-actions-pinned` / `check-image-pinned` 都是**按行正则**扫，
 * 不需要文件可解析。⇒ **CI 整体失效时，所有绿都是假的。**
 *
 * 这个失效形态在方法论上是「守卫关灯」的极端版：不是某条判据失灵，而是**判据的执行者
 * （CI）本身没了**。所以本守卫的价值不在于「多一条检查」，而在于**它守的是「检查还能不能跑」**。
 *
 * ## 两层判据
 *
 * **① 语法层（主）**：每个 workflow 文件必须能被**真正的 YAML 解析器**解析。
 *   **零新增依赖**：按优先级探测机器上**已有**的解析器（见下），第一个可用的就用它。
 *   **一个都不可用 ⇒ 结构红**（不是跳过：跳过等于关灯）。
 *
 * **② 针对性层（本守卫的主要价值，补语法层的不足）**：抓「未加引号的纯量里含 `: `」
 *   这一类错误，并**点名行号与原文**。语法层已经会红，但解析器的报错是
 *   `line N, column M`，不告诉你**是哪个字段**；而且不同解析器/版本对同一输入的
 *   容忍度不同 ⇒ 针对性检查给出**可直接照抄的那一行**。
 *   这层**不依赖任何解析器** ⇒ 即使一台机器上没有任何 YAML 库，它照样抓得住。
 *
 * ## 语法层用哪个解析器（**零新增依赖**，按优先级探测）
 *
 * **不自己写 YAML 解析器**——手写 YAML 解析器不可能做对，写出来的是「看起来在
 * 校验」的假闸，比没有闸更坏。所以本脚本**借用**机器上已有的解析器：
 *
 *   1. **js-yaml**（node）——`js-yaml@5.5.0` 是 `apps/admin-api` 的**既有直接依赖**
 *      （`apps/admin-api/package.json` 的 dependencies 里就是 `5.5.0`），仓库自己的
 *      `apps/admin-api/src/modules/sop/sop-frontmatter.ts` 也在 `import { load } from
 *      "js-yaml"`。本脚本用 `createRequire` 从 app 本地 `node_modules` 加载它——
 *      **不新增依赖、不改任何 package.json**。注意**仓库根没有依赖**（根 package.json
 *      的 dependencies 是空的，本仓是「不 hoisting」的安装模型，见 ARCH-20），所以
 *      裸 `require("js-yaml")` **必然失败**，必须按 app 解析。
 *   2. **PyYAML**（`python3`）——本机/多数 CI 镜像里有；本仓已有「裸 python3」先例
 *      （`check-protocol-three-way` / `check-failure-classifiers`）。
 *   3. **yq**（mikefarah/yq v4，go-yaml）——**GitHub 官方 runner 镜像自带**
 *      （Ubuntu 24.04 镜像清单里就有 `yq 4.54.1`）。
 *   4. **Ruby + Psych**（`ruby`）——runner 镜像自带 Ruby 3.2，Psych 是**标准库**；
 *      `Psych.parse` 只建 AST 不建对象，是纯语法校验。
 *
 * **为什么要 4 个候选（而不是只用 js-yaml 或只用 PyYAML）——这是实测出来的硬约束**：
 * 本守卫的 CI 落点（`ci.yml` 的守卫 job `check-migrations`）**没有 `npm ci`** ⇒ 那里
 * **没有 node_modules** ⇒ **js-yaml 在 CI 里不可用**；而 runner 镜像的 apt 包清单里
 * **没有 `python3-yaml`** ⇒ **PyYAML 在 CI 里也不可靠**。只押一个解析器 ⇒ 一旦它不在，
 * 守卫就退化成结构红 ⇒ **CI 被我自己的守卫打红**（那比没守卫更坏）。
 * 四候选里 js-yaml 与 PyYAML 覆盖本地与多数 CI，yq 与 Ruby Psych 覆盖 GitHub 官方
 * runner ⇒ **至少一个总在**。
 *
 * ## 已知局限（如实）
 *
 * · 针对性层只覆盖**简单键**（`name:` / `run:` / `uses:` 这类）。带引号的键
 *   （`"a": b: c`）不被扫；**语法层兜底**（会红，但报错不如针对性层精确）。
 * · 针对性层**不校验 GitHub Actions 的 schema**（`uses:` 是否存在、`on:` 是否合法）——
 *   那是另一条守卫的事；本守卫只保证「文件能被解析」。
 * · 语法层的判定**依赖被探测到的解析器**（不同实现的严格度略有差异：例如 js-yaml
 *   报「重复键」而 PyYAML 默认允许）。本仓现状（10 个 workflow）在
 *   **js-yaml@5.5.0 与 PyYAML 两种解析器下都解析通过**（实测，见头注）。
 *
 * 用法：
 *   node scripts/check-workflow-yaml.mjs              # 检查真实仓库
 *   node scripts/check-workflow-yaml.mjs --selftest   # 验证判据本身
 *   node scripts/check-workflow-yaml.mjs --root <dir> # selftest 专用
 *
 * 退出码（**四个**，调用方能分辨「什么坏了」）：
 *   0 = 通过；1 = **有违规**（语法错 / 未加引号的冒号纯量）——「东西坏了」；
 *   2 = **结构红**（扫描面塌方 / 一个解析器都找不到）——「**根本没判**」；
 *   3 = 自检失败；4 = 用法错误。
 *   1 与 2 必须分开：CI 红了但分不清是「workflow 写错了」还是「守卫瞎了」时，
 *   后者该修守卫而不是改 workflow。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
/** 仓库根：`<repo>/scripts/check-workflow-yaml.mjs` 往上一级。 */
const REPO_ROOT = resolve(HERE, "..");
const WORKFLOW_DIR = ".github/workflows";

/** 扫描面下界：workflow 文件数（本仓现 10 个）。目录改名 / glob 失配 ⇒ 结构红。 */
const MIN_WORKFLOW_FILES = 5;
/** 扫描面下界：判据②真正逐行看过的映射项数（正则失配 ⇒ 「0 处违规」是假绿）。 */
const MIN_SCALARS = 20;

/* ═════════════════════ 判据②：未加引号的纯量里含 `: ` ═════════════════════ */

/**
 * 未加引号的纯量里含 `: `（冒号+空格）或**以 `:` 结尾** ⇒ YAML 规范禁止。
 *
 * 跳过的形态（每一条都有理由，漏掉任何一条都会产生**假红**）：
 * · 已加引号的值（`name: 'a: b'` / `name: "a: b"`）——加了引号就是安全的；
 * · 注释行与行尾注释（`# ...`）；
 * · **块标量内部**（`run: |` / `>` 之后缩进更深的内容）——多行块里的冒号是**正常的**
 *   （`echo "::error::x: y"`、`-H "Accept: application/json"` 这类）；
 * · **流式集合**（`{...}` / `[...]`）——`{B: 1}` / `[a: b]` 里的冒号是**合法的**
 *   （流式上下文里冒号后面可以跟空格）；
 * · 空值（`key:` 后换行的嵌套映射）——由语法层负责。
 */
export function findUnquotedColonValues(text) {
  const findings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let blockIndent = -1; // 块标量体内：> = 正在块里，缩进需比它深
  let scalarsChecked = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    // 块标量体：缩进比块标量键更深（或空行）⇒ 跳过
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^\s*#/.test(line)) continue; // 注释行
    const m = /^(\s*(?:-\s+)?)([A-Za-z_][\w.\-/]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[3];
    // 块标量开始：`|` / `>`（可带 +/- 与缩进指示，可带行尾注释）
    if (/^[|>][-+]?\d*\s*(?:#.*)?$/.test(value.trim()) || /^[|>]\d*[+-]?\s*(?:#.*)?$/.test(value.trim())) {
      blockIndent = indent;
      continue;
    }
    const bare = value.split(/\s+#/)[0].trim(); // 剥行尾注释
    if (bare === "") continue; // 空值（嵌套块 / 下一行）——语法层负责
    scalarsChecked += 1;
    if (/^['"]/.test(bare)) continue; // 已加引号 ⇒ 安全
    if (bare.startsWith("{") || bare.startsWith("[")) continue; // 流式集合 ⇒ 冒号合法
    // 冒号+空格、或以冒号结尾 ⇒ YAML 会把它当成映射键
    if (/: /.test(bare) || /:$/.test(bare)) {
      findings.push({
        line: i + 1,
        key: m[2],
        value: bare,
        raw: line.trim(),
        why: /:$/.test(bare)
          ? "未加引号的值以冒号结尾 ⇒ YAML 会把它当成映射键"
          : "未加引号的纯量里含「冒号+空格」⇒ YAML 会把它当成映射键",
      });
    }
  }
  return { findings, scalarsChecked };
}

/* ═══════════════════════ 语法层：解析器探测 ═══════════════════════ */

/** js-yaml 的探测目录：仓库根（无依赖）+ 各 app 的本地 node_modules。 */
const JS_YAML_PROBE_DIRS = [
  "",
  "apps/admin-api",
  "apps/executor-node",
  "apps/executor-desktop",
  "apps/admin-web",
  "packages/autocodeflow-node-sdk",
];

/**
 * 探测 js-yaml（本仓**既有依赖**，不新增）。
 *
 * 注意：本仓是「不 hoisting」的安装模型（ARCH-20）⇒ **仓库根没有依赖**，
 * 裸 `require("js-yaml")` 必然失败 ⇒ 必须用 `createRequire` 从 app 本地解析。
 */
function tryJsYaml(root) {
  for (const rel of JS_YAML_PROBE_DIRS) {
    const anchor = join(root, rel, "node_modules", "acf-probe.js");
    try {
      const req = createRequire(anchor);
      const mod = req("js-yaml");
      if (typeof mod?.load !== "function") continue;
      const version = req("js-yaml/package.json").version;
      return {
        kind: "js-yaml",
        detail: `js-yaml@${version}${rel ? `（${rel}/node_modules）` : "（仓库根）"}`,
        parse(text) {
          try {
            mod.load(text);
            return { ok: true };
          } catch (error) {
            const mark = error?.mark;
            return {
              ok: false,
              message: String(error?.reason ?? error?.message ?? error),
              line: typeof mark?.line === "number" ? mark.line + 1 : null,
            };
          }
        },
      };
    } catch {
      // 试下一个目录
    }
  }
  return null;
}

/**
 * 探测 PyYAML（裸 python3）。
 *
 * 用**临时文件**而不是 stdin/argv 传内容：ci.yml 有 100 KB 级，
 * 全塞进 argv 会撞 ARG_MAX。
 */
const PY_PROBE = `
import sys, json, yaml
out = []
for path in json.loads(sys.argv[1]):
    try:
        with open(path, encoding="utf-8") as fh:
            yaml.safe_load(fh.read())
        out.append({"ok": True})
    except Exception as exc:
        mark = getattr(exc, "problem_mark", None)
        out.append({
            "ok": False,
            "message": (getattr(exc, "problem", None) or str(exc)).replace("\\n", " "),
            "line": (mark.line + 1) if mark is not None else None,
        })
print(json.dumps({"results": out}))
`;

function tryPythonYaml() {
  const probe = spawnSync("python3", ["-c", "import yaml; print(yaml.__version__)"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return null;
  const version = String(probe.stdout ?? "").trim();
  return {
    kind: "python",
    detail: `PyYAML@${version}（python3）`,
    parseFiles(paths) {
      const run = spawnSync("python3", ["-c", PY_PROBE, JSON.stringify(paths)], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (run.error || run.status !== 0) {
        return paths.map(() => ({ ok: false, message: "python3 解析失败", line: null }));
      }
      try {
        const parsed = JSON.parse(String(run.stdout ?? ""));
        return parsed.results ?? paths.map(() => ({ ok: false, message: "python3 无结果", line: null }));
      } catch {
        return paths.map(() => ({ ok: false, message: "python3 输出不可解析", line: null }));
      }
    },
  };
}

/**
 * 探测 yq（mikefarah/yq，go-yaml）——GitHub 官方 runner 镜像自带。
 *
 * v4 的语法是 `yq eval . f`，v3 是 `yq . f` ⇒ 按版本号选，别猜。
 */
function tryYq() {
  const probe = spawnSync("yq", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  const raw = String(probe.stdout ?? probe.stderr ?? "").trim();
  const version = raw.split("\n")[0];
  const isV4 = /\bv4\b/.test(raw);
  const argsFor = (file) => (isV4 ? ["eval", ".", file] : [".", file]);
  return {
    kind: "yq",
    detail: `yq ${version}`,
    parseFiles(paths) {
      return paths.map((file) => {
        const run = spawnSync("yq", argsFor(file), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        if (!run.error && run.status === 0) return { ok: true };
        const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().replace(/\s+/g, " ");
        const at = /\((\d+):(\d+)\)/.exec(out);
        return {
          ok: false,
          message: out.slice(0, 300) || "yq 解析失败",
          line: at ? Number(at[1]) : null,
        };
      });
    },
  };
}

/** 探测 Ruby + Psych（runner 镜像自带 Ruby，Psych 是标准库）。 */
const RUBY_PROBE = `
require "psych"
require "json"
results = []
JSON.parse(ARGV[0]).each do |path|
  begin
    Psych.parse_file(path)
    results << {"ok" => true}
  rescue Psych::SyntaxError => exc
    results << {
      "ok" => false,
      "message" => "#{exc.problem}#{exc.context ? " (#{exc.context})" : ""}",
      "line" => exc.line,
    }
  rescue => exc
    results << {"ok" => false, "message" => exc.message, "line" => nil}
  end
end
puts JSON.generate({"results" => results})
`;

function tryRubyYaml() {
  const probe = spawnSync("ruby", ["-e", "require 'psych'; puts Psych::VERSION"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  const version = String(probe.stdout ?? "").trim();
  return {
    kind: "ruby",
    detail: `Ruby Psych@${version}`,
    parseFiles(paths) {
      const run = spawnSync("ruby", ["-e", RUBY_PROBE, JSON.stringify(paths)], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (run.error || run.status !== 0) {
        return paths.map(() => ({ ok: false, message: "ruby 解析失败", line: null }));
      }
      try {
        const parsed = JSON.parse(String(run.stdout ?? ""));
        return parsed.results ?? paths.map(() => ({ ok: false, message: "ruby 无结果", line: null }));
      } catch {
        return paths.map(() => ({ ok: false, message: "ruby 输出不可解析", line: null }));
      }
    },
  };
}

/** 按优先级探测可用解析器：js-yaml → PyYAML → yq → Ruby Psych。 */
export function detectParser(root) {
  return tryJsYaml(root) ?? tryPythonYaml() ?? tryYq() ?? tryRubyYaml() ?? null;
}

/* ════════════════════════════ 主检查 ════════════════════════════ */

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
 * @returns {{errors: string[], structure: string[], files: string[], scalars: number,
 *            parser: string|null}}
 *   `structure` = 判据不可信（解析器缺失 / workflow 目录塌陷 / 扫描面塌方）；
 *   `errors` = 真问题。
 */
export function check({ root = REPO_ROOT } = {}) {
  const errors = [];
  const structure = [];
  const files = listWorkflows(root);
  if (files.length === 0) {
    structure.push(
      `读不到任何 workflow 文件（${WORKFLOW_DIR} 下没有 .yml/.yaml）—— ` +
        `扫描面塌陷会让本守卫变成「零命中全绿」，这是关灯形态。`,
    );
    return { errors, structure, files, scalars: 0, parser: null };
  }
  if (files.length < MIN_WORKFLOW_FILES) {
    structure.push(
      `扫描面塌方：只扫到 ${files.length} 个 workflow（下界 ${MIN_WORKFLOW_FILES}）—— ` +
        `目录改名或 glob 失配时，「0 处违规」不是「没有违规」。`,
    );
  }

  const texts = [];
  for (const rel of files) {
    try {
      texts.push(readFileSync(join(root, rel), "utf-8"));
    } catch (error) {
      structure.push(`读不到 workflow：${rel}（${error?.message ?? error}）`);
      texts.push("");
    }
  }

  // ── 判据②：针对性层（**不依赖任何解析器**）─────────────────────
  let scalars = 0;
  files.forEach((rel, index) => {
    const { findings, scalarsChecked } = findUnquotedColonValues(texts[index]);
    scalars += scalarsChecked;
    for (const f of findings) {
      errors.push(
        `${rel}:${f.line} \`${f.key}:\` 的值 \`${f.value}\` ${f.why}。` +
          `修法：整个值加引号（\`${f.key}: '${f.value}'\`）。`,
      );
    }
  });
  if (scalars < MIN_SCALARS) {
    structure.push(
      `扫描面塌方：判据②只逐行看了 ${scalars} 个映射项（下界 ${MIN_SCALARS}）—— ` +
        `正则失配时「0 处违规」是假绿。`,
    );
  }

  // ── 判据①：语法层（**真解析器**，逐个文件）─────────────────────
  const parser = detectParser(root);
  if (!parser) {
    structure.push(
      "一个 YAML 解析器都找不到（试过 js-yaml / PyYAML / yq / Ruby Psych）—— " +
        "语法层**无法执行**，判据现在是瞎的。按「判据瞎了就是红」判结构红，" +
        "**绝不**降级为「只做针对性检查」而报绿（那正是本次事故的形态）。",
    );
  } else {
    let results;
    if (typeof parser.parse === "function") {
      results = texts.map((text) => parser.parse(text));
    } else {
      // 子进程解析器走临时文件（ci.yml 有 100 KB 级，argv 会撞 ARG_MAX）
      const scratch = mkdtempSync(join(tmpdir(), "acf-workflow-yaml-"));
      try {
        const paths = files.map((rel, i) => {
          const p = join(scratch, `w${i}.yml`);
          writeFileSync(p, texts[i], "utf8");
          return p;
        });
        results = parser.parseFiles(paths);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    files.forEach((rel, index) => {
      const result = results[index] ?? { ok: false, message: "解析器没有给出结果", line: null };
      if (result.ok) return;
      const where = result.line ? `${rel}:${result.line}` : rel;
      errors.push(
        `${where} **YAML 解析失败** —— ${result.message}。` +
          `整个 workflow 文件不会被 GitHub 接受 ⇒ **该文件里的所有 job 都不跑**。`,
      );
    });
  }

  return { errors, structure, files, scalars, parser: parser?.detail ?? null };
}

/* ══════════════════════════════ 自检 ══════════════════════════════ */

const GOOD_WORKFLOW = `name: good
on: [push]
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - name: A normal step
        run: echo hello
`;

/** fixture 基础树：5 个正常 workflow（满足扫描面下界：文件 ≥5、映射项 ≥20）。 */
function baseFiles(extra = {}) {
  const files = {};
  for (const name of ["a.yml", "b.yml", "c.yml", "d.yml", "e.yml"]) {
    files[`.github/workflows/${name}`] = GOOD_WORKFLOW;
  }
  return { ...files, ...extra };
}

function selftest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  /**
   * 造一个 fixture 仓库并跑守卫（--root 指过去）。
   *
   * **一律用 `baseFiles()` 打底**（5 个正常 workflow）：扫描面下界（文件 ≥5、
   * 映射项 ≥20）会让**只有 1 个文件的小 fixture** 直接落进「结构红」分支 ⇒
   * 用例断言的文本（如「YAML 解析失败」）根本不会被打印 ⇒ 断言变成了
   * 「结构红也算过」的假通过。底座保证每个用例测的**就是它自己那条判据**。
   */
  const runOn = (files) => {
    const repo = makeFixtureRepo({
      "package.json": JSON.stringify({ name: "fixture" }),
      ...baseFiles(files),
    });
    const result = runGuard(SELF, { args: ["--root", repo.dir] });
    return { result, cleanup: repo.cleanup };
  };

  // ① 未加引号的 `: ` ⇒ 红（2026-11-04 的真实形态）
  add("① 未加引号的「冒号+空格」⇒ 红（2026-11-04 事故形态）", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/a.yml":
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
      ".github/workflows/a.yml":
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
      ".github/workflows/a.yml":
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
      ".github/workflows/a.yml":
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
      ".github/workflows/a.yml":
        "jobs:\n  a:\n    steps:\n      - name: label:\n        run: echo hi\n",
    });
    try {
      expectExit(result, { code: 1, contains: ["以冒号结尾"] });
    } finally {
      cleanup();
    }
  });

  // ⑥ 正常 workflow ⇒ 绿
  add("⑥ 正常 workflow ⇒ 绿", () => {
    const { result, cleanup } = runOn(baseFiles());
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  // ⑦ 流式集合里的冒号是**合法** YAML（`{B: 1}` / `[a: b]`）⇒ 绿（不误报）
  add("⑦ 流式集合 `{B: 1}` 里的冒号 ⇒ 绿（合法 YAML，不误报）", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/a.yml": `${GOOD_WORKFLOW}      - name: flow
        env: {B: 1, C: 2}
        with: [a: b]
`,
    });
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  // ⑧ 结构性非法 YAML（缩进错乱）⇒ **语法层**红（证明不只有针对性层在抓）
  add("⑧ 结构性非法 YAML（缩进错乱）⇒ 语法层红", () => {
    const { result, cleanup } = runOn({
      ".github/workflows/a.yml":
        "jobs:\n  a:\n    steps:\n      - run: echo hi\n   bad_indent: 1\n",
    });
    try {
      expectExit(result, { code: 1, contains: ["YAML 解析失败"] });
    } finally {
      cleanup();
    }
  });

  // ⑨ 扫描面塌陷（没有 workflow 目录）⇒ **结构红（退出码 2）**，不是「零命中全绿」
  add("⑨ 扫描面塌陷（无 workflow 目录）⇒ 结构红 2（防空转）", () => {
    const repo = makeFixtureRepo({ "package.json": JSON.stringify({ name: "f" }) });
    try {
      const result = runGuard(SELF, { args: ["--root", repo.dir] });
      expectExit(result, { code: 2, contains: ["扫描面塌陷"] });
    } finally {
      repo.cleanup();
    }
  });

  // ⑩ 扫描面塌方（只有 1 个 workflow）⇒ **结构红（退出码 2）**
  //    这条**刻意不走 baseFiles 底座**（底座会补足 5 个文件 ⇒ 塌方就造不出来了）。
  add("⑩ 扫描面塌方（只有 1 个 workflow）⇒ 结构红 2（防空转）", () => {
    const repo = makeFixtureRepo({
      "package.json": JSON.stringify({ name: "f" }),
      ".github/workflows/only.yml": GOOD_WORKFLOW,
    });
    try {
      const result = runGuard(SELF, { args: ["--root", repo.dir] });
      expectExit(result, { code: 2, contains: ["扫描面塌方"] });
    } finally {
      repo.cleanup();
    }
  });

  // ⑪ 真实仓库 ⇒ 绿（控制组）
  add("⑪ 真实仓库 ⇒ 绿（控制组）", () => {
    expectExit(runGuard(SELF, { args: ["--root", REPO_ROOT] }), { code: 0 });
  });

  // ⑫ 退出码契约：违规 = 1，结构红 = 2（**两个必须分开**，否则分不清
  //     「有人在 workflow 里写错了」与「守卫自己瞎了」——后者该修守卫）
  add("⑫ 退出码契约：违规⇒1 / 结构红⇒2（两者必须可分辨）", () => {
    const bad = makeFixtureRepo({
      "package.json": JSON.stringify({ name: "fixture" }),
      ...baseFiles({
        ".github/workflows/a.yml":
          "jobs:\n  a:\n    steps:\n      - name: X (report-only: plan before)\n        run: echo hi\n",
      }),
    });
    const collapsed = makeFixtureRepo({
      "package.json": JSON.stringify({ name: "fixture" }),
      ".github/workflows/only.yml": GOOD_WORKFLOW,
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", bad.dir] }), { code: 1 });
      expectExit(runGuard(SELF, { args: ["--root", collapsed.dir] }), { code: 2 });
    } finally {
      bad.cleanup();
      collapsed.cleanup();
    }
  });

  // ⑬ 用法错误（--selftest 与 --root 互斥）⇒ 退出码 4
  add("⑬ 用法错误（--selftest 与 --root 互斥）⇒ 退出码 4", () => {
    expectExit(runGuard(SELF, { args: ["--selftest", "--root", REPO_ROOT] }), {
      code: 4,
      contains: ["不能同时用"],
    });
  });

  const failed = reportCases(cases, { title: "check-workflow-yaml" });
  return failed > 0 ? 1 : 0;
}

/* ══════════════════════════════ 入口 ══════════════════════════════ */

/**
 * 退出码契约（**四个**，调用方能分辨「什么坏了」）：
 *
 *   0 = 通过（全部 workflow 可解析 + 0 处未加引号的冒号纯量）
 *   1 = **有违规**（YAML 语法错 / 未加引号的冒号纯量）——「东西坏了」
 *   2 = **结构红**（判据不可信：扫描面塌方 / 一个解析器都找不到）——「**没判**」
 *   3 = 自检失败（`--selftest` 有用例未按预期）——「判据本身坏了」
 *   4 = 用法错误（参数互斥等）
 *
 * 2 与 1 必须分开：1 是「查到了问题」，2 是「**根本没查**」。合成一个码 ⇒
 * CI 红了但没人分得清是「有人在 workflow 里写错了」还是「守卫瞎了」——
 * 后者该修守卫而不是改 workflow。
 */
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_STRUCTURAL = 2;
export const EXIT_SELFTEST_FAILED = 3;
export const EXIT_USAGE = 4;

export function main(argv = process.argv.slice(2)) {
  // 计数行：守卫「自己声明了多少用例」（`scripts/lib/agent-coverage.mjs` 的契约）。
  // 哨兵（`check-guards-wired.mjs` 判据④）盯着这一行 ⇒ 用例被删光时会红。
  printCoverageBanner(import.meta.url, "expectExit");
  if (argv.includes("--selftest")) {
    if (argv.includes("--root")) {
      console.error("--selftest 与 --root 不能同时用（自检自己造 fixture 树）");
      return EXIT_USAGE;
    }
    return selftest() === 0 ? EXIT_OK : EXIT_SELFTEST_FAILED;
  }
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? resolve(argv[rootIdx + 1] ?? ".") : REPO_ROOT;
  const { errors, structure, files, scalars, parser } = check({ root });
  if (structure.length > 0) {
    console.error("✖ workflow 语法守卫的结构错（判据不可信，退出码 2）：");
    for (const s of structure) console.error(`  · ${s}`);
    console.error(
      "  结构红 ≠ 「没发现问题」：这是「**根本没判**」。先修好上面的问题，别把它当通过。",
    );
    return EXIT_STRUCTURAL;
  }
  if (errors.length > 0) {
    console.error(`✖ ${errors.length} 处 workflow 语法问题（退出码 1）：`);
    for (const e of errors) console.error(`  · ${e}`);
    console.error(
      "  历史教训（2026-11-04）：一处非法 YAML ⇒ 整个 ci.yml 解析失败 ⇒ 所有 job 全不跑，" +
        "而当天所有守卫仍然全绿。",
    );
    return EXIT_VIOLATION;
  }
  console.log(
    `✔ ${files.length} 个 workflow 全部可解析（解析器：${parser}），` +
      `且 ${scalars} 个映射项里 0 处未加引号的冒号纯量`,
  );
  return EXIT_OK;
}

// 只有「被当作 CLI 直接跑」时才执行；被 import 时**不执行**（否则 import 本模块
// 去做单元断言的人会被 `process.exit` 打断）。
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  process.exit(main());
}
