#!/usr/bin/env node
/**
 * R224：**`typecheck:all` 必须覆盖「spec 层」** —— 一条声明式判据。
 *
 * ## 为什么需要它（R222/R223 的真实事故）
 *
 * R222 给 `AgentQueueStallService` 加了一个**必填**构造器参数。既有 spec 用**定位参数**装配
 * （`new AgentQueueStallService(queue)`）⇒ `agent-queue-stall.service.spec.ts` **整个套件编译失败**。
 *
 * 但当时所有局部信号都是绿的：
 * - `tsc --noEmit`（= `typecheck:api`）**0 错** —— 它用的是 `tsconfig.json`，**不含 spec**；
 * - `npm test` 汇总行写 **`Tests: 26 passed`** —— 因为 Jest 对「套件编译失败」只打
 *   `Test suite failed to run`、**用例按 0 计**，那 26 来自**别的套件**。
 *
 * ⇒ 唯一能抓住它的是 `tsc -p tsconfig.spec.json`（= `typecheck:specs`）。
 * 而它**在 CI 里有跑**（`ci.yml` 的 `npm run typecheck:specs`），**但根级 `typecheck:all` 不含它**
 * ⇒ 任何把 `typecheck:all` 当「全量类型检查门禁」的人（本仓多处文档如此引用）都会得到**假绿**。
 *
 * ## 判据（5 条）
 *
 *  ① 根 `package.json` 必须定义 `typecheck:specs`；
 *  ② 根 `typecheck:all` 的串行链里**必须**包含 `npm run typecheck:specs`；
 *  ③ 该脚本必须真的用 **`-p tsconfig.spec.json`**（否则它和 `typecheck:api` 是同一个门禁，
 *     包含它只是给人「我查过 spec 了」的错觉）；
 *  ④ `.github/workflows/` 里必须有一步真跑它（本地门禁与 CI 不能只接一面）；
 *  ⑤ **R225（同一根因的推广）**：每个 TS 子项目定义的 `typecheck*` 脚本，
 *     都必须被 `typecheck:all` **展开后**覆盖到 —— 把链**展开**成「实际会执行的
 *     (项目, tsconfig) 集合」再逐项核对，**不按脚本名硬对应**（那是猜）。
 *     排除面显式两条：`:report` 后缀（恒 exit 0，不是门禁）· `apps/admin-web`（`tsc -b` 已拉齐）。
 *
 * ## 反例（本脚本在 `--selftest` 里逐条验证，共 7 条）
 *
 * 去掉 ② 的链环、把 ③ 换成 `tsconfig.json`、把 ④ 的 CI step 删掉、
 * 子项目有 `typecheck:renderer` 而链里没有 —— 四种都必须红；两个正例必须绿。
 *
 * 用法：`node scripts/check-typecheck-covers-specs.mjs [--selftest] [--root <dir>]`
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R160 覆盖计数出口：必须在**任何依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "checkCase");

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
export const DEFAULT_ROOT = resolve(HERE, "..");

const SCRIPT_NAME = "typecheck:specs";
const SPEC_TSCONFIG = "tsconfig.spec.json";

/**
 * 跑判据。
 *
 * @returns `{ ok: boolean, failures: string[] }`（纯函数式：不 process.exit，便于 selftest）
 */
