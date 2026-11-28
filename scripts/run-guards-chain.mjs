#!/usr/bin/env node
/**
 * W2（2026-11-28）：`test:guards:chain` 的**分批并发执行器** —— 链指针化的落地 runner。
 *
 * ## 链段事实源（唯一，防漂移）
 * 旧形态：根 `package.json` 的 `test:guards:chain` 是 134 段 `npm run X && …` 内联纯串行链。
 * 指针化后：该值只剩 `node scripts/run-guards-chain.mjs`（本文件），链段本体外置到
 * `scripts/guards-chain-steps.json` 的 `steps`（134 段**逐字保留**、顺序不变）。
 * 本 runner 与 `guards-repo-matrix.mjs`（逐条报告）及各解析守卫的链解析分支**共用同一事实源**。
 * 启动即交叉校验：package.json 指针必须指向本 runner，且每段都必须是 package.json 里
 * 真实存在的 `npm run <name>` —— 任何一侧漂移都 fail-closed（宁可红，不静默少跑）。
 *
 * ## 分批策略（只并发确定安全的段，其余全串行）
 * 按段的**相邻同类运行段**（run）成批，批间严格按链声明顺序执行（保持原 && 链的顺序语义）：
 * · `lint:*` → 串行批单独跑：eslint 吃内存，并发会互相拖慢甚至 OOM；
 * · 名字以 `test:` 开头的全部 + 已知子进程类（`check:failure-classifiers`（含
 *   `:reverse-proof`）、`check:protocol-three-way`、`check:response-schema`、
 *   `check:api-reference`、`check:sdk-docs-truthfulness`；另保守追加
 *   `check:typecheck-covers-specs`（名字含 typecheck ⇒ 大概率 tsc）、
 *   `check:guard-liveness`（会为数十个守卫拉起 V8 coverage 子进程））
 *   → 串行批：vitest/jest/tsc/子进程类，并发互踩与内存风险太高；
 * · 其余 `check:*` → **并发批，上限 4**（默认零依赖亚秒级静态扫描类）。
 * 调不上限的口子：`RUN_GUARDS_CHAIN_CONCURRENCY`（1–8，默认 4）。
 *
 * ## 失败语义
 * **收集式**（有意区别于旧 && 链的 fail-fast）：任一段失败不中断后续调度，跑完全链后
 * 汇总失败名单并 `exit 1` —— 验收一次拿到完整名单，不必失败→修→重跑好几轮。
 * SIGINT/SIGTERM ⇒ 杀掉整个子进程树（detached 进程组 kill），`exit 130`。
 *
 * ## 用法
 *   node scripts/run-guards-chain.mjs          # 全链分批执行
 *   node scripts/run-guards-chain.mjs --list   # 只解析并打印段清单与分批（不执行，秒级）
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHAIN_STEPS_REL = "scripts/guards-chain-steps.json";
export const CHAIN_SCRIPT = "test:guards:chain";
export const RUNNER_CMD = "node scripts/run-guards-chain.mjs";
const STEP_RE = /^npm run ([\w:@.\-/]+)$/;

/** 已知「名字叫 check: 但会起子进程/吃资源」的段 —— 与 `test:*` 一并进串行批（理由见文件头）。 */
const SERIAL_CHECK_EXPLICIT = new Set([
  "check:failure-classifiers",
  "check:failure-classifiers:reverse-proof",
  "check:protocol-three-way",
  "check:response-schema",
  "check:api-reference",
  "check:sdk-docs-truthfulness",
  "check:typecheck-covers-specs",
  "check:guard-liveness",
]);

/**
 * 读链段事实源 + 交叉校验（指针必须指向本 runner、每段必须是真实 npm script）。
 * 任何漂移 ⇒ throw（fail-closed）；读不到 steps / 指针缺失同样红。
 */
