#!/usr/bin/env node
/**
 * 「可发布包必须接线」守卫。
 *
 * 由来：`packages/autocodeflow-{ai,http,notify,db}` 四个包有源码 + 测试 + pyproject + CHANGELOG，
 * 却**不在** `release.yml` 的 version-guard 里、**不在**任何 publish 矩阵里、**版本停在 0.3.2**
 * （平台主线已到 **2.1.x**）。
 *
 * ⚠️ 〔2026-11-03 事实核查更正〕四包的 `0.3.2` **不是**「落后平台主线」，而是**它们自己的
 * 独立 semver 线**：`release-please` 的 `linked-versions` 组 `autocodeflow-py-libs` 在推进它，
 * `git tag` 里 `autocodeflow-{ai,db,http,notify}-v0.3.2` 四包**同日真实存在**（2026-10-26），
 * `ci.yml` 还有四包矩阵测试。两条版本线不共线 ⇒「落后一整条 major」是错误的框架。
 * 详见 `docs/OPEN-DECISIONS.md` A2。另：它们**面向仓外用户**，仓内零消费者是**设计意图**，不是缺陷。
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
 *   ⑤ **豁免条目必须是结构化对象** `{ owner, review_by, disposition, reason }`（A7，2026-11-03）：
 *      缺字段 / `disposition` 不在枚举内 / `review_by` 不是 `YYYY-MM-DD` / `reason` 短于 20 字
 *      ⇒ **结构红**（判据本身不可信）。旧的「一段中文理由」形态已被移除。
 *   ⑥ **`review_by` 过期即红**（A7 核心）：过期意味着「该做决策了」，不是「继续躺着」。
 *      改期必须显式改 `review_by`（留下一次人为决策的痕迹），而不是让豁免变成无限期。
 *      可用 `--today YYYY-MM-DD` 指定判定日（仅供 selftest 做确定性断言；主跑不吃这个参数）。
 *
 * 为什么基线里那四个不直接判红：它们的存在与否是**产品决策**（接进发布线 / 冻结 / 吸收 / 删除），
 * 守卫的职责不是替人做决定，而是让这个状态**不能安静地待着** —— 且**必须有一个到期日**。
 * 一旦有人加第五个这样的包，立刻红。
 *
 * ## A7（2026-11-03）：从「一段理由」升级成「一笔账」
 *
 * 旧基线是 `Map<包名, 一句中文理由>`。实测两个问题：
 *   ① 理由里可以写任何东西，包括**写错的事实** —— 原先四条都写着「落后平台主线 1.15.x」，
 *      而那四个包根本不与平台共用版本线；一条写错的豁免理由比没有理由更危险，
 *      因为下一个复核者会直接采纳它。
 *   ② **永远不会到期**：它可以绿着漂很多年，没人被强制回来做一次决策。
 * 开源先例（Nx `@nrwl/*`→`@nx/*`：旧线冻结在 19.8.4，新线已到 24.0.3，版本差比本仓还大，
 * 但那**不是僵尸包**，因为它被登记进了迁移路径）：**漂移本身不是罪，未登记的漂移才是罪。**
 * 故本守卫把「登记」做实：谁负责、何时必须给答复、打算怎么处置。
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
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "subprocess");

export const PKGS_REL = "packages";
export const RELEASE_REL = ".github/workflows/release.yml";

/** 扫描面下界（2026-10-29 实测：11 个包目录 / 8 个可发布）。只增不减，防「分母塌了」。 */
export const MIN_PACKAGES = 8;

/**
 * 豁免允许的处置枚举（A7）。取值含义与依据见 `docs/OPEN-DECISIONS.md` A2：
 *   · `publish-later` —— 打算接进 Publish 线，只是还没做（reason 要写清差哪一步）；
 *   · `freeze`        —— 不再前进，冻结当前版次并在文档/发布渠道标注「不对外发布」；
 *   · `absorb`        —— 能力已被仓内其它实现覆盖，逐步并入后删源；
 *   · `delete`        —— 删掉（须按 PEP 594 式先给时间表与理由，不得静默删除）。
 */
export const ALLOWED_DISPOSITIONS = new Set([
  "publish-later",
  "freeze",
  "absorb",
  "delete",
]);

