#!/usr/bin/env node
/**
 * Shell「变量名吞掉多字节字符」守卫（macOS bash 3.2 实证）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 2026-09-23 desktop-v1.6.0 补发（run 35864019734）实证：macOS job 的
 * `gh release upload` **已经成功上传全部 6 个资产**，紧接着却红着退出：
 *
 *     /Users/runner/work/_temp/….sh: line 28: count�: unbound variable
 *
 * 出事的行是（变量后面紧跟一个全角括号）：
 *
 *     echo "release 现有资产数 = $count（本 job 上传 ${#files[@]} 个）"
 *
 * 根因：`（` 是 U+FF08，UTF-8 编码 `EF BC 88`。macOS runner 的
 * `shell: bash` 走**系统 /bin/bash（3.2）**，且在非 UTF-8 locale 下，bash 3.2
 * 不把 0xEF 当作「标识符结束」，而是**把它并进变量名**——于是变量名成了
 * `count\xEF`，`set -u` 立刻判定 unbound 并中止整个 step。
 *
 * 危害形态特别阴险：**这一步是发布链路的最后一道校验**，它挂了以后
 * 「发布其实成功了」会被渲染成 job 红。同类问题若落在真正决定成败的位置
 * （例如把 `$count` 参与 `-lt` 比较），就是**假绿/假红**两种方向的误判。
 * 而且同一行在 ubuntu（bash 5.x + UTF-8 locale）**完全正常**，只在 macOS
 * 单点复现——最容易被当成"环境抖动"重跑糊过去。
 *
 * 修法一律是加花括号界定变量名边界：`$count（` → `${count}（`。
 * 花括号形态与裸形态在被多字节字符跟随的场景下**语义完全相同或更正确**，
 * 故该替换永远安全（本守卫的自动修复即为纯文本替换）。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────
 * 扫描 `.github/workflows/*.yml` 与仓库内 `*.sh`，找出「裸 `$NAME` 紧跟
 * 一个非 ASCII 字符」的每一处。`${NAME}` 形态天然安全，不报。
 *
 * ── T4（第 4 轮守卫自检审计）修掉的假绿 ──────────────────────────────
 *
 *   · **`readdirSync` 静默 catch（最贵的一条）**：旧 `collectTargets` 对
 *     `.github/workflows` 与每一层子目录都是 `try { … } catch { /* 忽略 *\/ }`。
 *     于是「workflows 目录改名/权限不足」「某个子树读不了」与「真的一个文件都
 *     没有」在输出上**完全无法区分**，一律退化成「0 处违规 → OK」。现在这些
 *     异常被收集进 `problems`，按**结构红**处理并点名路径与 errno。
 *   · **`readFileSync` 失败 `continue` 跳块**：旧实现对读不出来的 `*.sh`
 *     静默 `continue`，那个文件直接退出扫描面——分母悄悄变小，日志里一个字
 *     都没有。现在读取失败同样进 `problems`（结构红）。
 *   · **下界只在「不带参数」的分支生效**：`MIN_TARGETS` 的检查写在普通校验
 *     路径末尾，`--fix` 分支在它之前就 `return`。于是「扫描面塌了（0 个目标）
 *     + `--fix`」会打印 `自动修复 0 处` 并 exit 0——一个以"修好了"为结论的
 *     成功退出码。现在结构关在 `--fix` 之前，两条路径共用。
 *   · **`--root` 缺失**：旧实现用 `findRepoRoot()` 从脚本位置上溯，selftest 只能
 *     对 `scanText()` 做函数级断言——**CLI 的退出码从未被验证**（把 `--fix`
 *     里的 `process.exit(1)` 删掉、或让下界失效，selftest 照样全绿）。
 *     现在 `--root <dir>` 可把任意目录当仓库根，selftest 跑真子进程。
 *   · **只数条数**：旧 selftest 8 条断言全是 `scanText(...).length === 1` 这种
 *     函数级计数。现在逐条断言**退出码 + 关键报错文本 + 文件:行**（10 条子进程
 *     + 1 条 API 级），并含 `--fix` 的实际改写断言。
 *   · **import 有副作用**：旧文件末尾的 `main()` 判断依赖 `resolve(argv[1])`，
 *     本身是安全的；但 `findRepoRoot` 会**抛错**（缺 markers 时），import 即崩。
 *     现在只在被直接调用时执行，import 永不抛。
 *
 * 用法：
 *   node scripts/check-shell-multibyte-var.mjs                  # 校验
 *   node scripts/check-shell-multibyte-var.mjs --selftest       # 自测（含反例，证明有牙）
 *   node scripts/check-shell-multibyte-var.mjs --fix            # 自动加花括号
 *   node scripts/check-shell-multibyte-var.mjs --root <dir>     # 把该目录当仓库根（selftest 专用）
 * 退出码：0 = 无违规（且判据可信）；1 = 存在违规，**或判据本身不可信**（结构错）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 扫描面下界（2026-10-29 实测 40 个文件：workflows + `*.sh`）。
 *
 * 0 个目标 = 永远绿（目录改名 / 忽略规则写反 / 整棵子树读不了都会把分母清零，
 * 输出仍是 OK）。低于下界按**结构错**处理，不是普通红。
 */
