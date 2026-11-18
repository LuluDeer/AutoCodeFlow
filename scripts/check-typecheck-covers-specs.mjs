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
 * ## 判据
 *
 *  ① 根 `package.json` 必须定义 `typecheck:specs`；
 *  ② 根 `typecheck:all` 的串行链里**必须**包含 `npm run typecheck:specs`；
 *  ③ 该脚本必须真的用 **`-p tsconfig.spec.json`**（否则它和 `typecheck:api` 是同一个门禁，
 *     包含它只是给人「我查过 spec 了」的错觉）；
 *  ④ `.github/workflows/` 里必须有一步真跑它（本地门禁与 CI 不能只接一面）。
 *
 * ## 反例（本脚本在 `--selftest` 里逐条验证）
 *
 * 去掉 ② 的链环、把 ③ 换成 `tsconfig.json`、把 ④ 的 CI step 删掉 —— 三种都必须红。
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

const HERE = dirname(fileURLToPath(import.meta.url));
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

  return { ok: failures.length === 0, failures };
}

async function main() {
  const argv = process.argv.slice(2);
  const rootArgIdx = argv.indexOf("--root");
  const root = rootArgIdx >= 0 ? resolve(argv[rootArgIdx + 1]) : DEFAULT_ROOT;

  if (argv.includes("--selftest")) {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    let failed = 0;

    /** 一条自检用例：造 fixture → 跑判据 → 断言 ok 与期望一致。 */
    const checkCase = (label, opts, expectOk) => {
      const dir = mkdtempSync(join(tmpdir(), "r224-"));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      const scripts = {};
      if (opts.withScript !== false) {
        scripts[SCRIPT_NAME] =
          opts.useSpecConfig === false
            ? "cd apps/admin-api && npx tsc --noEmit -p tsconfig.json"
            : `cd apps/admin-api && npx tsc -p ${SPEC_TSCONFIG} --noEmit`;
      }
      scripts["typecheck:api"] = "cd apps/admin-api && npx tsc --noEmit -p tsconfig.json";
      scripts["typecheck:all"] =
        opts.inAll === false
          ? "npm run typecheck:api"
          : `npm run typecheck:api && npm run ${SCRIPT_NAME}`;
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        opts.inCi === false
          ? "jobs:\n  x:\n    steps:\n      - run: echo hi\n"
          : `jobs:\n  x:\n    steps:\n      - run: npm run ${SCRIPT_NAME}\n`,
      );
      const r = checkTypecheckCoversSpecs(dir);
      const pass = r.ok === expectOk;
      console.log(`${pass ? "✔" : "✘"} ${label}（ok=${r.ok}，期望 ${expectOk}）`);
      if (!pass) {
        failed += 1;
        for (const f of r.failures) console.log(`    · ${f}`);
      }
    };

    checkCase("正例：四项齐备 ⇒ 绿", {}, true);
    checkCase("反例①：缺 typecheck:specs 脚本 ⇒ 红", { withScript: false }, false);
    checkCase("反例②：typecheck:all 没串它 ⇒ 红", { inAll: false }, false);
    checkCase("反例③：脚本不用 tsconfig.spec.json ⇒ 红", { useSpecConfig: false }, false);
    checkCase("反例④：CI 里没有它 ⇒ 红", { inCi: false }, false);

    const total = 5;
    console.log(
      `\n${failed === 0 ? "✔" : "✘"} check-typecheck-covers-specs selftest：${total - failed}/${total} 通过`,
    );
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
