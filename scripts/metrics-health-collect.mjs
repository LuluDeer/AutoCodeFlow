#!/usr/bin/env node
/**
 * metrics-health-collect.mjs — 先行指标健康度「一条命令」采集入口（R456）。
 *
 * R455 的 evaluateHealth 需要人工喂 inputs JSON；本脚本补上采集层：
 * 串行跑三个指标脚本的 `--report --json`（继承 DB env）→ 提取实测值 →
 * 组装 inputs → 调 evaluateHealth → 输出健康度。零新口径、零 DB 逻辑复刻。
 *
 * 字段映射：
 *   w4-retention.mjs        retention_rate                         → w4_retention_rate
 *   sop-success-rate.mjs    success_rate / takeover_rate           → sop_success_rate / sop_takeover_rate
 *   north-star-weekly.mjs   promotionEligibility.eligible          → north_star_promotion_eligible
 *
 * fail-closed：某脚本 SKIP（无连接/缺表）或报错 ⇒ 对应字段=null ⇒ evaluateHealth
 * 判为 no_data（met=false），绝不伪造达标。每个采集结果带 source 状态便于诊断。
 *
 * CLI:
 *   node scripts/metrics-health-collect.mjs [--as-of ISO] [--days N] [--json]
 * 退出码：0 输出健康度（无论 healthy 与否，健康度是只读信号非故障）/ 2 结构错。
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateHealth } from "./metrics-health.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

function collectOne(script, args, extract) {
  const cmd = join(ROOT, "scripts", script);
  try {
    const stdout = execFileSync(NODE, [cmd, "--report", "--json", ...args], {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = stdout.trim();
    if (text.startsWith("SKIP:")) {
      return { value: null, source: `${script}:SKIP` };
    }
    const parsed = JSON.parse(text);
    if (parsed.status !== "OK") {
      return { value: null, source: `${script}:${parsed.status ?? "unknown"}` };
    }
    return { value: extract(parsed), source: `${script}:OK` };
  } catch (err) {
    // SKIP 输出非 JSON（JSON.parse 抛）或脚本报错/超时 ⇒ no_data，不伪造。
    const reason = err?.message?.slice(0, 80) ?? "unknown";
    return { value: null, source: `${script}:error(${reason})` };
  }
}

/** 采集：每个脚本只跑一次，提取多个字段。 */
export function collectOnce(opts = {}) {
  const asOfArgs = opts.asOf ? ["--as-of", opts.asOf] : [];
  const daysArgs = opts.days ? ["--days", String(opts.days)] : [];

  const w4 = collectOne("w4-retention.mjs", asOfArgs, (p) => p.retention_rate ?? null);
  const sopAll = (() => {
    const cmd = join(ROOT, "scripts", "sop-success-rate.mjs");
    try {
      const stdout = execFileSync(NODE, [cmd, "--report", "--json", ...asOfArgs, ...daysArgs], {
        encoding: "utf8", env: process.env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
      });
      const text = stdout.trim();
      if (text.startsWith("SKIP:")) {
        return {
          success: { value: null, source: "sop:SKIP" },
          takeover: { value: null, source: "sop:SKIP" },
        };
      }
      const parsed = JSON.parse(text);
      if (parsed.status !== "OK") {
        return {
          success: { value: null, source: `sop:${parsed.status ?? "unknown"}` },
          takeover: { value: null, source: `sop:${parsed.status ?? "unknown"}` },
        };
      }
      return {
        success: { value: parsed.success_rate ?? null, source: "sop:OK" },
        takeover: { value: parsed.takeover_rate ?? null, source: "sop:OK" },
      };
    } catch (err) {
      const reason = err?.message?.slice(0, 80) ?? "unknown";
      return {
        success: { value: null, source: `sop:error(${reason})` },
        takeover: { value: null, source: `sop:error(${reason})` },
      };
    }
  })();
  const ns = collectOne("north-star-weekly.mjs", asOfArgs, (p) => p.promotionEligibility?.eligible ?? null);

  return {
    w4_retention_rate: w4,
    sop_success_rate: sopAll.success,
    sop_takeover_rate: sopAll.takeover,
    north_star_promotion_eligible: ns,
  };
}

function parseArgs(argv) {
  const o = { asOf: null, days: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--as-of") o.asOf = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]);
    else if (a === "--json") o.json = true;
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const collected = collectOnce({ asOf: opts.asOf, days: opts.days });
  const inputs = Object.fromEntries(
    Object.entries(collected).map(([k, v]) => [k, v.value]),
  );
  const health = evaluateHealth(inputs);
  const result = {
    status: "OK",
    ...health,
    collected: Object.fromEntries(
      Object.entries(collected).map(([k, v]) => [k, { value: v.value, source: v.source }]),
    ),
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("=== 先行指标健康度（一条命令采集）===");
    for (const c of health.checks) {
      const mark = c.status === "met" ? "✓" : c.status === "no_data" ? "?" : "✗";
      console.log(`  ${mark} ${c.label}: ${c.value === null ? "N/A（无样本）" : String(c.value)} (目标 ${c.comparator} ${c.target}) [${c.status}]`);
    }
    console.log(`总体：${health.healthy ? "全部达标" : "未全部达标"}；未达标=[${health.unmet.join(",")}] 无数据=[${health.noData.join(",")}]`);
    console.log(health.note);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (err) {
    console.error("metrics-health-collect 失败:", err.message);
    process.exit(2);
  }
}