/** 判「今天」用的日期（`YYYY-MM-DD`，与 `review_by` 同形，可直接字符串比较）。 */
export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 已知未接线（**待产品决策**）。A7（2026-11-03）起每条是结构化对象
 * `{ owner, review_by, disposition, reason }`：形状不合法 ⇒ 结构红；过 `review_by` ⇒ 红。
 *
 * 四包 disposition 的依据（2026-11-03 实测，详见
 * `artifacts/rounds/2026-11-03-gov-inventory.md` §3.3 与 `r2-a7-a9.md`）：
 *   · http   → `freeze`：仓内已有两份等价物（`autoflow-sdk/autoflow_sdk/http.py` 363 行 +
 *              `autocodeflow-node-sdk/src/http-client.ts` 910 行），三端是**刻意的同构对齐**
 *              （git `59b5ebe4` / `e6513f95` 同批改三份）；
 *   · ai     → `freeze`：`admin-api/src/modules/ai/ai-analysis.service.ts` 已覆盖
 *              （ARCH-30 自述「packages/autocodeflow-ai 本体零改动——消费面是 TS AiService」）；
 *   · notify → `freeze`：`admin-api` 的 notification 模块已覆盖（7 渠道扇出 + SSRF 守卫 + 信封契约）；
 *   · db     → `publish-later`：**四包里唯一没有仓内等价物**的通用 DB 连接小工具，
 *              若要对外分发，它优先级最高（只差一个 publish job）。
 */
export const UNWIRED_BASELINE = new Map([
  [
    "autocodeflow-ai",
    {
      owner: "product",
      review_by: "2026-12-15",
      disposition: "freeze",
      reason:
        "仓内能力已由 admin-api 的 TS AiService 覆盖（ARCH-30 自述该库本体零改动）；" +
        "冻结当前 0.3.2 版次。决策点＝按 freeze 在 README 标注「不对外发布」，或改为 absorb 并入 autoflow-sdk。",
    },
  ],
  [
    "autocodeflow-http",
    {
      owner: "product",
      review_by: "2026-12-15",
      disposition: "freeze",
      reason:
        "仓内已有两份等价实现（autoflow-sdk http.py / node-sdk http-client.ts，三端刻意同构对齐）；" +
        "冻结 0.3.2。决策点＝freeze 定案（标注不发布）还是 absorb 进 autoflow-sdk。",
    },
  ],
  [
    "autocodeflow-notify",
    {
      owner: "product",
      review_by: "2026-12-15",
      disposition: "freeze",
      reason:
        "admin-api 的 notification 模块已覆盖（7 渠道扇出 + SSRF 守卫 + 信封契约）；冻结 0.3.2。" +
        "决策点＝freeze 定案还是 absorb；若将来要让任务代码直连通知渠道，则改 publish-later。",
    },
  ],
  [
    "autocodeflow-db",
    {
      owner: "product",
      review_by: "2026-12-15",
      disposition: "publish-later",
      reason:
        "四包里唯一没有仓内等价物的通用 DB 连接小工具；接发布线只差一个 publish job" +
        "（matrix 4 包 + 复用既有钉死 SHA 的 pypa action）。决策点＝确认对外分发就接线，否则转 freeze。",
    },
  ],
]);

/**
 * 校验一条豁免条目的形状。返回问题文本数组（空数组 = 合规）。
 *
 * 抽成纯函数的原因：形状校验必须能被 selftest **直接断言**（不必造 fixture 树），
 * 否则「加一个新包时随手写一段字符串」这种退化不会被任何用例抓住。
 */