export const MIN_TARGETS = 30;

/** 裸 `$NAME` 紧跟一个非 ASCII 字符——bash 3.2 会把该字符的高字节并进变量名。 */
export const RISKY_RE = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;

/** 目录名一律不进入扫描（第三方/产物/版本库元数据）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "out",
  ".workbuddy",
]);

const WORKFLOWS_DIR = ".github/workflows";

export function findRepoRoot(startDir = HERE) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "package.json"), "utf-8");
      readdirSync(join(dir, WORKFLOWS_DIR));
      return dir;
    } catch {
      /* 继续上溯（这是「找根」的探测，不是扫描面的静默跳过） */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到仓库根（需同时存在 package.json 与 .github/workflows）");
}

function rel(root, p) {
  return relative(root, p).split(sep).join("/");
}

/**
 * 递归收集待扫描文件：`.github/workflows/*.yml` + 任意 `*.sh`。
 *
 * **不再静默吞错**（T4）：任何目录读不出来都进 `problems`——"读不到"与
 * "没有违规"必须能区分开。返回的是绝对路径。
 *
 * @param {string} root
 * @returns {{files: string[], problems: string[]}}
 */
export function collectTargets(root) {
  const files = [];
  const problems = [];

  const wfDir = join(root, WORKFLOWS_DIR);
  let wfNames = [];
  try {
    wfNames = readdirSync(wfDir);
  } catch (error) {
    problems.push(
      `事实源缺失：${WORKFLOWS_DIR} 不可读（${error.code ?? error.message}）—— ` +
        `workflow 面整块退出扫描面，「0 处违规」不代表安全。`,
    );
  }
  for (const name of wfNames) {
    if (/\.ya?ml$/.test(name)) files.push(join(wfDir, name));
  }

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push(
        `目录不可读：${rel(root, dir) || "."}（${error.code ?? error.message}）—— 整棵子树退出扫描面。`,
      );
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".sh")) {
        files.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return { files, problems };
}

/** 返回 [{line, text, match}] —— 1-based 行号。 */
export function scanText(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    RISKY_RE.lastIndex = 0;
    let m;
    while ((m = RISKY_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, text: line.trim(), match: m[0] });
    }
  }
  return hits;
}

/** 把 `$NAME` 改成 `${NAME}`（仅针对紧跟非 ASCII 的裸形态）。 */
export function applyFix(text) {
  return text.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g,
    (_all, name) => `\${${name}}`,
  );
}

/**
 * 全量扫描（判据本体，供 CLI 与 selftest 共用）。
 *
 * @param {string} root 仓库根
 * @param {{readFile?: (p: string) => string}} [options] `readFile` 只为 selftest 注入
 *        「读不出来」的情形（EACCES 在 root 容器里造不出来）。
 * @returns {{targets: string[], hits: {file: string, text: string, hits: object[]}[],
 *            problems: string[]}}
 *   `problems` = **判据本身不可信**（事实源缺失、目录/文件读不了、扫描面塌方）。
 */
export function scanRepo(root, { readFile = (p) => readFileSync(p, "utf-8") } = {}) {
  const { files, problems } = collectTargets(root);
  const hits = [];
  const unreadable = [];

  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch (error) {
      unreadable.push(`${rel(root, file)}（${error.code ?? error.message}）`);
      continue;
    }
    const found = scanText(text);
    if (found.length) hits.push({ file, text, hits: found });
  }

  // 读取失败不是"干净"：这些文件已退出扫描面（旧实现静默 continue）。
  if (unreadable.length > 0) {
    problems.push(
      `读取失败 ${unreadable.length} 个文件：${unreadable.join("、")} —— 它们退出了扫描面（不是「无违规」）。`,
    );
  }

  if (files.length < MIN_TARGETS) {
    problems.push(
      `只扫到 ${files.length} 个文件（下界 ${MIN_TARGETS}）——分母塌了，不是脚本变干净了。`,
    );
  }

  return { targets: files, hits, problems };
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

const WORKFLOW_YAML =
  "name: fixture\non: push\njobs:\n  guard:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
const WORKFLOW = `${WORKFLOWS_DIR}/ci.yml`;
const SH_BODY = '#!/usr/bin/env bash\nset -euo pipefail\necho "ok"\n';