export function checkTypecheckCoversSpecs(root = DEFAULT_ROOT) {
  const failures = [];

  // ── ① 根级必须定义 typecheck:specs ──────────────────────────────────────
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return { ok: false, failures: [`缺 package.json（root=${root}）`] };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { ok: false, failures: [`package.json 不是合法 JSON：${err.message}`] };
  }
  const scripts = pkg.scripts ?? {};

  if (typeof scripts[SCRIPT_NAME] !== "string") {
    failures.push(
      `根 package.json 缺 \`${SCRIPT_NAME}\` —— 没有它，spec 层的编译错误在本地**无处可查**`,
    );
  }

  // ── ② typecheck:all 必须串上它 ──────────────────────────────────────────
  const all = scripts["typecheck:all"];
  if (typeof all !== "string") {
    failures.push("根 package.json 缺 `typecheck:all`");
  } else if (!all.includes(`npm run ${SCRIPT_NAME}`)) {
    failures.push(
      `\`typecheck:all\` 的链里**没有** \`npm run ${SCRIPT_NAME}\` —— ` +
        `被判据引为「全量类型检查门禁」的入口漏了 spec 层（R222/R223 的真实事故形态）`,
    );
  }

  // ── ③ 它必须真的用 spec 的 tsconfig ────────────────────────────────────
  const specCmd = scripts[SCRIPT_NAME];
  if (typeof specCmd === "string" && !specCmd.includes(SPEC_TSCONFIG)) {
    failures.push(
      `\`${SCRIPT_NAME}\` 必须显式用 \`-p ${SPEC_TSCONFIG}\`（当前：\`${specCmd}\`）—— ` +
        `否则它与 \`typecheck:api\` 是同一个门禁，包含它只是「看起来查过 spec」`,
    );
  }

  // ── ④ CI 里必须有真跑它的一步 ──────────────────────────────────────────
  const wfDir = join(root, ".github", "workflows");
  let ciRuns = false;
  if (!existsSync(wfDir)) {
    failures.push("缺 .github/workflows/ —— 无法确认 CI 是否跑 spec 门禁");
  } else {
    for (const f of readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const src = readFileSync(join(wfDir, f), "utf8");
      // 允许两种形态：直接 `npm run typecheck:specs`，或经 `npm run typecheck:all` 间接覆盖。
      if (src.includes(`npm run ${SCRIPT_NAME}`) || src.includes("npm run typecheck:all")) {
        ciRuns = true;
        break;
      }
    }
    if (!ciRuns) {
      failures.push(
        `\`.github/workflows/\` 里没有任何一步跑 \`npm run ${SCRIPT_NAME}\` 或 \`npm run typecheck:all\` ` +
          `—— 本地门禁与 CI 不能只接一面`,
      );
    }
  }

  // ── ⑤ 每个子项目定义的 typecheck 脚本都必须被 typecheck:all 覆盖 ────────
  // R225：这是 R224 的**同类根因推广**。R224 修的是「typecheck:all 漏了 typecheck:specs」；
  // 本轮事实核对发现**同一形态还有一处**：`apps/executor-desktop` 定义了
  // `typecheck:renderer`（覆盖 11k 行 renderer），而根 `typecheck:desktop` 只跑
  // `tsconfig.json` + `tsconfig.worker.json` ⇒ **renderer 不在 typecheck:all 的覆盖面里**。
  // CI 有跑它（`ci.yml` 的 `npm run typecheck:renderer`），所以不是「没人查」，
  // 而是「**被判据引为全量门禁的入口**没有它」—— 两者差别很大：前者 CI 会红，
  // 后者只在有人**拿 typecheck:all 当验收**时给出假绿。
  //
  // ## 判法：把 `typecheck:all` **展开**成「实际会执行的 (项目, 命令) 集合」，再逐项核对
  //
  // 不能按脚本名硬对应（`typecheck:api` → `apps/admin-api`、`typecheck:desktop` → 含 worker），
  // 那是猜。⇒ 展开法：根链里每个 `npm run X` 取根脚本 X 的正文，若是 `cd <proj> && ...` 形态
  // 就归属到 `<proj>`，并抽出其中的 `tsc -p <cfg>`；最后核对「子项目定义了的每个 typecheck
  // 命令，是否都在展开集合里出现过」。
  //
  // 排除面（**必须显式**，不能靠「正好没扫到」）：
  //  · `:report` 后缀 —— 恒 exit 0 的报告模式，**不是门禁**（串进去等于关灯键）；
  //  · `apps/admin-web` —— 它用 `tsc -b`（project references）一次拉齐全部 tsconfig。
  const REPORT_SUFFIX = ":report";
  const TSC_BUILD_PROJECTS = new Set(["apps/admin-web"]);
  const TS_PROJECTS = [
    "apps/admin-api",
    "apps/executor-node",
    "apps/executor-desktop",
    "apps/admin-web",
    "packages/acf-cli",
    "packages/mcp-server",
    "packages/autocodeflow-node-sdk",
  ];

  /** 把 `typecheck:all` 展开成「执行过的命令片段」文本（够判据用即可）。 */
  const expandAll = (chain, seen = new Set()) => {
    let text = "";
    for (const m of String(chain ?? "").matchAll(/npm run ([\w:-]+)/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      const body = scripts[name];
      if (typeof body !== "string") continue;
      text += `\n${body}`;
      // 根脚本可能再引用别的根脚本（如 typecheck:desktop 引用 typecheck:worker）
      if (/npm run /.test(body)) text += expandAll(body, seen);
    }
    return text;
  };
  // ⚠️ 必须**把 `typecheck:all` 自身正文也算进去**：内联形态（`cd <proj> && npx tsc -p <cfg>`）
  // 就写在它自己的正文里，`expandAll` 只展开 `npm run X` 引用到的子脚本。
  const expanded = `${all}\n${expandAll(all)}`;

  for (const proj of TS_PROJECTS) {
    if (TSC_BUILD_PROJECTS.has(proj)) continue;
    const projPkgPath = join(root, proj, "package.json");
    if (!existsSync(projPkgPath)) continue;
    let projPkg;
    try {
      projPkg = JSON.parse(readFileSync(projPkgPath, "utf8"));
    } catch {
      failures.push(`${proj}/package.json 不是合法 JSON`);
      continue;
    }
    const projScripts = projPkg.scripts ?? {};
    for (const [name, cmd] of Object.entries(projScripts)) {
      if (!/^typecheck/.test(name)) continue;
      if (name.endsWith(REPORT_SUFFIX)) continue;
      if (typeof cmd !== "string") continue;
      // 抽出该脚本用的 tsconfig（`-p <cfg>` 或 `-p=<cfg>`）；抽不到 tsconfig 的命令
      // （例如 `tsc --noEmit`）在展开文本里以「项目 + 无 -p」形态判定。
      const cfgMatch = cmd.match(/-p\s+(\S+)/);
      const cfg = cfgMatch ? cfgMatch[1].replace(/^["']|["']$/g, "") : "tsconfig.json";
      // 判据：展开文本里必须能找到「这个项目」+「这个 tsconfig」同时出现。
      const covered = expanded.includes(proj) && expanded.includes(cfg);
      if (!covered) {
        failures.push(
          `${proj}/package.json 定义了 \`${name}\`（\`${cmd}\`，读 \`${cfg}\`），` +
            `但根 \`typecheck:all\` 展开后**没有**覆盖它 —— 「全量类型检查门禁」漏掉了这块代码`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

async function main() {
  const argv = process.argv.slice(2);
  const rootArgIdx = argv.indexOf("--root");
  const root = rootArgIdx >= 0 ? resolve(argv[rootArgIdx + 1]) : DEFAULT_ROOT;

  if (argv.includes("--selftest")) {
    // R-黑盒化：每条用例都起**真子进程**跑本脚本 CLI（`runGuard(SELF, …)` + `expectExit`），
    // 不再进程内直调 `checkTypecheckCoversSpecs()`。旧版完全跳过 `main()` 的退出码与
    // `--root` 解析：把 main 的 `process.exit(1)` 改成 `exit(0)`，7/7 selftest 仍全绿、
    // CLI 打印 ✘ 却 exit 0 ⇒ CI 转绿。黑盒后「退出码 0/1」与观测文本本身成为断言面。
    // 本守卫 main 只认 `--root <dir>`（空格形态：`argv.indexOf("--root")` 取下一项），
    // `--root=<dir>` 会落到 DEFAULT_ROOT ⇒ 夹具失效；`-r` 不支持。
    const { expectExit, makeFixtureRepo, reportCases, runGuard } = await import(
      "./lib/guard-selftest.mjs"
    );
    const cases = [];

    /**
     * 一条自检用例：造 fixture repo → 跑真子进程 CLI → 断言退出码 + 观测文本。
     *
     * 保留原有 7 条夹具场景与判据语义（`expectOk` 就是判据的 ok 期望）；
     * `needle` 是每条反例对应的具体失败片段，让红是「因为对的理由红」。
     */
    const checkCase = (label, opts, expectOk, needle) => {
      cases.push({
        name: label,
        fn: () => {
          const scripts = {};
          if (opts.withScript !== false) {
            scripts[SCRIPT_NAME] =
              opts.useSpecConfig === false
                ? "cd apps/admin-api && npx tsc --noEmit -p tsconfig.json"
                : `cd apps/admin-api && npx tsc -p ${SPEC_TSCONFIG} --noEmit`;
          }
          scripts["typecheck:api"] = "cd apps/admin-api && npx tsc --noEmit -p tsconfig.json";
          scripts["typecheck:all"] =
            (opts.inAll === false
              ? "npm run typecheck:api"
              : `npm run typecheck:api && npm run ${SCRIPT_NAME}`) +
            (opts.extraChain ?? "");
          const files = {
            "package.json": { scripts },
            ".github/workflows/ci.yml":
              opts.inCi === false
                ? "jobs:\n  x:\n    steps:\n      - run: echo hi\n"
                : `jobs:\n  x:\n    steps:\n      - run: npm run ${SCRIPT_NAME}\n`,
          };
          // R225：需要造子项目时按 opts.projects 生成（用于第 ⑤ 条判据的反例）。
          for (const [proj, projScripts] of Object.entries(opts.projects ?? {})) {
            files[`${proj}/package.json`] = { name: proj, scripts: projScripts };
          }
          const repo = makeFixtureRepo(files, { prefix: "r224-" });
          try {
            expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
              code: expectOk ? 0 : 1,
              contains: [
                expectOk
                  ? "✔ `typecheck:all` 覆盖 spec 层"
                  : "✘ `typecheck:all` 没有覆盖 spec 层",
                ...(needle ? [needle] : []),
              ],
              absent: [
                expectOk
                  ? "✘ `typecheck:all` 没有覆盖 spec 层"
                  : "✔ `typecheck:all` 覆盖 spec 层",
              ],
              label,
            });
          } finally {
            repo.cleanup();
          }
        },
      });
    };

    checkCase("正例：四项齐备 ⇒ CLI exit 0（绿）", {}, true);
    checkCase(
      "反例①：缺 typecheck:specs 脚本 ⇒ CLI exit 1（红）",
      { withScript: false },
      false,
      "缺 `typecheck:specs`",
    );
    checkCase(
      "反例②：typecheck:all 没串它 ⇒ CLI exit 1（红）",
      { inAll: false },
      false,
      "链里**没有**",
    );
    checkCase(
      "反例③：脚本不用 tsconfig.spec.json ⇒ CLI exit 1（红）",
      { useSpecConfig: false },
      false,
      "必须显式用",
    );
    checkCase(
      "反例④：CI 里没有它 ⇒ CLI exit 1（红）",
      { inCi: false },
      false,
      "里没有任何一步跑",
    );
    // R225 的两条：第 ⑤ 条判据（子项目 typecheck 必须被展开覆盖）
    checkCase(
      "反例⑤：子项目定义了 typecheck:renderer 但链里没有 ⇒ CLI exit 1（红）",
      {
        projects: {
          "apps/executor-desktop": {
            "typecheck:worker": "tsc -p tsconfig.worker.json",
            "typecheck:renderer": "tsc -p tsconfig.renderer.json --noEmit",
          },
        },
      },
      false,
      "展开后**没有**覆盖它",
    );
    checkCase(
      "正例（R225）：子项目的两个 typecheck 都在链里 ⇒ CLI exit 0（绿）",
      {
        projects: {
          "apps/executor-desktop": {
            "typecheck:worker": "tsc -p tsconfig.worker.json",
          },
        },
        // 让 typecheck:all 里带上 desktop 与 worker 的 tsconfig
        extraChain:
          " && cd apps/executor-desktop && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.worker.json --noEmit",
      },
      true,
    );

    const failed = reportCases(cases, {
      title: "check-typecheck-covers-specs selftest（真子进程 CLI 黑盒）",
    });
    process.exit(failed === 0 ? 0 : 1);
  }

  const r = checkTypecheckCoversSpecs(root);
  if (r.ok) {
    console.log(
      `✔ \`typecheck:all\` 覆盖 spec 层：\`${SCRIPT_NAME}\` 已定义、已串联、用 \`${SPEC_TSCONFIG}\`、CI 有跑`,
    );
    process.exit(0);
  }
  console.error("✘ `typecheck:all` 没有覆盖 spec 层（R222/R223 的事故形态）：");
  for (const f of r.failures) console.error(`  · ${f}`);
  console.error(
    "\n修法：① 根 package.json 定义 `typecheck:specs`（用 -p tsconfig.spec.json）；" +
      "② 把它串进 `typecheck:all`；③ 确认 CI 有一步跑它。**不要**豁免这条 —— " +
      "它挡的是「构造器加必填参数 ⇒ 整个 spec 套件编译失败而没人发现」。",
  );
  process.exit(1);
}

// 顶层动作必须包在 main-guard 里（本仓 check-script-main-guard 的纪律）。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("check-typecheck-covers-specs 异常终止：", err?.message ?? err);
    process.exit(2);
  });
}
