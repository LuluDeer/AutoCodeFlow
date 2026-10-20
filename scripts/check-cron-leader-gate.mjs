#!/usr/bin/env node
/**
 * 守卫：**每个 `@Cron` 都必须有 leader 门禁**。
 *
 * 由来：本仓踩过「同一修法只落一半」的一整族缺陷（markOffline vs setOfflineById、heartbeat vs register、
 * publish vs draft……）。`@Cron` 是下一个高风险面：多副本部署下，**忘了门禁 = N 个实例各跑一遍**，
 * 表现为重复扫描、重复置态、N 倍 LLM 配额消耗 —— 而它**只在多副本时才显形**，单机开发永远看不到。
 *
 * 22 个 `@Cron` 目前全都有门禁，但表达方式有**三种写法**：
 *   - `this.leaderGate.isLeader` / `this.leaderGate?.isLeader`（直接注入）
 *   - `this.isLeader`（scheduler 的 getter）
 *   - `this.isLeader()` / `this.isSchedulerLeader()`（包装方法）
 * 所以判据必须是**这三种 idiom 的并集**，且按「方法体窗口」而不是「紧跟的几行」判 ——
 * 首版用 25 行窗口 + 只认 `leaderGate` 字面量，**假报了 7 处**（全是包装方法形态）。
 *
 * 已知假阴性的边界（如实写出来）：这是**文本判据**，不是语义分析。
 * 一段「门禁写了但被注释掉」的代码仍会被判为有门禁。它挡的是「新增 @Cron 时整个忘了写」，
 * 不是「写错了」。
 *
 * 用法：node scripts/check-cron-leader-gate.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "admin-api", "src");

/** 门禁 idiom（三种写法，都是本仓实际在用的）。 */
const GATE = /(leaderGate|isLeader|isSchedulerLeader)/;

/** 方法体窗口（行）。22 处实测门禁都在 25 行内，取 40 留余量。 */
const WINDOW = 40;

/**
 * 允许**不带**门禁的 `@Cron`（file:method 或 file:line），必须写明理由。
 * 例如「每实例都必须跑的本地清理」——但目前一个都没有，故为空。
 */
const ALLOWLIST = new Map([]);

const MIN_EXPECTED_CRONS = 15;

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) files.push(p);
  }
})(SRC);

let total = 0;
const missing = [];
for (const f of files) {
  const rel = f.slice(ROOT.length + 1).split("\\").join("/");
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/@Cron\(/.test(lines[i])) continue;
    total += 1;
    const key = `${rel}:${i + 1}`;
    if (ALLOWLIST.has(key)) continue;
    // ① **先剥注释再判**：否则「把门禁注释掉」也能通过 —— 反证实测过，这是这条守卫
    //    最容易自欺的地方（注释里的 gate 文本与真实代码在正则眼里一模一样）。
    // ② **窗口必须止于方法体**：固定 40 行会越过方法边界，把**下一个方法**的门禁算到
    //    当前方法头上 —— 反证也实测过（sweepAggregator 的门禁被注释掉后仍绿，因为它后面
    //    紧跟的 sweep() 方法里有 isLeader）。
    let end = i + 1;
    for (; end < lines.length && end < i + WINDOW; end++) {
      if (/^  \}/.test(lines[end])) break;
    }
    const body = lines
      .slice(i, end + 1)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (!GATE.test(body)) missing.push(key);
  }
}

if (total < MIN_EXPECTED_CRONS) {
  console.error(`✖ 只扫到 ${total} 个 @Cron（下界 ${MIN_EXPECTED_CRONS}）—— 扫描器失效了。`);
  process.exit(1);
}

if (missing.length > 0) {
  console.error("");
  console.error(`✖ ${missing.length} 个 @Cron 没有 leader 门禁（多副本会各跑一遍）：`);
  for (const m of missing) console.error("  · " + m);
  console.error("");
  console.error("  修法：在方法体开头加门禁，本仓有三种既有写法可选：");
  console.error("    if (!this.leaderGate?.isLeader) return;");
  console.error("    if (!this.isLeader) return;              // scheduler 的 getter");
  console.error("    if (!this.isSchedulerLeader()) return;   // 包装方法");
  console.error("  若该 tick **本应**每实例都跑（本地清理等），加进 ALLOWLIST 并写理由。");
  process.exit(1);
}

console.log(`✔ @Cron leader 门禁齐备：${total} 个 @Cron 全部有门禁（allowlist ${ALLOWLIST.size} 个）。`);
