#!/usr/bin/env node
/**
 * 「守卫必须被 CI 跑到」的自检 —— 防「加了守卫，但没人跑它」。
 *
 * 由来：这个仓库现在有 40+ 个 `scripts/check-*.mjs`。加一个守卫很便宜，**接进
 * CI 才是让它生效的那一步**，而漏接是**完全静默**的：脚本存在、本地能跑、
 * README 里可能还写着它，但 CI 从不执行 —— 于是它保护不了任何东西。
 *
 * 判据（对 scripts 下每个 check- 开头的 .mjs，排除 .selftest.mjs）：
 *   ① 文件名出现在任一 `.github/workflows/*.yml` 里；**或**
 *   ② 文件名出现在 package.json 的某个 script 里，且**那个 script 名**出现在
 *      任一 workflow 里（CI 常写 `npm run check:xxx`，不直接写文件名）。
 *
 * ## 第 4 轮守卫审计修正的三处误绿（2026-10-29）
 *
 * 旧实现用 `workflows.includes(文件名)` 做纯子串匹配，两种形态会被判成「已接线」：
 *   ① **把 CI 步骤注释掉**：`#   node scripts/check-x.mjs` 仍然是子串命中 ——
 *      守卫实际从不运行，本闸却报绿（审计已用假根实证）。
 *   ② **脚本名前缀误配**：workflow 写 `npm run check:all`，而 package.json 里
 *      有个 `check` 脚本也调同一守卫时，`includes("npm run check")` 会命中
 *      `npm run check:all` —— 「只被别的 script 间接带跑」与「根本没接线」不可区分。
 *   现在：YAML 注释先剥掉；文件名匹配要求非脚本名字符边界；`npm run <name>`
 *   后必须是非脚本名字符（空白/行尾/引号/`&&`）。
 *
 * ## 例外（ALLOWLIST）与「豁免必须可证」
 *
 * 两类：`report-only`（只报告、不产生红绿，必须写理由）与
 * `covered-elsewhere`（判据本体由别的收集面跑，**必须给 mustProve 文件路径且
 * 该文件存在**——审计指出旧版豁免理由是一条无人校验的假设）。目录里已不存在
 * 的陈旧豁免也会报错（豁免必须回收）。
 *
 * 用法：`node scripts/check-guards-wired.mjs [--selftest] [--root <dir>]`
 *   --selftest：**跑真脚本的子进程**，在临时假根里复现上述两种误绿 + 豁免校验 +
 *              扫描面下界；每条用例断言退出码与关键报错文本（T4 迁移）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根扫（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/**
 * 只报告 / 由别的收集面覆盖的脚本。
 *
 * 每条必须声明 kind：
 *   · `report-only`：不产生红绿判定（只给人看的雷达），reason 必填；
 *   · `covered-elsewhere`：判据本体已被测试/其它 job 收集，`mustProve` 必须
 *     指向**仓库内真实存在**的文件（防止「理由是一句假设」）。
 */
export const ALLOWLIST = {
  "apps/admin-api/scripts/check-route-authz-matrix.mjs": {
    kind: "covered-elsewhere",
    reason:
      "判据本体 route-authz-matrix.spec.ts 已被 admin-api jest job（--shard）作为普通 spec 收集；本文件只是 CLI 外壳",
    mustProve:
      "apps/admin-api/src/common/guards/__tests__/route-authz-matrix.spec.ts",
  },
};

const MIN_GUARD_COUNT = 20;

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
      if (e.name === "node_modules" || e.name === ".venv") continue;
      walk(p, out);
    } else if (
      /^check-.*\.mjs$/.test(e.name) &&
      !/\.selftest\.mjs$/.test(e.name)
    ) {
      out.push(p);
    }
  }
}

