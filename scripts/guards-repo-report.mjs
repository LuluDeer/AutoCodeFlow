#!/usr/bin/env node
/**
 * `test:guards:repo` 的**逐条计数报告**（离线、零依赖）。
 *
 * ## 为什么存在
 *
 * 链面（`test:guards:repo`）是 85 段 `&&`：它只回答「有没有全过」，不回答
 * 「**跑了多少条**」。第一段就失败时，你看到的只有第一段的输出 —— R01/R02
 * 都在这上面误读过（把「链在第 1 条中断」读成「链跑完且通过」）。
 * 逐条计数需要每段单独起进程、自己记退出码，`&&` 做不到，所以单列一个工具。
 *
 * ## 与 chain 的关系（**单一事实源**）
 *
 * 守卫名单**不在本文件里**，运行时从 `package.json` 的
 * `scripts["test:guards:repo"]` 解析（按 `&&` 切段，每段取 `npm run <name>`）。
 * 往链里加/删守卫，本报告自动跟随 —— 不存在「第二份名单」可以漂移。
 *
 * ## 用法
 *
 *   node scripts/guards-repo-report.mjs            # 失败即停（与 && 链同语义）
 *   node scripts/guards-repo-report.mjs --all      # 全跑完再汇总（要总数时用）
 *   node scripts/guards-repo-report.mjs --verbose  # 每条的完整输出也打出来
 *   node scripts/guards-repo-report.mjs --json     # 机器可读
 *
 * 每条固定打一行 `[exit N] <script 名>  <耗时>`，结尾一行汇总
 * `守卫链报告：M/M 通过` 或 `守卫链报告：K 失败 / N 已跑 / 共 M` —— 失败时
 * **最后一行必须是 ✘**（与 `check-docs.mjs` 的报告纪律同一条）。
 *
 * 退出码：全过 0；有任何失败 1；名单解析不出来 2（结构错误，不假装通过）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
// R22：链定义在内部键 `test:guards:chain`（`test:guards:repo` 已是矩阵入口，不再含链）。
const CHAIN_SCRIPT = "test:guards:chain";

const argv = process.argv.slice(2);
const runAll = argv.includes("--all");
const verbose = argv.includes("--verbose");
const asJson = argv.includes("--json");

/** 从链字符串里取出 `npm run <name>` 名单（保持声明顺序，去重保首个）。 */
export function parseGuardChain(chain) {
  const out = [];
  const seen = new Set();
  for (const segment of String(chain ?? "").split("&&")) {
    // 每段尾部可能挂 `|| node scripts/guard-chain-fail.mjs $?` 之类的兜底，先切掉。
    const head = segment.split("||")[0];
    const m = /npm\s+run\s+([A-Za-z0-9:@._/-]+)/.exec(head);
    if (!m) continue;
    const name = m[1].replace(/[.,]+$/, "");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function main() {
  const pkgPath = path.join(REPO_ROOT, "package.json");
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {};
  } catch (err) {
    console.error(`✘ 读不到 package.json（${pkgPath}）：${err.message}`);
    return 2;
  }
  if (typeof scripts[CHAIN_SCRIPT] !== "string") {
    console.error(`✘ package.json 里没有 "${CHAIN_SCRIPT}" —— 没有名单可数。`);
    return 2;
  }
  const guards = parseGuardChain(scripts[CHAIN_SCRIPT]);
  if (guards.length === 0) {
    console.error(`✘ "${CHAIN_SCRIPT}" 解析不出任何 \`npm run <name>\` —— 解析面坏了。`);
    return 2;
  }

  const results = [];
  let failed = 0;
  for (const name of guards) {
    const startedAt = Date.now();
    const r = spawnSync("npm", ["run", name], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    });
    const ms = Date.now() - startedAt;
    const code = r.status === null ? -1 : r.status;
    const rec = { name, code, ms, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    results.push(rec);
    const ok = code === 0;
    if (!ok) failed++;
    if (!asJson) {
      console.log(`${ok ? "[exit 0]" : "[exit " + code + "]"} ${name}  ${(ms / 1000).toFixed(1)}s`);
      if (!ok && !verbose) {
        const tail = rec.out.trimEnd().split("\n").slice(-25).join("\n");
        if (tail) console.error(tail);
      }
      if (verbose && rec.out.trim()) console.log(rec.out.trimEnd());
    }
    if (!ok && !runAll) break;
  }

  const ran = results.length;
  if (asJson) {
    console.log(JSON.stringify({ total: guards.length, ran, failed, results: results.map(({ out, ...rest }) => rest) }, null, 2));
  } else {
    console.log("");
    if (failed === 0 && ran === guards.length) {
      console.log(`✔ 守卫链报告：${guards.length}/${guards.length} 条全过（每条都已真跑，退出码见上）`);
    } else if (!runAll && ran < guards.length) {
      console.error(`✘ 守卫链报告：${failed} 条失败 / 已跑 ${ran} / 共 ${guards.length} —— 未跑到 ${guards.length - ran} 条`);
      console.error(`   首败：${results.at(-1).name}（exit ${results.at(-1).code}）`);
    } else {
      console.error(`✘ 守卫链报告：${failed} 条失败 / 已跑 ${ran} / 共 ${guards.length}`);
      for (const r of results.filter((x) => x.code !== 0)) console.error(`   · ${r.name}（exit ${r.code}）`);
    }
  }
  return failed === 0 && ran === guards.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