export function loadChainSteps(root = ROOT) {
  const doc = JSON.parse(readFileSync(join(root, CHAIN_STEPS_REL), "utf8"));
  const steps = doc?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${CHAIN_STEPS_REL} 缺 steps 或为空 —— 链事实源损坏（fail-closed）`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pointer = pkg?.scripts?.[CHAIN_SCRIPT];
  if (typeof pointer !== "string" || !pointer.includes("run-guards-chain.mjs")) {
    throw new Error(
      `package.json 的 ${CHAIN_SCRIPT} 未指向本 runner（当前：${JSON.stringify(pointer ?? null)}）—— ` +
        `链指针与 ${CHAIN_STEPS_REL} 漂移，拒绝执行（fail-closed）`,
    );
  }
  for (const seg of steps) {
    const m = STEP_RE.exec(String(seg).trim());
    if (!m) throw new Error(`${CHAIN_STEPS_REL} 出现非 "npm run <name>" 段：${JSON.stringify(String(seg))}`);
    if (typeof pkg.scripts[m[1]] !== "string") {
      throw new Error(`${CHAIN_STEPS_REL} 引用的 script "${m[1]}" 在 package.json 里不存在 —— 链段漂移（fail-closed）`);
    }
  }
  return steps.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * 分批：把 134 段切成「相邻同类 run」序列。
 * 返回 [{ mode: "serial"|"parallel", steps: [seg...] }]，批间顺序 = 链声明顺序。
 * serial 类：lint:*（eslint 内存）；test:* + SERIAL_CHECK_EXPLICIT（子进程/tsc/vitest 类）。
 * parallel 类：其余 check:*（零依赖静态扫描，并发 ≤4）。
 */
export function planBatches(steps, concurrency = 4) {
  const batchOf = (seg) => {
    const name = STEP_RE.exec(seg)[1];
    if (name.startsWith("lint:")) return "serial";
    if (name.startsWith("test:") || SERIAL_CHECK_EXPLICIT.has(name)) return "serial";
    return "parallel";
  };
  const batches = [];
  for (const seg of steps) {
    const mode = batchOf(seg);
    const last = batches[batches.length - 1];
    if (last && last.mode === mode) last.steps.push(seg);
    else batches.push({ mode, steps: [seg] });
  }
  return batches.map((b) => ({ ...b, concurrency: b.mode === "parallel" ? Math.max(1, Math.min(8, concurrency)) : 1 }));
}

const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** 环形缓冲：只留最近 N 行（失败回放用）。 */
function makeTail(n) {
  const lines = [];
  return {
    push(chunk) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        lines.push(line);
        if (lines.length > n) lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
  };
}

const active = new Set();
let interrupted = false;

/** 跑一段 `npm run <name>`：detached 进程组（SIGINT 时可整组清理），捕获输出 + 计时。 */
function runStep(seg, { live }) {
  return new Promise((resolveStep) => {
    const name = STEP_RE.exec(seg)[1];
    const t0 = Date.now();
    const child = spawn("npm", ["run", name], { cwd: ROOT, detached: true });
    active.add(child);
    const outTail = makeTail(20);
    const errTail = makeTail(20);
    child.stdout.on("data", (d) => {
      if (live) process.stdout.write(d);
      outTail.push(d);
    });
    child.stderr.on("data", (d) => {
      if (live) process.stderr.write(d);
      errTail.push(d);
    });
    child.on("error", (err) => {
      active.delete(child);
      resolveStep({ name, seg, code: 1, signal: null, ms: Date.now() - t0, outTail: "", errTail: `spawn 失败：${err.message}` });
    });
    child.on("close", (code, signal) => {
      active.delete(child);
      resolveStep({ name, seg, code: code ?? 1, signal, ms: Date.now() - t0, outTail: outTail.text(), errTail: errTail.text() });
    });
  });
}

function killAll() {
  for (const child of active) {
    try {
      process.kill(-child.pid, "SIGTERM"); // detached ⇒ 负 pid 杀整组（npm → sh → node 子树）
    } catch {
      try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
    }
  }
}

process.on("SIGINT", () => {
  interrupted = true;
  killAll();
  if (active.size === 0) process.exit(130);
});
process.on("SIGTERM", () => {
  interrupted = true;
  killAll();
  if (active.size === 0) process.exit(130);
});

function printResult(r) {
  const bad = r.code !== 0 || r.signal;
  const head = bad ? "[FAIL]" : "[ok]";
  const suffix = r.signal ? `，signal ${r.signal}` : "";
  console.log(`${head} ${r.name} (${fmtS(r.ms)}${suffix})`);
}

/** 并发批：worker 池（≤concurrency），collect-all —— 失败不中断调度。 */
async function runBatch(batch, index, total) {
  const label = batch.mode === "parallel" ? `并发批（≤${batch.concurrency} 并发）` : "串行批";
  console.log(`── 批 ${index}/${total}｜${label}｜${batch.steps.length} 段 ──`);
  const results = [];
  if (batch.mode === "serial") {
    for (const seg of batch.steps) {
      if (interrupted) break;
      const r = await runStep(seg, { live: true });
      printResult(r);
      results.push(r);
    }
    return results;
  }
  let next = 0;
  const worker = async () => {
    while (!interrupted) {
      const i = next++;
      if (i >= batch.steps.length) return;
      const r = await runStep(batch.steps[i], { live: false });
      printResult(r);
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(batch.concurrency, batch.steps.length) }, worker));
  return results;
}

function replayFailures(failures) {
  for (const r of failures) {
    console.error(`✘ ${r.name} 失败（exit ${r.code}${r.signal ? `，signal ${r.signal}` : ""}）`);
    for (const [label, body] of [["stderr 尾部", r.errTail], ["stdout 尾部", r.outTail]]) {
      if (!body) continue;
      console.error(`  ── ${label}（最近 20 行）──`);
      for (const line of body.split("\n")) console.error(`  │ ${line}`);
    }
  }
}

async function main(argv) {
  const t0 = Date.now();
  const steps = loadChainSteps();
  const concurrency = Number(process.env.RUN_GUARDS_CHAIN_CONCURRENCY ?? 4);
  const batches = planBatches(steps, concurrency);
  if (argv.includes("--list")) {
    steps.forEach((seg, i) => console.log(`[${i + 1}/${steps.length}] ${seg}`));
    const p = batches.filter((b) => b.mode === "parallel");
    const s = batches.filter((b) => b.mode === "serial");
    console.log(
      `\n解析 ${steps.length} 段 / ${batches.length} 批（并发 ${p.length} 批共 ${p.reduce((n, b) => n + b.steps.length, 0)} 段 ≤${concurrency} 并发；` +
        `串行 ${s.length} 批共 ${s.reduce((n, b) => n + b.steps.length, 0)} 段）—— 指针交叉校验通过`,
    );
    return 0;
  }
  console.log(`守卫链共 ${steps.length} 段 / ${batches.length} 批（collect-all：任一失败不中断，末尾出失败名单）`);
  const failures = [];
  for (let i = 0; i < batches.length; i++) {
    const results = await runBatch(batches[i], i + 1, batches.length);
    failures.push(...results.filter((r) => r.code !== 0 || r.signal));
  }
  const wall = Date.now() - t0;
  console.log("");
  if (failures.length > 0) {
    replayFailures(failures);
    console.error(`\n✘ 守卫链失败：${failures.length}/${steps.length} 段 —— 名单：${failures.map((r) => r.name).join(", ")}（总耗时 ${fmtS(wall)}）`);
    return 1;
  }
  console.log(`✔ 守卫链通过：${steps.length}/${steps.length} 段 / ${batches.length} 批，总耗时 ${fmtS(wall)}`);
  return 0;
}

// main-guard：本文件既有 export（loadChainSteps/planBatches）又有顶层动作，必须有守卫
// （check-script-main-guard 判据①；同 guards-repo-matrix.mjs 的写法）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`✘ 守卫链 runner 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
