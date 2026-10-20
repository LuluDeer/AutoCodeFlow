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
const FILE_ROOT = ROOT;

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

/**
 * 判定单个源文件里哪些 `@Cron` 没有门禁。**抽成纯函数**，`--selftest` 用内联 fixture 直接驱动。
 *
 * 两个判据都是被反证打出来的，注释里写清缘由：
 *  ① **先剥注释再判** —— 否则「把门禁注释掉」也能通过（注释里的 gate 文本与真实代码在正则眼里一模一样）；
 *  ② **窗口止于方法体** —— 固定行数窗口会越过方法边界，把**下一个方法**的门禁算到当前方法头上。
 */
export function findUngatedCrons(source, { allowlist = new Map(), window = WINDOW } = {}) {
  const lines = source.split("\n");
  const found = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/@Cron\(/.test(lines[i])) continue;
    total += 1;
    if (allowlist.has(i + 1)) continue;
    let end = i + 1;
    for (; end < lines.length && end < i + window; end++) {
      if (/^  \}/.test(lines[end])) break;
    }
    const body = lines
      .slice(i, end + 1)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (!GATE.test(body)) found.push(i + 1);
  }
  return { total, ungated: found };
}

/**
 * `--selftest`：用内联 fixture 验证上面两个判据。**这是这条守卫被反证打回两次之后的产物** ——
 * 那两次失败（数注释、数邻居）如果只写在注释里，下一个人改写正则时仍会重新踩。
 */
function selftest() {
  const cases = [
    {
      name: "正常门禁 → 通过",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        "    if (!this.isLeader) return;",
        "    await this.body();",
        "  }",
        "}",
      ].join("\n"),
      expectUngated: [],
    },
    {
      name: "门禁被注释掉 → **红**（第一版在这里假绿）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        "    // if (!this.isLeader) return;",
        "    await this.body();",
        "  }",
        "}",
      ].join("\n"),
      expectUngated: [2],
    },
    {
      name: "门禁在**下一个方法**里 → **红**（第二版在这里假绿）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  sweepAggregator() {",
        "    this.aggregator.sweep();",
        "  }",
        "  next() {",
        "    if (!this.isLeader) return;",
        "  }",
        "}",
      ].join("\n"),
      expectUngated: [2],
    },
    {
      name: "块注释里的门禁不算 → 红",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        "    /* if (!this.isLeader) return; */",
        "    await this.body();",
        "  }",
        "}",
      ].join("\n"),
      expectUngated: [2],
    },
    {
      name: "allowlist 命中 → 放行",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  localCleanup() {",
        "    this.clean();",
        "  }",
        "}",
      ].join("\n"),
      allowlist: new Map([[2, "本应每实例都跑"]]),
      expectUngated: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findUngatedCrons(c.src, { allowlist: c.allowlist ?? new Map() });
    const ok = JSON.stringify(got.ungated) === JSON.stringify(c.expectUngated);
    if (!ok) {
      failed += 1;
      console.error(`✖ SELFTEST 失败：${c.name}`);
      console.error(`    期望 ungated=${JSON.stringify(c.expectUngated)}，实际=${JSON.stringify(got.ungated)}`);
    }
  }
  if (failed > 0) {
    console.error(`✖ selftest ${cases.length - failed}/${cases.length} 通过`);
    process.exit(1);
  }
  console.log(`✔ cron-leader-gate selftest：${cases.length}/${cases.length} 通过（含「注释门禁」与「邻居门禁」两个历史假绿）`);
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

let total = 0;
const missing = [];
for (const f of files) {
  const rel = f.slice(FILE_ROOT.length + 1).split("\\").join("/");
  const res = findUngatedCrons(readFileSync(f, "utf8"), {
    allowlist: new Map([...ALLOWLIST.keys()].map((k) => [Number(k.split(":").pop()), k]).filter(([, k]) => k.startsWith(rel + ":"))),
  });
  total += res.total;
  for (const line of res.ungated) missing.push(`${rel}:${line}`);
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
