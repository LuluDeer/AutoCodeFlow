#!/usr/bin/env node
/**
 * R118：**心跳×派发 race 的慢通道入口**（`needs-env` 档；与 `test:pg-race` 同级）。
 *
 * ## 为什么单独一个入口
 * `heartbeat-dispatch-race-selftest.mjs` 是**真 docker + 真 PG + 时序窗口**型用例：
 * 进主门禁会偶发假红/假绿（R110/R113 已论证）。故挂到「慢通道」：**没有 docker ⇒ SKIP 并打印**，
 * 有 docker ⇒ 真跑 20 轮并把汇总行透传出来。
 *
 * ## 语义（**不许静默绿**）
 * · `docker info` 不可用 ⇒ 打印 `SKIP: 需要 docker（race 时序型，不进主门禁）` 并 **exit 0**；
 * · 有 docker ⇒ 真跑；harness 非 0 ⇒ **本入口 exit 1**（并已由 harness 打印点名汇总）；
 * · `R110_STRIP_GREATEST=1` 原样透传 ⇒ 用于**机制证明**（此时必须 exit 1）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "..");
const ROUNDS = process.env.HEARTBEAT_RACE_ROUNDS ?? "20";

const docker = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 20_000 });
if (docker.status !== 0) {
  console.log("SKIP: 需要 docker（race 时序型，不进主门禁）");
  console.log(`      待跑：scripts/heartbeat-dispatch-race-selftest.mjs --rounds=${ROUNDS}`);
  process.exit(0);
}

console.log(`[slow-race] heartbeat-dispatch-race 真跑（--rounds=${ROUNDS}，model=b）…`);
const r = spawnSync(
  process.execPath,
  [join(ROOT, "scripts/heartbeat-dispatch-race-selftest.mjs"), `--rounds=${ROUNDS}`],
  { cwd: ROOT, encoding: "utf8", timeout: 15 * 60_000, env: process.env },
);
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
for (const line of out.split("\n").filter((l) => /汇总|VIOLATION|SKIP|检测到/.test(l))) console.log(line);
if (r.signal) {
  console.error(`killed: ${r.signal}（慢通道用例被信号终止，不当成通过）`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`✘ heartbeat-dispatch-race 未通过（exit ${r.status}）—— 见上面的汇总行`);
  process.exit(1);
}
console.log("✔ heartbeat-dispatch-race 慢通道通过（0 产品违反 / 0 harness 自身缺陷）");
