#!/usr/bin/env node
/**
 * R229：**真机探针的「不会静默失效」守卫**。
 *
 * ## 背景（R212–R217 建了 9 个真机探针，但它们**不在任何自动门禁里**）
 *
 * 那些探针（`scripts/r2*-*-probe.mjs`）需要**隔离 Redis / 真 PG / 真 cron**，所以
 * **不能进 CI** —— 这是刻意的（它们不是单测）。代价是：
 *
 * > 探针脚本本身**退化时不产生任何信号**：文件被删/改名、`package.json` 的 script
 * > 指向不存在的文件、语法被改坏、被人顺手 `rm` 掉 —— 都不会有东西红。
 *
 * 而它们恰恰是**唯一**能证明「真机行为成立」的资产（R208/R212/R213/R214/R216 的结论全靠它们）。
 * 一个**默默失效、没人知道已经失效**的验证资产，比没有更糟：它会让人以为「有覆盖」。
 *
 * ## 判据（**刻意只查静态事实，绝不连真机**）
 *
 *  ① 清单里的每个探针**文件存在**；
 *  ② `package.json` 里对应的 `test:*` script **存在**且**指向该文件**（不是指向别的探针）；
 *  ③ 脚本能被 **`node --check`** 解析（语法没坏）；
 *  ④ 脚本头部**明确写出**它需要什么环境（避免有人误以为 `npm test` 会跑到它）——
 *     判据：前 40 行内必须出现 `隔离` / `isolation` / `真机` / `REDIS` 之一。
 *
 * ## 为什么不做成「真的跑一遍」
 *
 * 跑真机需要起 Redis/PG + 建 admin-api 进程 + 等分钟级 cron（R217 的探针最坏 **22 分钟**）。
 * 把它塞进守门链会让**每一次 CI 都多等半小时**，最终结果是「有人把它注释掉」——
 * 与 R158 的 `typecheck:renderer:report`（恒 exit 0 的假门禁）是同一类退化路径。
 * ⇒ **静态可用性**在这里是**正确的**判据强度，不是妥协；真机结论由文档里的运行记录承担。
 *
 * 用法：
 *   node scripts/check-live-probes-intact.mjs            # 判定
 *   node scripts/check-live-probes-intact.mjs --selftest # 自检（真子进程 + fixture）
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// R160 覆盖计数出口：必须在任何依赖之前打印（崩了与零用例要能分开看）。
printCoverageBanner(import.meta.url, "checkCase");

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, "..");

/**
 * 探针清单（**显式列出，不用通配**）。
 *
 * 为什么不用 `r2*-probe.mjs` 通配：通配在「文件被删」时**自动缩小扫描面** ⇒
 * 删掉一个探针反而更绿（本仓反复踩过的形态：目录改名 → 零命中 → 一句 ✔）。
 */
const PROBES = [
  { script: "test:r207-queue-idle-live", file: "scripts/r207-queue-idle-live-probe.mjs" },
  { script: "test:r209-queue-idle-http", file: "scripts/r209-queue-idle-http-probe.mjs" },
  { script: "test:r210-stall-live", file: "scripts/r210-stall-live-probe.mjs" },
  { script: "test:r212-degraded-live", file: "scripts/r212-degraded-live-probe.mjs" },
  {
    script: "test:r213-observation-timeout-live",
    file: "scripts/r213-observation-timeout-live-probe.mjs",
  },
  { script: "test:r214-observer-leak-live", file: "scripts/r214-observer-leak-live-probe.mjs" },
  { script: "test:r215-jobid-live", file: "scripts/r215-jobid-live-probe.mjs" },
  { script: "test:r216-auto-requeue-live", file: "scripts/r216-auto-requeue-live-probe.mjs" },
  { script: "test:r217-auto-requeue-e2e", file: "scripts/r217-auto-requeue-e2e-probe.mjs" },
];

/** 头部必须出现的「需要真环境」提示词之一。 */
// ⚠️ 首版只查「隔离/isolation/真机/REDIS」四个词，实测把 `r209` 误判：它的 header 写的是
//    「真 NestJS 进程 + 真 PG + 真 Redis」（**小写** redis、无「隔离/真机」字样）——
//    内容完全够，是我的判据太窄。⇒ 放宽到「真 + 环境名」这一类可识别表述。
const ENV_HINTS = [
  "隔离",
  "isolation",
  "真机",
  "真 Redis",
  "真 Redis",
  "真 PG",
  "真 NestJS",
  "Redis",
  "PG",
];

/**
 * 跑判据（纯函数式：不 exit，便于 selftest）。
 *
 * @returns `{ ok, failures }`
 */
