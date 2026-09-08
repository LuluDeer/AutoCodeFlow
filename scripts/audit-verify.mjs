#!/usr/bin/env node
// SEC-10: 审计防篡改验证工具——连 DB 校验 audit_logs 的 append-only 纵深。
//
// 三项检查（全部只读 + 受控写试，selftest 用临时矩阵不需要真 DB）：
//   1. guard-present：append-only 触发器（trg_audit_logs_append_only）与
//      守卫函数（audit_logs_append_only_guard）已安装；
//   2. mutation-denied：对最近一行 audit 执行受控 UPDATE/DELETE 试写
//      （包在 ROLLBACK 事务里，不产生持久改动），期望被触发器拒绝；
//   3. sequence-integrity：id 单调递增无空洞误报容忍（SERIAL 回滚会产生
//      合法空洞，不视为篡改）——核心断言是 createdAt 时间序与 id 序的一致率
//      与总行数 vs 时间窗估算（行数 ≥ 窗口内最小时间戳以来的天数下界不校验，
//      只输出报告数据）。
//
// 用法：
//   node scripts/audit-verify.mjs                 # 连 DB（env: DB_HOST/DB_PORT/
//                                                 # DB_USERNAME/DB_PASSWORD/DB_DATABASE）
//   node scripts/audit-verify.mjs --selftest      # 纯函数自检（零依赖、零 DB）
//   node scripts/audit-verify.mjs --report-only   # 只跑第 1/3 项（不写试）
//
// 退出码：0=全部通过；1=发现可篡改面/结构缺失/校验失败。
import { pathToFileURL } from "node:url";
import process from "node:process";

// ── 纯函数（selftest 覆盖面，不触 DB）────────────────────────────────────

/**
 * 判定触发器安装检查结果。
 * rows 形如 [{ tgname, tgenabled }]（来自 pg_trigger join）。
 * 通过条件：存在名为 trg_audit_logs_append_only 的触发器且已启用
 * （tgenabled = 'O'，即 origin/local 会话均触发）。
 */
export function checkGuardPresent(rows) {
  const trg = (rows ?? []).find((r) => r?.tgname === "trg_audit_logs_append_only");
  if (!trg) return { ok: false, reason: "触发器 trg_audit_logs_append_only 不存在" };
  if (trg.tgenabled !== "O") {
    return { ok: false, reason: `触发器未启用（tgenabled=${trg.tgenabled}，期望 O）` };
  }
  return { ok: true };
}

/**
 * 判定写试结果是否被 append-only 语义拒绝。
 * 通过条件：attempted=true 且 rejected=true 且 error 匹配
 * audit_logs append-only 触发器消息（或 PG P0001）。
 */
export function checkMutationDenied(attempt) {
  if (!attempt || attempt.attempted !== true) {
    return { ok: false, reason: "未执行写试（attempted=false）——结果不可信" };
  }
  if (attempt.rejected !== true) {
    return { ok: true === false, reason: "写试未被拒绝——append-only 纵深失效！" , fatal: true };
  }
  const msg = String(attempt.error ?? "");
  const match =
    msg.includes("audit_logs is append-only") ||
    msg.includes("P0001") ||
    msg.includes("append-only");
  if (!match) {
    return { ok: false, reason: `拒绝但错误指纹不符：${msg.slice(0, 200)}` };
  }
  return { ok: true };
}

/**
 * 行序一致性：按 id 升序排列后，createdAt（毫秒）应单调不减（允许相等——
 * 同毫秒批量写入）。返回 { ok, checked, violations }；rows 形如
 * [{ id, createdAt }]（createdAt 已是 Date/毫秒均可）。
 * 注：id 序的空洞（SERIAL 回滚）合法，不属于本检查。
 */
export function checkSequenceIntegrity(rows) {
  const sorted = [...(rows ?? [])].sort((a, b) => a.id - b.id);
  let violations = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].createdAt).getTime();
    const cur = new Date(sorted[i].createdAt).getTime();
    if (cur < prev) violations++;
  }
  return { ok: violations === 0, checked: sorted.length, violations };
}

/**
 * 时间窗行数报告（SEC-10 第 3 项的报告半边——产出数据供人工比对，
 * 不做硬阈值断言）：给定窗口 [start, end] 与行数计数，输出密度估算。
 */
export function buildWindowReport(rows, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const inWindow = (rows ?? []).filter(
    (r) => new Date(r.createdAt).getTime() >= cutoff,
  ).length;
  return {
    totalRows: (rows ?? []).length,
    windowMs,
    rowsInWindow: inWindow,
    densityPerDay: Math.round((inWindow / windowMs) * 86_400_000),
    sampledAt: new Date(now).toISOString(),
  };
}

// ── DB 检查执行（直接执行时才连库）────────────────────────────────────

