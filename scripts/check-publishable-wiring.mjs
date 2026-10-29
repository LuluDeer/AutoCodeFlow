#!/usr/bin/env node
/**
 * 「可发布包必须接线」守卫。
 *
 * 由来：`packages/autocodeflow-{ai,http,notify,db}` 四个包有源码 + 测试 + pyproject + CHANGELOG，
 * 却**不在** `release.yml` 的 version-guard 里、**不在**任何 publish 矩阵里、**版本停在 0.3.2**
 * （平台主线已到 1.15.x），且**全仓零消费者**。
 *
 * 这又是「**文件存在 ≠ 在链路里**」那一族 —— 本 session 已经在这个形态上抓到过三次：
 * 守卫写了没接 CI、selftest 写了没进 test:main、`ZIP_MAX_*` 定义了没有调用方。现在是第四个载体。
 *
 * 判据：
 *   ① `packages/*` 下**有可发布清单**的包（`pyproject.toml`，或 `package.json` 且不是 `private: true`）
 *      必须出现在 `.github/workflows/release.yml` 里；
 *   ② 例外必须逐条进 `UNWIRED_BASELINE` 并写明理由；**新出现的未接线包即红**；
 *   ③ 反向：基线里的包若**已经接线** ⇒ 也红（基线该瘦身，否则豁免名单会腐烂）；
 *   ④ 基线里的包若**已不存在**（或已不再可发布）⇒ 也红。
 *
 * 为什么基线里那四个不直接判红：它们的存在与否是**产品决策**（接进发布线 or 删掉），
 * 守卫的职责不是替人做决定，而是让这个状态**不能安静地待着**。一旦有人加第五个这样的包，立刻红。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的四处假绿
 *
 *   · **接线判定是纯子串**：旧实现 `release.includes("packages/" + name)` —— 于是
 *     `packages/acf-cli` 会被 `packages/acf-cli-legacy` 满足（接线状态是**别的包**的），
 *     与 `check-guards-wired` 修的是同一个洞。现在要求名字后面不是 `[-\w.]`。
 *   · **注释掉的发布项也算接线**：`#      - packages/foo` 仍是子串命中，等于「守卫看不见的
 *     未接线」。现在先剥 YAML 注释再匹配（方向只会变严：误剥只可能造成红，不可能造成绿）。
 *   · **清单坏了被静默降级成「不可发布」**：`package.json` 解析失败时旧实现 `return false`，
 *     于是那个包从判据里**消失**（既不判接线、也不进基线），而没有任何别的东西校验清单。
 *     现在解析失败 = 结构红，点名是哪个包。
 *   · **`--report` 与结构错误的顺序**：旧实现的结构检查（包数下界）在打印之前 `exit(1)`，
 *     `readFileSync(release.yml)` 缺失则是抛栈——两条路都不产出可读诊断。现在 `--report`
 *     先打印全表、再走结构错误 → exit 1（报告模式**不吞**红灯，selftest 有反证）。
 *   · `--root`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，11 条用例逐条断言退出码 + 关键文本。
 *
 * 用法：
 *   node scripts/check-publishable-wiring.mjs [--report] [--selftest] [--root <dir>]
 *   --report  ：列出全部包及其接线状态（随后仍会按判据退出，红灯不会被报告吞掉）
 *   --selftest：在临时 fixture 树里跑真脚本
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const PKGS_REL = "packages";
export const RELEASE_REL = ".github/workflows/release.yml";

/** 扫描面下界（2026-10-29 实测：11 个包目录 / 8 个可发布）。只增不减，防「分母塌了」。 */
export const MIN_PACKAGES = 8;

/**
 * 已知未接线（**待产品决策**）。每条必须写清「为什么允许它现在不接线」与「决策后要做什么」。
 */
