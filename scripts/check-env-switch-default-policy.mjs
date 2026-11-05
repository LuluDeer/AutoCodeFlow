#!/usr/bin/env node
/**
 * R25（2026-11-05）：`SELFTEST_SKIP_ENV_FILE` **默认策略**的成文约定 + 机读守卫。
 *
 * ## 约定（成文于 `docs/operations.md`「自检环境隔离（SELFTEST_SKIP_ENV_FILE）」一节）
 *
 * 1. **测试夹具默认开**：任何跑测试的夹具/入口，必须在**断言之前**把
 *    `SELFTEST_SKIP_ENV_FILE=1` 放进环境（python `conftest.py` 已如此；jest 用 `setupFiles`）。
 * 2. **生产代码不得隐式默认开**：只有**显式** `=1` 才跳过 `.env`；缺省/其它值 ⇒ 照常读
 *    （R04/R23/R24 的三态语义，id 逐字对齐）。
 * 3. **自检脚本必须显式传**：跑自检/守卫/真机压测、且子进程会读 `.env` 的脚本，必须显式设置该键；
 *    **机制**：统一走 `scripts/lib/selftest-hermetic.mjs` 的 `hermeticEnv()`（它把键塞进子进程 env），
 *    由 `check:guard-harness` 的接线判据钉住"起 admin-api 的自检必须经 hermeticEnv"。
 *    本守卫断言的是**那个机制**（import + 使用 `hermeticEnv`），不是"碰巧没有 `.env`"。
 *
 * ## 判据
 *
 * ① 约定成文：`docs/operations.md` 有该节，且三条款的关键词都在；
 * ② python 夹具默认开：`apps/executor-python/tests/conftest.py` 里出现 `SELFTEST_SKIP_ENV_FILE`；
 * ③ admin-api jest 默认开：`apps/admin-api/package.json` 的 jest 配 `setupFiles`（或 `globalSetup`），
 *    且该 setup 文件里设置 `SELFTEST_SKIP_ENV_FILE`；
 * ④ executor-node jest：若有 spec 会导入 `main`（= 会读 `.env`），则必须同样有 setup 设置；
 *    若结构上没有 spec 导入 main（R23 守卫已钉），则要求 jest 配置里**显式声明豁免**（注释可读）；
 * ⑤ 自检脚本：`scripts/*selftest*.mjs` 中，凡 spawn 应用进程（`dist/main.js` / `python.*main.py`）的，
 *    必须 import 并使用 `hermeticEnv`。
 *
 * ## 反向验证
 * `--selftest`：正例 + 四个反例（删约定条款 / 删 python conftest 默认 / 删 admin jest setup /
 * 自检脚本去 hermeticEnv），逐个断言 exit 1 且点名。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");

export const DOC = "docs/operations.md";
export const PY_CONFTEST = "apps/executor-python/tests/conftest.py";
export const ADMIN_PKG = "apps/admin-api/package.json";
export const NODE_PKG = "apps/executor-node/package.json";
export const KEY = "SELFTEST_SKIP_ENV_FILE";

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
}

/** 读 jest 配置里的 setup 文件列表（setupFiles / setupFilesAfterEnv / globalSetup）。 */
export function jestSetupFiles(pkg) {
  const jest = pkg?.jest ?? {};
  const out = [];
  for (const key of ["setupFiles", "setupFilesAfterEnv", "globalSetup"]) {
    const v = jest[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === "string"));
  }
  return out;
}


/**
 * 把 jest 的 setup 路径解析成文件内容（找不到返回 null）。
 *
 * jest 的路径**相对 `rootDir`**，且常写成 `<rootDir>/xxx`；而各包的 `rootDir` 不同
 * （admin-api 是 `src`、executor-node 默认包根）⇒ 两种基准都试，并剥掉 `<rootDir>/` 前缀。
 */