export function baselineEntryProblems(name, entry) {
  const at = 'UNWIRED_BASELINE["' + name + '"]';
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [
      at +
        " 必须是对象 { owner, review_by, disposition, reason }（收到 " +
        JSON.stringify(entry) +
        "）——一段裸字符串的豁免既没有责任人也没有到期日，等同于永不移交。",
    ];
  }
  const out = [];
  if (typeof entry.owner !== "string" || entry.owner.trim() === "") {
    out.push(at + ".owner 缺失——没有责任人的豁免等于没人管。");
  }
  if (typeof entry.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.review_by)) {
    out.push(
      at +
        ".review_by 必须是 YYYY-MM-DD（收到 " +
        JSON.stringify(entry.review_by) +
        "）——无限期豁免等于永不移交。",
    );
  }
  if (!ALLOWED_DISPOSITIONS.has(entry.disposition)) {
    out.push(
      at +
        ".disposition 必须是 " +
        [...ALLOWED_DISPOSITIONS].join(" / ") +
        " 之一（收到 " +
        JSON.stringify(entry.disposition) +
        "）。",
    );
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
    out.push(at + ".reason 至少 20 字，说清「为什么现在不接线」与「决策后做什么」。");
  }
  return out;
}

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
export function check({
  root = process.cwd(),
  baseline = UNWIRED_BASELINE,
  today = todayISO(),
} = {}) {
  const errors = [];
  const rows = [];
  const problems = { newlyUnwired: [], staleBaseline: [], expiredBaseline: [] };
  const counts = { packages: 0, publishables: 0, wired: 0, baseline: baseline.size, root };

  // ⑤ A7：先把豁免账本身的形状验掉。账写错了，后面的「接线一致」就是假绿。
  for (const [name, entry] of baseline) {
    for (const problem of baselineEntryProblems(name, entry)) errors.push(problem);
  }
  // ⑥ A7：过期判定只需要字符串比较（两边都是 YYYY-MM-DD）。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    errors.push(`--today 必须是 YYYY-MM-DD（收到 ${JSON.stringify(today)}）——判定日不可解析等于判据失效。`);
  }

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

  // ⑥ A7：只对**仍然未接线且仍存在**的条目判过期。
  // 已经接线 / 已消失的条目由 staleBaseline 负责（否则同一条会报两次，人只会看第一条）。
  problems.expiredBaseline = [...baseline.entries()]
    .filter(([name, entry]) => {
      if (!unwired.includes(name)) return false;
      const reviewBy = entry?.review_by;
      if (typeof reviewBy !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return false;
      return reviewBy < today;
    })
    .map(([name, entry]) => ({
      name,
      review_by: entry.review_by,
      disposition: entry.disposition,
      owner: entry.owner,
    }));

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
 * 自检：16 条用例（A7 起 +5：⑫到期红 / ⑬控制组 / ⑭坏判定日 / ⑮--report 不吞 / ⑯条目形态），
 * 前 11 条全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
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

  // A7：显式 `--today` 让本用例**不随日历腐烂**。
  // 真实到期由「主跑」（不带 --today，吃系统日期）负责 —— 那才是要红的地方。
  subprocess("① 干净树：4 个已接线 / 4 个基线豁免 / 3 个不可发布 → 绿", pkgTree(), {
    code: 0,
    contains: ["可发布包接线一致：8 个可发布包中 4 个已接线，4 个显式基线豁免"],
    absent: ["没有接进", "结构错误", "基线该瘦身", "已过 review_by"],
  }, ["--today", "2026-01-01"]);

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

  // ── A7（2026-11-03）：豁免是一笔「账」，不是一段话 ─────────────────────────
  // ⑫⑬ 用 `--today` 把时间推到基线之后 / 之前，证明到期判定**两个方向都有牙**。
  // ⑬ 是 ⑫ 的控制组：否则「永远红」也能让 ⑫ 通过。
  subprocess(
    "⑫ 【A7·到期即红】把判定日推到 review_by 之后（2099-01-01）→ 红，点名过期包与 disposition",
    pkgTree(),
    {
      code: 1,
      contains: [
        "已过 review_by（2099-01-01）",
        "豁免到期即红",
        "packages/autocodeflow-ai（disposition=freeze",
        "packages/autocodeflow-db（disposition=publish-later",
      ],
      absent: ["接线一致"],
    },
    ["--today", "2099-01-01"],
  );

  subprocess(
    "⑬ 【A7·控制组】判定日早于 review_by（2020-01-01）→ 绿（证明 ⑫ 不是「恒红」）",
    pkgTree(),
    { code: 0, contains: ["接线一致"], absent: ["已过 review_by"] },
    ["--today", "2020-01-01"],
  );

  subprocess(
    "⑭ 【A7·坏判定日】--today 不可解析 → 结构红（判定日坏了等于判据失效）",
    pkgTree(),
    { code: 1, contains: ["结构错误", "--today 必须是 YYYY-MM-DD"], absent: ["接线一致"] },
    ["--today", "not-a-date"],
  );

  subprocess(
    "⑮ 【A7·--report 也不吞过期红】报告模式遇过期仍 exit 1，但先打印含 disposition 的全表",
    pkgTree(),
    {
      code: 1,
      contains: ["disposition=freeze", "已过 review_by", "autocodeflow-http"],
      absent: ["接线一致"],
    },
    ["--today", "2099-01-01", "--report"],
  );

  // ⑯ 纯函数级：豁免条目形状校验（不造 fixture 树，直接断言 5 种退化形态每条都被抓住）
  cases.push({
    name: "⑯ 【A7·条目形态】缺 owner / 坏 review_by / 非法 disposition / 理由过短 / 裸字符串 逐条被判",
    fn: () => {
      const problemCount = (entry) => baselineEntryProblems("p", entry).length;
      const good = {
        owner: "product",
        review_by: "2026-12-15",
        disposition: "freeze",
        reason: "理由写够二十个字以上才算说清楚了为什么不接线以及决策后做什么。",
      };
      const expectProblem = (entry, needle, label) => {
        const problems = baselineEntryProblems("p", entry);
        if (problems.length === 0) throw new Error(`${label}：应当被判红，实际零问题`);
        if (!problems.join("\n").includes(needle)) {
          throw new Error(`${label}：问题文本里没有 ${JSON.stringify(needle)}，收到：\n${problems.join("\n")}`);
        }
      };
      if (problemCount(good) !== 0) {
        throw new Error(`正例（合规条目）被判红了：\n${baselineEntryProblems("p", good).join("\n")}`);
      }
      expectProblem(undefined, "必须是对象", "裸 undefined");
      expectProblem("待决策：接进发布线或删除", "必须是对象", "裸字符串（旧形态）");
      expectProblem({ ...good, owner: "  " }, ".owner", "owner 空白");
      expectProblem({ ...good, review_by: "2026/12/15" }, ".review_by", "日期分隔符错");
      expectProblem({ ...good, disposition: "publish" }, ".disposition", "枚举外取值");
      expectProblem({ ...good, reason: "太短" }, ".reason", "理由过短");
      expectProblem({ ...good, review_by: "2026-12-15", disposition: undefined }, ".disposition", "缺 disposition");
    },
  });

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
    const today = argValue(process.argv, "--today") ?? todayISO();
    const { errors, problems, rows, counts } = check({ root, today });

    if (report) {
      for (const r of rows) {
        const tag = !r.publishable ? "（无发布清单，不适用）" : r.wired ? "✅ 已接线" : "⚠️ 未接线";
        // A7：未接线的包顺带把「谁负责 / 何时必须答复 / 打算怎么处置」打在报告里，
        // 否则豁免账只有红的时候才可见，平时没人看见它。
        const entry = UNWIRED_BASELINE.get(r.name);
        const ledger = entry
          ? `  [${entry.disposition} · owner=${entry.owner} · review_by=${entry.review_by}` +
            (entry.review_by < today ? " · ⏰已过期]" : "]")
          : "";
        console.log(`  ${r.name.padEnd(26)} ${tag}${ledger}`);
      }
      console.log(`  （判定日 today=${today}）`);
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

    if (
      problems.newlyUnwired.length > 0 ||
      problems.staleBaseline.length > 0 ||
      problems.expiredBaseline.length > 0
    ) {
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
      if (problems.expiredBaseline.length > 0) {
        console.error(
          `✖ ${problems.expiredBaseline.length} 个基线豁免**已过 review_by（${today}）** —— ` +
            `豁免到期即红：请先做决策，再显式改 review_by（不许把日期往后一推了事）：`,
        );
        for (const p of problems.expiredBaseline) {
          console.error(
            `  · packages/${p.name}（disposition=${p.disposition}，owner=${p.owner}，review_by=${p.review_by}）`,
          );
        }
        console.error("  三个可选动作（详见 docs/OPEN-DECISIONS.md A2）：");
        console.error("    ① 接进 release.yml 的 publish 矩阵（version-guard + 对应 publish job）；");
        console.error("    ② 按 disposition=freeze/delete 落地，然后从 UNWIRED_BASELINE 移除该条；");
        console.error("    ③ 确有理由继续等：改 review_by 并写清「等到什么证据才能决策」。");
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