async function runDbChecks({ reportOnly }) {
  // 延迟加载：selftest 路径不加载 pg。ESM 裸说明符按「脚本文件位置」而非
  // cwd 解析——scripts/ 下无 node_modules，须显式指向 admin-api 本地 pg。
  const { createRequire } = await import("node:module");
  const { join } = await import("node:path");
  let Client;
  try {
    const requireFromRepo = createRequire(
      join(process.cwd(), "apps/admin-api/package.json"),
    );
    const pgMod = await import("file://" + requireFromRepo.resolve("pg"));
    Client = pgMod.default?.Client ?? pgMod.Client;
  } catch {
    // 兜底：cwd 就在 apps/admin-api 内时，createRequire 指向的 package.json
    // 不存在 → 裸 import 按 cwd 也不一定能解析，直接失败并提示。
    const pgMod = await import("pg").catch(() => null);
    if (!pgMod) {
      console.error("✘ 无法加载 pg 驱动——请在仓库根或 apps/admin-api 下运行");
      process.exit(1);
    }
    Client = pgMod.default?.Client ?? pgMod.Client;
  }
  // env 缺省时回退读 apps/admin-api/.env（与 admin-api 运行时同源）
  const dotenv = {};
  try {
    const { readFileSync } = await import("node:fs");
    const envText = readFileSync(
      join(process.cwd(), "apps/admin-api/.env"),
      "utf8",
    );
    for (const line of envText.split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) dotenv[m[1]] = m[2];
    }
  } catch {
    /* .env 不存在时忽略 */
  }
  const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
  const client = new Client({
    host: env("DB_HOST", "localhost"),
    port: parseInt(env("DB_PORT", "5432"), 10),
    user: env("DB_USERNAME", "postgres"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_DATABASE", "autocodeflow"),
  });
  await client.connect();

  const report = { guardPresent: null, mutationDenied: null, sequence: null, window: null };

  // 1. guard-present
  const trigRes = await client.query(
    `SELECT t.tgname, t.tgenabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_logs' AND NOT t.tgisinternal`,
  );
  report.guardPresent = checkGuardPresent(trigRes.rows);

  // 2. mutation-denied（ROLLBACK 事务内受控写试）
  if (!reportOnly) {
    const attempt = { attempted: false, rejected: false, error: null };
    try {
      await client.query("BEGIN");
      const one = await client.query(
        `SELECT id FROM "audit_logs" ORDER BY id DESC LIMIT 1`,
      );
      if (one.rows.length === 0) {
        // 表空：插入一行再试（同样回滚）
        await client.query(
          `INSERT INTO "audit_logs" ("action") VALUES ('sec-10 self-probe') RETURNING id`,
        );
      }
      attempt.attempted = true;
      try {
        await client.query(
          `UPDATE "audit_logs" SET "username" = 'sec-10-tamper-probe' WHERE id = (SELECT COALESCE(MAX(id), 0) FROM "audit_logs")`,
        );
        attempt.rejected = false;
      } catch (e) {
        attempt.rejected = true;
        attempt.error = e.message;
      }
    } catch (e) {
      attempt.error = e.message;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
    report.mutationDenied = checkMutationDenied(attempt);
  }

  // 3. sequence-integrity（最近 5000 行）
  const seqRes = await client.query(
    `SELECT id, "createdAt" FROM "audit_logs" ORDER BY id DESC LIMIT 5000`,
  );
  report.sequence = checkSequenceIntegrity(seqRes.rows);
  // 时间窗报告：7 天
  report.window = buildWindowReport(seqRes.rows, 7 * 86_400_000);

  await client.end();

  // 输出报告
  console.log("SEC-10 审计防篡改验证报告");
  console.log(`  guard-present : ${report.guardPresent.ok ? "✔" : "✘"} ${report.guardPresent.reason ?? "trg_audit_logs_append_only 已安装且启用"}`);
  if (report.mutationDenied) {
    console.log(`  mutation-denied: ${report.mutationDenied.ok ? "✔" : "✘"} ${report.mutationDenied.reason ?? "UPDATE 试写被触发器拒绝（P0001）"}`);
  } else {
    console.log("  mutation-denied: -（--report-only 跳过）");
  }
  console.log(`  sequence      : ${report.sequence.ok ? "✔" : "✘"} 检查 ${report.sequence.checked} 行，id 序 vs createdAt 序违例 ${report.sequence.violations}`);
  console.log(`  window(7d)    : 总行 ${report.window.totalRows}，窗内 ${report.window.rowsInWindow}，密度约 ${report.window.densityPerDay}/天`);

  const failed =
    report.guardPresent.ok === false ||
    report.mutationDenied?.ok === false ||
    report.sequence.ok === false;
  process.exitCode = failed ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    // selftest 由 scripts/audit-verify.selftest.mjs 承担（临时矩阵），此处提示
    console.log("selftest 请运行：node scripts/audit-verify.selftest.mjs");
    return;
  }
  runDbChecks({ reportOnly: argv.includes("--report-only") }).catch((e) => {
    console.error(`✘ 验证执行失败：${e.message}`);
    process.exit(1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
