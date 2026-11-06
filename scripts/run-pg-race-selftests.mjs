#!/usr/bin/env node
/**
 * R99（2026-11-06）：**真机 PG 并发自检的统一入口**（CI 能跑、本地诚实 skip）。
 *
 * 这两条脚本（`approval-consume-pg-race.mjs` / `rollout-claim-pg-race.mjs`）验证的是
 * **数据库层并发**（条件 UPDATE 的 CAS、唯一索引的认领），必须有真 PG 才有意义 ——
 * 它们挂了约 30 轮没接线，理由一直是"本地无 PG"。
 *
 * ## 语义（**不许静默绿**）
 * · 没有 `DATABASE_URL` ⇒ 打印 `SKIP: 需要 DATABASE_URL（真机 PG 并发用例，离线环境不判绿也不判红）` 并 **exit 0**；
 * · 有 `DATABASE_URL` ⇒ **逐条真跑**，任一条非 0 ⇒ 汇总后 **exit 1 并点名脚本**；
 * · 每条都有**超时保护**（默认 180s，可用 `PG_RACE_TIMEOUT_MS` 覆盖）。
 *
 * 用法：`npm run test:pg-race`（CI 在 postgres service 就绪后设置 DATABASE_URL 调它）
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
export const SCRIPTS = ["approval-consume-pg-race.mjs", "rollout-claim-pg-race.mjs"];

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("SKIP: 需要 DATABASE_URL（真机 PG 并发用例，离线环境不判绿也不判红）");
  console.log(`      待跑脚本：${SCRIPTS.join("、")}`);
  process.exit(0);
}

const timeout = Number(process.env.PG_RACE_TIMEOUT_MS ?? 180_000);
let failed = 0;
for (const script of SCRIPTS) {
  const abs = join(ROOT, "scripts", script);
  process.stderr.write(`[pg-race] ${script} … `);
  const t0 = Date.now();
  // 两个脚本都按 --dsn 取连接串（它们的默认值是历史容器的固定端口）=> 把 DATABASE_URL 显式传进去
  const r = spawnSync(process.execPath, [abs, `--dsn=${url}`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    env: process.env,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (r.signal) {
    console.error(`killed: ${r.signal}（${Math.round(ms / 1000)}s，超时 ${timeout}ms）`);
    failed += 1;
    continue;
  }
  const ok = r.status === 0;
  console.error(`${ok ? "exit 0" : `FAILED exit ${r.status}`}（${Math.round(ms / 1000)}s）`);
  if (!ok) {
    failed += 1;
    console.error(`   ✘ ${script} 失败；输出尾部：`);
    for (const line of out.split("\n").slice(-12)) console.error(`     ${line}`);
  } else {
    for (const line of out.split("\n").slice(-3)) console.log(`   ${line}`);
  }
}

if (failed > 0) {
  console.error(`✘ PG 并发自检：${failed}/${SCRIPTS.length} 条失败（见上，逐条点名）`);
  process.exit(1);
}
console.log(`✔ PG 并发自检全部通过：${SCRIPTS.length}/${SCRIPTS.length}`);