export function checkLiveProbesIntact(root = DEFAULT_ROOT) {
  const failures = [];

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, failures: [`缺 package.json（root=${root}）`] };
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return { ok: false, failures: [`package.json 不是合法 JSON：${err.message}`] };
  }
  const scripts = pkg.scripts ?? {};

  for (const { script, file } of PROBES) {
    // ① 文件存在
    const abs = join(root, file);
    if (!existsSync(abs)) {
      failures.push(`探针文件不存在：${file}（清单里登记了它，但它被删/改名了）`);
      continue;
    }

    // ② npm script 存在且指向**这个**文件
    const cmd = scripts[script];
    if (typeof cmd !== "string") {
      failures.push(`package.json 缺 \`${script}\` —— 该探针没有可执行的入口`);
    } else if (!cmd.includes(file)) {
      failures.push(
        `\`${script}\` 指向的不是 ${file}（当前：\`${cmd}\`）—— 两个探针可能被接串了`,
      );
    }

    // ③ 能被 node --check 解析
    const r = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
    if (r.status !== 0) {
      failures.push(
        `${file} 语法错误（node --check exit ${r.status}）：${(r.stderr ?? "").split("\n")[0]}`,
      );
    }

    // ④ 头部写明「需要真环境」
    const head = readFileSync(abs, "utf8").split("\n").slice(0, 40).join("\n");
    if (!ENV_HINTS.some((h) => head.includes(h))) {
      failures.push(
        `${file} 的头部（前 40 行）没有说明它**需要真环境**（应含 ${ENV_HINTS.join(" / ")} 之一）` +
          ` —— 否则有人会以为 \`npm test\` 会跑到它`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

// ── 自检：真子进程 + fixture ────────────────────────────────────────────────
function makeFixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "r229-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const scripts = {};
  for (const { script, file } of PROBES) {
    if (overrides.skipFiles?.includes(file)) continue;
    scripts[script] = `node ${overrides.redirect?.[file] ?? file}`;
    if (overrides.skipFiles?.includes(file)) continue;
    const body =
      overrides.badSyntax?.includes(file)
        ? "this is not valid javascript (((\n"
        : overrides.noEnvHint?.includes(file)
          ? "// 一个没有环境说明的探针\nexport const x = 1;\n"
          : "// 需要隔离 Redis（真机探针）\nexport const x = 1;\n";
    writeFileSync(join(dir, file), body);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--selftest")) {
    let failed = 0;
    /** 一条自检用例。fixture 目录用完即清（2026-11-28：/tmp usrquota 打满事故
     *  的泄漏源之一——此前 385 个 r229-* 残留随自检次数累积）。 */
    const checkCase = (label, overrides, expectOk) => {
      const dir = makeFixture(overrides);
      try {
        const r = checkLiveProbesIntact(dir);
        const pass = r.ok === expectOk;
        console.log(`${pass ? "✔" : "✘"} ${label}（ok=${r.ok}，期望 ${expectOk}）`);
        if (!pass) {
          failed += 1;
          for (const f of r.failures) console.log(`    · ${f}`);
        }
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };

    checkCase("正例：9 个探针齐全、入口正确、语法 OK、有环境说明 ⇒ 绿", {}, true);
    checkCase(
      "反例①：删掉一个探针文件 ⇒ 红",
      { skipFiles: ["scripts/r216-auto-requeue-live-probe.mjs"] },
      false,
    );
    checkCase(
      "反例②：script 指向别的探针（接串）⇒ 红",
      { redirect: { "scripts/r215-jobid-live-probe.mjs": "scripts/r214-observer-leak-live-probe.mjs" } },
      false,
    );
    checkCase(
      "反例③：语法坏了 ⇒ 红",
      { badSyntax: ["scripts/r213-observation-timeout-live-probe.mjs"] },
      false,
    );
    checkCase(
      "反例④：头部没写「需要真环境」⇒ 红",
      { noEnvHint: ["scripts/r210-stall-live-probe.mjs"] },
      false,
    );

    const total = 5;
    console.log(
      `\n${failed === 0 ? "✔" : "✘"} check-live-probes-intact selftest：${total - failed}/${total} 通过`,
    );
    process.exit(failed === 0 ? 0 : 1);
  }

  const rootArgIdx = argv.indexOf("--root");
  const root = rootArgIdx >= 0 ? resolve(argv[rootArgIdx + 1]) : DEFAULT_ROOT;
  const r = checkLiveProbesIntact(root);
  if (r.ok) {
    console.log(
      `✔ 真机探针完好：${PROBES.length} 个探针文件存在、npm 入口指向正确、语法可解析、头部写明需要真环境`,
    );
    console.log(
      "  ⚠️ 注意：本判据**只查静态可用性**，不连真机。真机结论见各判据文档的运行记录。",
    );
    process.exit(0);
  }
  console.error("✘ 真机探针清单不完整（它们无法进 CI，所以只能靠这条守卫保命）：");
  for (const f of r.failures) console.error(`  · ${f}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("check-live-probes-intact 异常终止：", err?.message ?? err);
    process.exit(2);
  });
}