/** 收集 root 下的守卫脚本（根 scripts/ + apps/<pkg>/scripts + packages/<pkg>/scripts）。 */
export function scanGuards(root) {
  const guards = [];
  walk(join(root, "scripts"), guards);
  for (const group of ["apps", "packages"]) {
    let children = [];
    try {
      children = readdirSync(join(root, group), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const child of children) {
      walk(join(root, group, child, "scripts"), guards);
    }
  }
  return guards;
}

/**
 * 剥掉 YAML 注释（整行 + 行内 ` #…`）。
 *
 * 目标只有一个：**注释掉的 CI 步骤不能算接线**。行内剥离可能切掉引号里的 `#`
 * 之后内容，方向是「少匹配」——只会造成误红，不会造成误绿。
 */
export function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

export function readWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 判据：返回 { problems, errors, counts }。
 *
 * problems = 「守卫存在但没接线」；errors = 结构性问题（扫描面失效、豁免不合法）。
 */
export function checkGuardsWired({ root, allowlist = ALLOWLIST }) {
  const problems = [];
  const errors = [];

  const guards = scanGuards(root);
  if (guards.length === 0) {
    errors.push("一个守卫脚本都没扫到 —— 路径或正则失效了。");
    return { problems, errors, counts: { guards: 0, allowlisted: 0 } };
  }
  if (guards.length < MIN_GUARD_COUNT) {
    errors.push(
      `只扫到 ${guards.length} 个守卫 —— 明显少于历史规模（${MIN_GUARD_COUNT}+），扫描面可能失效。`,
    );
  }

  const workflows = stripYamlComments(readWorkflows(root));
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    errors.push("package.json 不可读 —— 无法解析 npm script 间接接线。");
  }
  const scripts = pkg.scripts ?? {};

  const seenAllow = new Set();

  for (const abs of guards) {
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    const base = rel.split("/").pop();

    if (allowlist[rel]) {
      seenAllow.add(rel);
      const entry = allowlist[rel];
      if (!entry.reason || entry.reason.trim().length === 0) {
        errors.push(`豁免缺理由：${rel}`);
      }
      if (entry.kind === "covered-elsewhere") {
        if (!entry.mustProve) {
          errors.push(`豁免（covered-elsewhere）必须给 mustProve：${rel}`);
        } else if (!existsSync(join(root, entry.mustProve))) {
          errors.push(
            `豁免的 mustProve 文件不存在：${rel} → ${entry.mustProve}（理由已过期，请重核或撤除豁免）`,
          );
        }
      } else if (entry.kind !== "report-only") {
        errors.push(
          `豁免 kind 非法（只能是 report-only / covered-elsewhere）：${rel}`,
        );
      }
      continue;
    }

    // ① 直接出现文件名；要求边界不是脚本名字符（避免 check-x 命中 check-x2）。
    const directRe = new RegExp(escapeRe(base) + "(?![\\w.])");
    if (directRe.test(workflows)) continue;

    // ② 经 npm script 间接接线；`npm run <name>` 后必须是非脚本名字符。
    const invoking = Object.entries(scripts).filter(([, cmd]) =>
      String(cmd).includes(base),
    );
    const wiredViaNpm = invoking.some(([name]) =>
      new RegExp("npm run " + escapeRe(name) + "(?![\\w:-])").test(workflows),
    );
    if (wiredViaNpm) continue;

    problems.push({ rel, invoking: invoking.map(([n]) => n) });
  }

  for (const rel of Object.keys(allowlist)) {
    if (!seenAllow.has(rel)) {
      errors.push(`陈旧豁免（目录里已没有这个守卫）：${rel} —— 豁免必须回收`);
    }
  }

  return {
    problems,
    errors,
    counts: { guards: guards.length, allowlisted: seenAllow.size },
  };
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/**
 * `--root` 是 selftest 专用参数：ALLOWLIST 里写的是**本仓库**的路径，套到临时树上
 * 只会被当成「陈旧豁免」而全线报错，所以显式给 `--root` 时按空豁免跑。
 * 方向是**变严**（豁免少了只可能多报问题，不可能漏报）；扫真实仓库请不带 `--root`。
 */
function runCli(root, { allowlist = ALLOWLIST } = {}) {
  const { problems, errors, counts } = checkGuardsWired({ root, allowlist });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 守卫接线自检结构错误：");
    for (const e of errors) console.error("  · " + e);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ ${problems.length} 个守卫**没有被任何 CI workflow 执行**：`);
    for (const p of problems) {
      console.error("  · " + p.rel);
      if (p.invoking.length > 0) {
        console.error(
          "    （package.json 里有 " +
            p.invoking.join(", ") +
            "，但 workflow 没调用它）",
        );
      } else {
        console.error("    （package.json 里也没有脚本包装它）");
      }
    }
    console.error("");
    console.error(
      "  修法：把它接进 .github/workflows/ci.yml（直接 node scripts/… 或 npm run check:…）。",
    );
    console.error(
      "  若它本就只报告、不该产生红绿判定，加进本脚本的 ALLOWLIST 并写明理由。",
    );
    process.exit(1);
  }

  console.log(
    `✔ 守卫接线自检通过：${counts.guards - counts.allowlisted} 个 check-*.mjs 全部被 CI 执行` +
      `（另有 ${counts.allowlisted} 个显式豁免）。`,
  );
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本）────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

/** 一份最小 CI workflow：只要求「有 steps:」，判据本身是纯文本匹配。 */
const workflowYaml = (stepLines) =>
  ["name: fixture", "on: push", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines].join("\n") + "\n";

/**
 * 造一棵 fixture 仓库树。
 *
 * 每棵树都放 22 个守卫：判据里有 `MIN_GUARD_COUNT = 20` 的扫描面下界，小于它
 * 就是结构性错误。这样「下界」本身在**每条**用例里都被顺带钉住，而不是只在
 * 专门的下界用例里。
 */
function guardTree({ guards, stepLines, scripts = {} }) {
  const files = {
    "package.json": { name: "fixture", private: true, scripts },
    ".github/workflows/ci.yml": workflowYaml(stepLines),
  };
  for (const g of guards) {
    files[`scripts/${g}`] = "// fixture guard（本守卫只看文件名，不看内容）\n";
  }
  return files;
}

const names = (n) => Array.from({ length: n }, (_, i) => `check-fake${String(i).padStart(2, "0")}.mjs`);
const direct = (guards) => guards.map((g) => `      - run: node scripts/${g}`);

/**
 * 自检：5 条子进程用例（每条断言退出码 + 关键文本 + <1s）+ 2 条 API 级用例。
 *
 * 为什么要子进程：本脚本的两个既有事故形态恰好都发生在 **CLI 层**（`process.exit`
 * 是否真的执行、报错文本是否还在），抽函数在内存里断言的 selftest 对它们完全盲。
 * 旧版 selftest 正是「函数级 + 手搓 ok 布尔」，删掉 runCli 里的 exit(1) 它照样全绿。
 *
 * 两条 API 级用例（allowlist 注入）走子进程做不到：CLI 没有 `--allowlist` 参数，
 * 给 fixture 加一个可写 allowlist 的开关等于给判据开后门，所以这两条直接调用导出
 * 函数 `checkGuardsWired({ root, allowlist })`（runCli 调的就是它）。
 */
function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "guards-wired-selftest-" });
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
  const api = (name, fn) => cases.push({ name, fn });

  // ① 正常树：21 条直接接线 + 1 条经 npm script 间接接线 → 绿
  {
    const guards = names(22);
    subprocess(
      "① 正常树（直接 + npm 间接都算接线）→ 绿",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), "      - run: npm run check:last"],
        scripts: { "check:last": `node scripts/${guards[21]}` },
      }),
      {
        code: 0,
        contains: ["守卫接线自检通过", "22 个 check-*.mjs 全部被 CI 执行", "0 个显式豁免"],
        absent: ["没有被任何 CI workflow 执行", "结构错误"],
      },
    );
  }

  // ② 注释掉的 CI 步骤不算接线（第 4 轮审计实证的误绿形态）
  {
    const guards = names(22);
    subprocess(
      "② 注释掉的 CI 步骤不算接线 → 红",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), `#      - run: node scripts/${guards[21]}`],
      }),
      {
        code: 1,
        contains: [guards[21], "没有被任何 CI workflow 执行", "package.json 里也没有脚本包装它"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ③ `npm run check:all` 不得把名为 `check` 的脚本判成已接线（前缀误配）
  {
    const guards = names(22);
    subprocess(
      "③ npm run 名字边界：check:all 不得命中 check → 红",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), "      - run: npm run check:all"],
        scripts: { check: `node scripts/${guards[21]}`, "check:all": "echo all" },
      }),
      {
        code: 1,
        contains: [guards[21], "package.json 里有 check，但 workflow 没调用它"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ④ 脚本完全没被调用（workflow 不提、package.json 也不包装）
  {
    const guards = names(22);
    subprocess(
      "④ 守卫完全没被调用（没接线、也没脚本包装）→ 红",
      guardTree({ guards, stepLines: direct(guards.slice(0, 21)) }),
      {
        code: 1,
        contains: [guards[21], "package.json 里也没有脚本包装它", "修法：把它接进"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ⑤ 扫描面下界：守卫少到不可能是真的（正则/路径失效）
  {
    const guards = names(3);
    subprocess(
      "⑤ 扫描面失效（只扫到 3 个守卫）→ 结构错误红",
      guardTree({ guards, stepLines: direct(guards) }),
      {
        code: 1,
        contains: ["守卫接线自检结构错误", "明显少于历史规模", "只扫到 3 个守卫"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ⑥ ⑦ 豁免校验（API 级：CLI 无法注入 allowlist，加开关等于开后门）
  api("⑥ 豁免（covered-elsewhere）的 mustProve 文件不存在 → 结构错误", () => {
    const guards = names(22);
    const repo = makeFixtureRepo(guardTree({ guards, stepLines: direct(guards) }), {
      prefix: "guards-wired-selftest-",
    });
    try {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: {
          [`scripts/${guards[0]}`]: {
            kind: "covered-elsewhere",
            reason: "fixture 理由（必须可证）",
            mustProve: "does/not/exist.spec.ts",
          },
        },
      });
      const errs = r.errors.join("\n");
      if (!errs.includes("mustProve 文件不存在")) {
        throw new Error(`预期 mustProve 结构错误，实际 errors=${JSON.stringify(r.errors)}`);
      }
      if (r.counts.allowlisted !== 1) {
        throw new Error(`豁免应被计入 counts.allowlisted=1，实际 ${r.counts.allowlisted}`);
      }
    } finally {
      repo.cleanup();
    }
  });

  api("⑦ 陈旧豁免（目录里已没有这个守卫）→ 结构错误", () => {
    const guards = names(22);
    const repo = makeFixtureRepo(guardTree({ guards, stepLines: direct(guards) }), {
      prefix: "guards-wired-selftest-",
    });
    try {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: { "scripts/check-already-deleted.mjs": { kind: "report-only", reason: "fixture" } },
      });
      if (!r.errors.some((e) => e.includes("陈旧豁免"))) {
        throw new Error(`预期陈旧豁免错误，实际 errors=${JSON.stringify(r.errors)}`);
      }
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-guards-wired selftest" });
  if (failed > 0) process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    const rootArg = argValue(process.argv, "--root");
    runCli(resolve(rootArg ?? process.cwd()), rootArg ? { allowlist: {} } : {});
  }
}