function resolveSetupFile(root, pkgDir, rel) {
  const cleaned = String(rel).replace(/^<rootDir>\//, "").replace(/^\.\//, "");
  const candidates = [
    join(root, pkgDir, cleaned),
    join(root, pkgDir, "src", cleaned),
    join(root, cleaned),
  ];
  for (const abs of candidates) {
    if (existsSync(abs)) return readFileSync(abs, "utf8");
  }
  return null;
}


/** admin-api jest 缺口的登记文件（why + review_by；过期即红）。 */
export const ADMIN_JEST_GAP_FILE = "scripts/env-switch-known-gaps.json";

/** 读登记缺口；不存在或非法 ⇒ null（视同未登记 ⇒ 红）。 */
function adminJestGap(root) {
  const abs = join(root, ADMIN_JEST_GAP_FILE);
  if (!existsSync(abs)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
  const entry = (parsed?.gaps ?? []).find((g) => g?.id === "admin-api-jest-env-file");
  if (!entry || typeof entry.why !== "string" || entry.why.length < 20) return null;
  if (typeof entry.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.review_by)) return null;
  return { reviewBy: entry.review_by, expired: entry.review_by < "2026-11-05" };
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const read = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      errors.push(`读不到 ${rel}`);
      return null;
    }
    return readFileSync(abs, "utf8");
  };

  // ① 约定成文
  const doc = read(DOC);
  if (doc) {
    const section = doc.includes("自检环境隔离") && doc.includes(KEY);
    if (!section) {
      errors.push(`${DOC} 缺少「自检环境隔离（${KEY}）」一节 —— 约定没有成文，守卫就没有依据`);
    } else {
      const clauses = [
        { needle: "测试夹具默认开", why: "第 1 条（测试夹具默认开）" },
        { needle: "不得隐式默认开", why: "第 2 条（生产代码不得隐式默认开）" },
        { needle: "必须显式传", why: "第 3 条（自检脚本必须显式传）" },
      ];
      for (const c of clauses) {
        if (!doc.includes(c.needle)) errors.push(`${DOC} 的约定缺 ${c.why} —— 关键词「${c.needle}」不在文中`);
      }
    }
  }

  // ② python 夹具默认开
  const pyConftest = read(PY_CONFTEST);
  if (pyConftest && !stripComments(pyConftest).includes(KEY)) {
    errors.push(`${PY_CONFTEST} 没有设置 ${KEY} —— python 测试夹具不再默认干净`);
  }

  // ③ admin-api jest 默认开
  const adminPkgText = read(ADMIN_PKG);
  if (adminPkgText) {
    let pkg = null;
    try {
      pkg = JSON.parse(adminPkgText);
    } catch (e) {
      errors.push(`${ADMIN_PKG} 不是合法 JSON：${e.message}`);
    }
    if (pkg) {
      const setups = jestSetupFiles(pkg);
      const hit = setups.find((rel) => resolveSetupFile(root, "apps/admin-api", rel)?.includes(KEY));
      if (!hit) {
        // R25 实测：把 admin-api 的 jest 夹具默认切到「不读 .env」会导致
        // **57 个既有 spec 失败**（1846 个用例里）——它们直接/间接依赖开发者 `.env`
        // 提供的值（`ConfigModule` 读到的键、`data-source.ts` 的 dotenv）。
        // 这不是"守卫放宽"，而是**登记一处已知缺口**：缺口必须有 why + review_by，
        // 到期即红（与 ADR-030 / R08 的豁免同款纪律）。
        // R26：admin-api 已真正满足（`setupFiles` 挂载 + 夹具自带最小配置值）。
        // 故这里**收紧**为硬要求 —— 不再接受"缺口登记"作为替代（R25 那条已被实测收敛）。
        errors.push(
          `${ADMIN_PKG} 的 jest 没有配置设置 ${KEY} 的 setupFiles —— 单测会把开发者 .env 读进来` +
            `（R26 起这是硬要求：夹具自带最小配置值，不再接受缺口豁免）`,
        );
      }
    }
  }

  // ④ executor-node jest：结构化豁免必须显式声明
  const nodePkgText = read(NODE_PKG);
  if (nodePkgText) {
    let pkg = null;
    try {
      pkg = JSON.parse(nodePkgText);
    } catch (e) {
      errors.push(`${NODE_PKG} 不是合法 JSON：${e.message}`);
    }
    if (pkg) {
      const setups = jestSetupFiles(pkg);
      const hasSetup = setups.some((rel) => resolveSetupFile(root, "apps/executor-node", rel)?.includes(KEY));
      const jestObj = pkg.jest ?? {};
      const declaredExempt = JSON.stringify(jestObj["//envHermetic"] ?? "").includes("不读 .env");
      if (!hasSetup && !declaredExempt) {
        errors.push(
          `${NODE_PKG} 的 jest 既没有设置 ${KEY} 的 setup，也没有 \`jest["//envHermetic"]\` 的显式豁免说明 —— ` +
            `无法区分"结构上不读 .env"与"忘了设"`,
        );
      }
    }
  }

  // ⑤ 自检脚本必须经 hermeticEnv（凡 spawn 应用进程者）
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      if (!name.endsWith(".mjs") || !name.includes("selftest")) continue;
      const rel = `scripts/${name}`;
      const text = stripComments(readFileSync(join(scriptsDir, name), "utf8"));
      // 判据按**行**：同一行里既要出现"启动进程"的动作，又要出现"应用入口路径"。
      // 只提到路径（注释/读文件做静态检查）不算 —— 否则 `read('apps/registry-pypi/main.py')`
      // 这种"把入口当文本读"会被误判为"起应用进程"（本轮实测的假阳之一）。
      const LAUNCH = /\bspawn(Sync)?\s*\(|\bexecFile(Sync)?\s*\(|\bexecSync\s*\(/;
      const APP_ENTRY = /dist\/main\.js|executor-python\/main\.py|registry-pypi\/main\.py/;
      const spawnsApp = text
        .split("\n")
        .some((line) => LAUNCH.test(line) && APP_ENTRY.test(line));
      if (!spawnsApp) continue;
      if (!/hermeticEnv\s*\(/.test(text)) {
        errors.push(
          `${rel} 会起应用进程却没有用 \`hermeticEnv()\` —— 子进程会读开发者 .env；` +
            `改用 scripts/lib/selftest-hermetic.mjs 的 hermeticEnv（机制见约定第 3 条）`,
        );
      }
    }
  }

  return errors;
}

// ── 自检：正例 + 四个反例 ────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

const DOC_OK = `## 自检环境隔离（SELFTEST_SKIP_ENV_FILE）

1. **测试夹具默认开**：夹具在断言之前设置。
2. **生产代码不得隐式默认开**：只有显式 "1" 才跳过。
3. **自检脚本必须显式传**：走 hermeticEnv()。
`;

function fixtureTree(over = {}) {
  return {
    [DOC]: over.doc ?? DOC_OK,
    [PY_CONFTEST]: over.pyConftest ?? "os.environ.setdefault('SELFTEST_SKIP_ENV_FILE', '1')\n",
    [ADMIN_PKG]: over.adminPkg ??
      JSON.stringify({ jest: { setupFiles: ["<rootDir>/test/setup-env.ts"] } }, null, 2),
    "apps/admin-api/test/setup-env.ts": "process.env.SELFTEST_SKIP_ENV_FILE = '1';\n",
    [NODE_PKG]: over.nodePkg ??
      JSON.stringify({ jest: { "//envHermetic": "结构上不读 .env：无 spec 导入 main" } }, null, 2),
    "scripts/foo-selftest.mjs": over.script ??
      "import { hermeticEnv } from './lib/selftest-hermetic.mjs';\nspawn('node', ['dist/main.js'], { env: hermeticEnv({}) });\n",
  };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const run = (over, expect) => () => {
    const repo = makeFixtureRepo(fixtureTree(over));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { ...expect, withinMs: 20000 });
    } finally {
      repo.cleanup();
    }
  };

  push("正例控制组：约定成文 + 三端默认开 + 自检走 hermeticEnv ⇒ exit 0",
    run({}, { code: 0, label: "正例" }));

  push("反例①：约定缺第 3 条 ⇒ exit 1 且点名",
    run({ doc: DOC_OK.replace("3. **自检脚本必须显式传**：走 hermeticEnv()。", "") },
      { code: 1, contains: ["必须显式传"], label: "约定缺条款" }));

  push("反例②：python 夹具删掉默认值 ⇒ exit 1 且点名 conftest",
    run({ pyConftest: "import os\n" },
      { code: 1, contains: ["conftest.py", "SELFTEST_SKIP_ENV_FILE"], label: "python 夹具" }));

  push("反例③：admin jest 删掉 setup ⇒ exit 1 且点名",
    run({ adminPkg: JSON.stringify({ jest: {} }, null, 2) },
      { code: 1, contains: ["setupFiles"], label: "admin jest" }));

  push("反例④：自检脚本不用 hermeticEnv ⇒ exit 1 且点名该脚本",
    run({ script: "spawn('node', ['dist/main.js'], { env: process.env });\n" },
      { code: 1, contains: ["foo-selftest.mjs", "hermeticEnv"], label: "自检脚本" }));

  const failed = reportCases(cases, { title: "check-env-switch-default-policy selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  if (errors.length === 0) {
    console.log(
      `✔ ${KEY} 默认策略守卫通过：约定已成文（docs/operations.md），python 夹具 / admin jest 默认开，` +
        `executor-node jest 有显式结构化豁免，自检脚本均经 hermeticEnv。`,
    );
    return 0;
  }
  console.error(`✘ ${KEY} 默认策略守卫：${errors.length} 项不满足`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