/** 造 n 个合规 `.sh`（默认 30 + workflow = 31 个目标，顶过 MIN_TARGETS=30）。 */
const manySh = (n = MIN_TARGETS) => {
  const files = {};
  for (let i = 0; i < n; i += 1) {
    files[`scripts/fixture-${String(i).padStart(2, "0")}.sh`] = SH_BODY;
  }
  return files;
};

const tree = (extra = {}) => ({ [WORKFLOW]: WORKFLOW_YAML, ...manySh(), ...extra });

/** 线上真实肇事行（全角「（」紧跟 `$count`）。 */
const REAL_LINE = 'echo "release 现有资产数 = $count（本 job 上传 ${#files[@]} 个）"';

/** 自检：10 条子进程用例 + 1 条 API 级用例（每条断言退出码 + 关键文本 + <1s）。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect, args = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "shell-multibyte-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: [...args, "--root", repo.dir] }), {
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
  const api = (name, fn) => cases.push({ name, fn });

  subprocess("① 合规树（31 个目标）→ 绿（正例控制组）", tree(), {
    code: 0,
    contains: ["OK：31 个文件", "无多字节变量名陷阱"],
    absent: ["发现", "结构错误"],
  });

  subprocess(
    "② 【反证·线上真实肇事行】`$count（` → 红（点名 文件:行）",
    tree({ "scripts/deploy.sh": `#!/usr/bin/env bash\n${REAL_LINE}\n` }),
    {
      code: 1,
      contains: ["发现 1 处", "scripts/deploy.sh:2", "$count（"],
      absent: ["无多字节变量名陷阱"],
    },
  );

  subprocess(
    "③ 花括号形态 `${count}（` → 绿（不误报，否则守卫会永远红=没牙）",
    tree({ "scripts/deploy.sh": `#!/usr/bin/env bash\n${applyFix(REAL_LINE)}\n` }),
    {
      code: 0,
      contains: ["无多字节变量名陷阱"],
      absent: ["发现"],
    },
  );

  subprocess(
    "④ 半角跟随（`$count, ok` / `$count) x`）→ 绿（ASCII 紧跟不算问题）",
    tree({
      "scripts/ascii.sh": '#!/usr/bin/env bash\necho "$count, ok"\necho "$count) x"\n',
    }),
    {
      code: 0,
      contains: ["无多字节变量名陷阱"],
      absent: ["发现"],
    },
  );

  subprocess(
    "⑤ 一行两处（`$a（x）$b（y）`）→ 红且两处都报（不只报第一处）",
    tree({ "scripts/two.sh": '#!/usr/bin/env bash\necho "$a（x）$b（y）"\n' }),
    {
      code: 1,
      contains: ["发现 2 处", "scripts/two.sh:2"],
      absent: ["无多字节变量名陷阱"],
    },
  );

  subprocess(
    "⑥ 【反证·下界】扫描面只剩 3 个文件 → 结构红（分母塌了不是「变干净了」）",
    {
      [WORKFLOW]: WORKFLOW_YAML,
      "scripts/a.sh": SH_BODY,
      "scripts/b.sh": SH_BODY,
    },
    {
      code: 1,
      contains: ["结构错误", "只扫到 3 个文件", `下界 ${MIN_TARGETS}`],
      absent: ["无多字节变量名陷阱"],
    },
  );

  subprocess(
    "⑦ 【反证·静默 catch】没有 .github/workflows 目录 → 结构红并点名（旧实现静默忽略）",
    { ...manySh() },
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${WORKFLOWS_DIR}`, "ENOENT"],
      // 「点名 errno」是修好之后的期望行为；这里只排除**崩栈**（未捕获异常的形态）。
      absent: ["无多字节变量名陷阱", "Error:", "\n    at "],
    },
  );

  subprocess(
    "⑧ 【反证·--fix 吞结构错】--fix 在塌方扫描面上也必须红（旧实现打印「自动修复 0 处」并 exit 0）",
    {
      [WORKFLOW]: WORKFLOW_YAML,
      "scripts/a.sh": SH_BODY,
      "scripts/b.sh": SH_BODY,
    },
    {
      code: 1,
      contains: ["结构错误", "只扫到 3 个文件"],
      absent: ["自动修复"],
    },
    ["--fix"],
  );

  // ⑨ 的断言要检查 fixture 文件被真改写，所以不能复用 subprocess 的 expectExit 单步。
  cases.push({
    name: "⑨ --fix 真改写字面量：`$count（` → `${count}（`（纯文本替换，变量名逐字节保留）",
    fn: () => {
      const target = "scripts/deploy.sh";
      const repo = makeFixtureRepo(tree({ [target]: `#!/usr/bin/env bash\n${REAL_LINE}\n` }), {
        prefix: "shell-multibyte-selftest-",
      });
      try {
        expectExit(runGuard(SELF, { args: ["--fix", "--root", repo.dir] }), {
          code: 0,
          contains: ["自动修复 1 处", `fixed ${target}（1 处）`],
          withinMs: 1000,
          label: "⑨ --fix 真改写",
        });
        const after = readFileSync(repo.pathOf(target), "utf-8");
        if (!after.includes("${count}（")) {
          throw new Error(`--fix 未把 $count（ 改成 \${count}（，实际内容：\n${after}`);
        }
        if (after.includes("$count（")) {
          throw new Error(`--fix 后仍存在裸形态：\n${after}`);
        }
      } finally {
        repo.cleanup();
      }
    },
  });

  subprocess(
    "⑩ node_modules 里的 .sh 不进扫描面（SKIP_DIRS 仍生效，别把第三方算进来）",
    tree({ "node_modules/some-pkg/bad.sh": '#!/usr/bin/env bash\necho "$count（"\n' }),
    {
      code: 0,
      contains: ["OK：31 个文件"],
      absent: ["发现", "some-pkg"],
    },
  );

  // API 级：EACCES 在 root 容器里造不出来，故注入一个必然抛错的 readFile。
  api("⑪ 【反证·continue 跳块】任一个 .sh 读不出来 → 结构红（不是「无违规」）", () => {
    const repo = makeFixtureRepo(tree(), { prefix: "shell-multibyte-selftest-" });
    try {
      const injected = () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      };
      const result = scanRepo(repo.dir, { readFile: injected });
      const joined = result.problems.join("\n");
      if (!joined.includes("读取失败")) {
        throw new Error(`预期「读取失败」结构错，实际 problems=${JSON.stringify(result.problems)}`);
      }
      if (!joined.includes("EACCES")) {
        throw new Error(`预期问题描述里带 errno（EACCES），实际 problems=${JSON.stringify(result.problems)}`);
      }
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-shell-multibyte-var selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  const rootArg = argValue(argv, "--root");
  let root;
  if (rootArg) {
    root = resolve(rootArg);
  } else {
    try {
      root = findRepoRoot();
    } catch (error) {
      console.error(`[check-shell-multibyte-var] ✖ ${error.message}`);
      process.exit(1);
    }
  }
  if (!existsSync(root)) {
    console.error(`[check-shell-multibyte-var] ✖ --root 不存在：${root}`);
    process.exit(1);
  }

  const doFix = argv.includes("--fix");
  const { targets, hits, problems } = scanRepo(root);

  // 结构关在「修复」之前：判据瞎了就不该给出任何"已修好"的结论。
  if (problems.length > 0) {
    console.error("");
    console.error("[check-shell-multibyte-var] ✖ 结构错误（判据本身不可信，先修扫描面）：");
    for (const p of problems) console.error("  · " + p);
    console.error("");
    process.exit(1);
  }

  if (doFix) {
    let total = 0;
    const report = [];
    for (const { file, text, hits: found } of hits) {
      writeFileSync(file, applyFix(text));
      report.push(`  fixed ${rel(root, file)}（${found.length} 处）`);
      total += found.length;
    }
    if (total === 0) {
      console.log(`[check-shell-multibyte-var] 无需修复：${targets.length} 个文件均无多字节变量名陷阱`);
      return;
    }
    console.log(`[check-shell-multibyte-var] 自动修复 ${total} 处：`);
    for (const r of report) console.log(r);
    console.log("  请复查 diff 后重新提交。");
    return;
  }

  if (hits.length > 0) {
    const total = hits.reduce((n, h) => n + h.hits.length, 0);
    console.error(
      `[check-shell-multibyte-var] 发现 ${total} 处「裸 $VAR 紧跟多字节字符」：`,
    );
    for (const { file, hits: found } of hits) {
      for (const h of found) {
        console.error(`  ${rel(root, file)}:${h.line}  ${h.match}  ←  ${h.text}`);
      }
    }
    console.error(
      "\n  macOS runner 的 /bin/bash 是 3.2，在非 UTF-8 locale 下会把该多字节字符的\n" +
        "  首字节并进变量名 → set -u 下 `VAR\\xEF: unbound variable` 直接中止 step。\n" +
        "  修法：给变量名加花括号（$count（ → ${count}（）。可跑 --fix 自动修。",
    );
    process.exit(1);
  }

  console.log(
    `[check-shell-multibyte-var] OK：${targets.length} 个文件（workflows + *.sh）无多字节变量名陷阱`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) selftest();
  else main(argv);
}