export const UNWIRED_BASELINE = new Map([
  [
    "autocodeflow-ai",
    "待决策：接进 PyPI 发布线（含 version-guard 与文档）或删除；版本 0.3.2（落后平台主线 1.15.x 十余个 minor）、仓内零消费者",
  ],
  [
    "autocodeflow-http",
    "同上（四包同批：ai / http / notify / db）",
  ],
  [
    "autocodeflow-notify",
    "同上（四包同批：ai / http / notify / db）",
  ],
  [
    "autocodeflow-db",
    "同上（四包同批：ai / http / notify / db）",
  ],
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 剥掉 YAML 注释（整行 + 行内 ` #…`）。
 *
 * 目标只有一个：**注释掉的发布项不能算接线**。行内剥离可能切掉引号里的 `#` 之后内容，
 * 方向是「少匹配」——只会造成误红，不会造成误绿。（与 `check-guards-wired.mjs` 同款。）
 */
export function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * 该包是否「可发布」，顺带把**清单坏了**与「没有清单」区分开。
 *
 * 旧实现把 JSON 解析失败吞成 `false`（= 不可发布、跳过），于是坏清单的包从判据里消失。
 * 现在返回 `{ publishable, error }`，由调用方升级为结构红。
 */
export function publishableState(pkgDir, name) {
  if (existsSync(join(pkgDir, "pyproject.toml"))) return { publishable: true, error: null };
  const pkgJson = join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) return { publishable: false, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
  } catch (error) {
    return {
      publishable: false,
      error: `packages/${name}/package.json 不可解析（${error.message.split("\n")[0]}）—— 清单坏了，该包的可发布性与接线状态都无法判定。`,
    };
  }
  return { publishable: parsed.private !== true, error: null };
}

/**
 * 判据本体。返回 `{ errors, problems, rows, counts }`：
 *   · errors   = 结构性（扫描面 / 事实源 / 清单解析）——「判据本身不可信」；
 *   · problems = `{ newlyUnwired: string[], staleBaseline: {name, why}[] }`。
 */
export function check({ root = process.cwd(), baseline = UNWIRED_BASELINE } = {}) {
  const errors = [];
  const rows = [];
  const problems = { newlyUnwired: [], staleBaseline: [] };
  const counts = { packages: 0, publishables: 0, wired: 0, baseline: baseline.size, root };

  let entries;
  try {
    entries = readdirSync(join(root, PKGS_REL), { withFileTypes: true });
  } catch (error) {
    errors.push(
      `读不到目录 ${PKGS_REL}/（${error.code ?? error.message}）—— 扫描面为 0，不是「所有包都接线了」。`,
    );
    return { errors, problems, rows, counts };
  }

  const all = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  counts.packages = all.length;
  if (all.length < MIN_PACKAGES) {
    errors.push(`只扫到 ${all.length} 个 package（下界 ${MIN_PACKAGES}）—— 扫描器失效了，不是包变少了。`);
    return { errors, problems, rows, counts };
  }

  const releaseRaw = readText(join(root, RELEASE_REL));
  if (releaseRaw === null) {
    errors.push(`读不到 ${RELEASE_REL} —— 发布线文件路径变了，接线判定无从谈起。`);
  }
  const release = stripYamlComments(releaseRaw ?? "");

  for (const name of all) {
    const { publishable, error } = publishableState(join(root, PKGS_REL, name), name);
    if (error) errors.push(error);
    // 名字边界：`packages/acf-cli` 不该被 `packages/acf-cli-legacy` 满足。
    const wired = new RegExp(`packages/${escapeRe(name)}(?![\\w.-])`).test(release);
    rows.push({ name, publishable, wired });
  }

  if (errors.length > 0) return { errors, problems, rows, counts };

  const publishables = rows.filter((r) => r.publishable);
  const unwired = publishables.filter((r) => !r.wired).map((r) => r.name);
  counts.publishables = publishables.length;
  counts.wired = publishables.length - unwired.length;

  problems.newlyUnwired = unwired.filter((n) => !baseline.has(n));
  problems.staleBaseline = [...baseline.keys()]
    .filter((n) => !unwired.includes(n))
    .map((n) => {
      if (!all.includes(n)) return { name: n, why: "已不存在" };
      const row = rows.find((r) => r.name === n);
      return { name: n, why: row?.wired ? "已接线" : "已不再可发布" };
    });

  return { errors, problems, rows, counts };
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本）────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：4 个可发布且已接线 + 4 个基线包 + 3 个不可发布 = 11 个包目录（过下界 8）。
const WIRED_PKG = ["acf-cli", "autocodeflow-node-sdk", "mcp-server"]; // package.json（非 private）
const WIRED_PY = ["autoflow-sdk"]; // pyproject.toml
const ALL_WIRED = [...WIRED_PKG, ...WIRED_PY];
const BASELINE_PY = ["autocodeflow-ai", "autocodeflow-http", "autocodeflow-notify", "autocodeflow-db"];
const INERT_PRIVATE = ["docs-site"];
const INERT_BARE = ["contract-fixtures", "executor-protocol"];

const pyproject = (name) => `[project]\nname = "${name}"\nversion = "0.3.2"\n`;

/** release.yml 的最小形态：version-guard 与 publish 矩阵各引一遍。 */
const releaseYml = ({ mentions = ALL_WIRED, commented = [] } = {}) =>
  [
    "name: Release",
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  version-guard:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...mentions.map((d) => `      - run: echo "version-guard: packages/${d}"`),
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...mentions.map((d) => `      - run: echo "publish: packages/${d}"`),
    ...commented.map((d) => `      # - run: echo "publish: packages/${d}"`),
  ].join("\n") + "\n";

/** 造一棵最小 packages/ fixture 树；只传要变的部分。 */
function pkgTree({
  wired = ALL_WIRED,
  baseline = BASELINE_PY,
  inertPrivate = INERT_PRIVATE,
  inertBare = INERT_BARE,
  broken = [],
  release,
  extra = {},
  drop = [],
} = {}) {
  const files = {};
  for (const n of wired) {
    files[`packages/${n}/${WIRED_PY.includes(n) ? "pyproject.toml" : "package.json"}`] =
      WIRED_PY.includes(n) ? pyproject(n) : { name: `@fixture/${n}`, version: "1.0.0" };
  }
  for (const n of baseline) files[`packages/${n}/pyproject.toml`] = pyproject(n);
  for (const n of inertPrivate) {
    files[`packages/${n}/package.json`] = { name: n, version: "0.0.0", private: true };
  }
  for (const n of inertBare) files[`packages/${n}/README.md`] = "# 无发布清单\n";
  for (const n of broken) files[`packages/${n}/package.json`] = "{\n"; // 坏 JSON
  files[RELEASE_REL] = release ?? releaseYml();
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：11 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版**没有 selftest**：判据是模块级 IIFE，`import` 就实扫真仓库，`process.exit(1)` 是唯一
 * 红通道。四处假绿（子串接线 / 注释接线 / 坏清单静默跳过 / --report 吞结构错误）都未被钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect, extraArgs = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "publishable-wiring-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir, ...extraArgs] }), {
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

  subprocess("① 干净树：4 个已接线 / 4 个基线豁免 / 3 个不可发布 → 绿", pkgTree(), {
    code: 0,
    contains: ["可发布包接线一致：8 个可发布包中 4 个已接线，4 个显式基线豁免"],
    absent: ["没有接进", "结构错误", "基线该瘦身"],
  });

  subprocess(
    "② 新出现一个可发布包但没接进 release.yml → 红，点名 packages/",
    pkgTree({ extra: { "packages/newcomer/pyproject.toml": pyproject("newcomer") } }),
    {
      code: 1,
      contains: ["1 个可发布包**没有接进 release.yml**", "packages/newcomer"],
      absent: ["接线一致"],
    },
  );

  subprocess(
    "③ 基线里的包已经接线（release.yml 补上 autocodeflow-ai）→ 红，基线该瘦身",
    pkgTree({ release: releaseYml({ mentions: [...ALL_WIRED, "autocodeflow-ai"] }) }),
    {
      code: 1,
      contains: ["基线里 1 个包**已接线或已不存在**", "autocodeflow-ai（已接线）"],
      absent: ["接线一致"],
    },
  );

  subprocess(
    "④ 基线里的包已不存在（autocodeflow-db 目录被删）→ 红，并标明「已不存在」",
    pkgTree({ baseline: BASELINE_PY.filter((n) => n !== "autocodeflow-db") }),
    {
      code: 1,
      contains: ["基线里 1 个包**已接线或已不存在**", "autocodeflow-db（已不存在）"],
      absent: ["接线一致"],
    },
  );

  // ⑤ 修掉的假绿：`release.includes("packages/" + name)` 的纯子串匹配
  subprocess(
    "⑤ 【反证·前缀误配】只写了 packages/acf-cli-legacy（不是 acf-cli）→ 红",
    pkgTree({
      release: releaseYml({
        mentions: ["acf-cli-legacy", "autocodeflow-node-sdk", "mcp-server", "autoflow-sdk"],
      }),
    }),
    { code: 1, contains: ["packages/acf-cli"], absent: ["接线一致"] },
  );

  // ⑥ 修掉的假绿：注释掉的发布项仍然子串命中
  subprocess(
    "⑥ 【反证·注释】**注释掉的** publish 项不算接线 → 红",
    pkgTree({
      release: releaseYml({
        mentions: ALL_WIRED.filter((d) => d !== "acf-cli"),
        commented: ["acf-cli"],
      }),
    }),
    { code: 1, contains: ["packages/acf-cli", "没有接进 release.yml"], absent: ["接线一致"] },
  );

  // ⑦ 修掉的假绿：清单解析失败被静默降级成「不可发布」→ 该包从判据里消失
  subprocess(
    "⑦ 【反证·坏清单】package.json 不可解析 → 结构红（旧实现静默跳过）",
    pkgTree({ broken: INERT_PRIVATE }),
    {
      code: 1,
      contains: ["结构错误", "package.json 不可解析", "packages/docs-site"],
      absent: ["接线一致", "Error:"],
    },
  );

  subprocess(
    "⑧ 【反证·扫描面】packages 只剩 3 个目录 → 结构红",
    pkgTree({ wired: [], baseline: [], inertPrivate: [], inertBare: ["a", "b", "c"] }),
    { code: 1, contains: ["结构错误", "只扫到 3 个 package", `下界 ${MIN_PACKAGES}`], absent: ["接线一致"] },
  );

  subprocess("⑨ 事实源缺失（release.yml 被删）→ 结构红且点名路径", pkgTree({ drop: [RELEASE_REL] }), {
    code: 1,
    contains: ["结构错误", `读不到 ${RELEASE_REL}`],
    absent: ["接线一致", "Error:", "ENOENT"],
  });

  // ⑩ 修掉的假绿：`--report` 不能让结构错误以 exit 0 通过
  subprocess(
    "⑩ 【反证·--report】报告模式遇到结构错误仍然 exit 1（先打印全表，再红）",
    pkgTree({ broken: INERT_PRIVATE }),
    { code: 1, contains: ["结构错误", "docs-site", "acf-cli"], absent: ["接线一致"] },
    ["--report"],
  );

  subprocess(
    "⑪ --report 干净树：打印全表 + 绿，退出码 0",
    pkgTree(),
    {
      code: 0,
      contains: ["✅ 已接线", "⚠️ 未接线", "（无发布清单，不适用）", "接线一致"],
      absent: ["✖"],
    },
    ["--report"],
  );

  const failed = reportCases(cases, { title: "check-publishable-wiring selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const report = process.argv.includes("--report");
    const { errors, problems, rows, counts } = check({ root });

    if (report) {
      for (const r of rows) {
        const tag = !r.publishable ? "（无发布清单，不适用）" : r.wired ? "✅ 已接线" : "⚠️ 未接线";
        console.log(`  ${r.name.padEnd(26)} ${tag}`);
      }
      console.log("");
    }

    // 结构错误优先：报告模式**不吞**红灯（旧实现在这里会先 exit(1)/抛栈，两者都没有可读诊断）。
    if (errors.length > 0) {
      console.error("");
      console.error("✖ 可发布包接线守卫结构错误（判据本身不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.newlyUnwired.length > 0 || problems.staleBaseline.length > 0) {
      console.error("");
      if (problems.newlyUnwired.length > 0) {
        console.error(
          `✖ ${problems.newlyUnwired.length} 个可发布包**没有接进 release.yml**（版本守卫与发布矩阵都覆盖不到）：`,
        );
        for (const n of problems.newlyUnwired) console.error("  · packages/" + n);
        console.error("  修法二选一：① 接进 .github/workflows/release.yml（version-guard + 对应 publish 矩阵）；");
        console.error("           ② 若它本该只在本仓内部使用，从 packages/ 移走，或让它成为 private 包。");
      }
      if (problems.staleBaseline.length > 0) {
        console.error(
          `✖ 基线里 ${problems.staleBaseline.length} 个包**已接线或已不存在** —— 基线该瘦身：`,
        );
        for (const p of problems.staleBaseline) console.error(`  · ${p.name}（${p.why}）`);
      }
      console.error("");
      process.exit(1);
    }

    console.log(
      `✔ 可发布包接线一致：${counts.publishables} 个可发布包中 ${counts.wired} 个已接线，` +
        `${counts.publishables - counts.wired} 个显式基线豁免（待产品决策）。`,
    );
  }
}
