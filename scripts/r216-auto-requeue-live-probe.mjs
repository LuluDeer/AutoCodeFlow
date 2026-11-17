#!/usr/bin/env node
/**
 * R216：**自动补入队的 CAS 单赢家** —— 真机（真 PG）验证。
 *
 * ## 为什么必须有这一条
 *
 * 自动补是本仓**唯一**一条「自动处置」的判据（其余五条都只告警）。它最大的风险是
 * **多副本同时补** ⇒ 同一条会话被补 N 次。判据 §3.1 的答案是 CAS
 * （`claimBacklogReenqueue`，条件写 + `affected > 0` 才算赢）。
 *
 * 单测只能证明「谓词的字符串写对了」；**只有真 PG 能证明「并发下真的只有一个赢家」** ——
 * 而后者才是这一列存在的意义。
 *
 * ## 断言
 *
 *  ① 列已存在且形状正确（`integer NULL DEFAULT 0` ⇒ catalog-only、零回填）；
 *  ② **并发 10 个 CAS ⇒ 只有一个赢家**（最终计数 = 1）；这是**核心**断言；
 *  ③ **已补过的会话 ⇒ 再 CAS 必失败**（幂等边界：额度耗尽后不再补）；
 *  ④ **非 `pending` 的会话 ⇒ CAS 必失败**（判定与 CAS 之间的时间窗：可能已被推进）；
 *  ⑤ 清理生效：探针造的会话残留 = 0（**回读**）。
 *
 * ## 安全边界
 *
 * · 只碰 `triggerSource = 'r216-probe'` 的会话（精确匹配，不按通配删）；
 * · **不碰任何真实会话**（所有 SQL 都带 `triggerSource` 或刚插入的 id）；
 * · 用真 PG（`1Panel-postgresql-cFrN`），但不建表、不改结构 —— 本探针假设列已由迁移加好。
 *
 * 用法：`npm run test:r216-auto-requeue-live`
 */
import { execFileSync } from "node:child_process";

const PG_CONTAINER = process.env.R216_PG_CONTAINER || "1Panel-postgresql-cFrN";
const PG_USER = process.env.R216_PG_USER || "autoflow";
const PG_DB = process.env.R216_PG_DB || "autoflow";
const PROBE_TAG = "r216-probe";
/** 并发度：≥2 就能证明「不是顺序执行」；10 足以在真 PG 上暴露竞态。 */
const CONCURRENCY = 10;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

function psql(sql) {
  const raw = execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", sql],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  // ⚠️ `-tAc` 仍会打印命令状态行（`INSERT 0 1` 等）—— 实测踩过：`RETURNING id`
  //    的返回值因此变成 "<uuid>\nINSERT 0 1"，后续拼进 SQL 就报
  //    `invalid input syntax for type uuid`。⇒ 只保留**不含**状态行的那一行。
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(INSERT|UPDATE|DELETE) \d+( \d+)?$/.test(l))
    .join("\n");
}

/**
 * 执行一条**写语句**并返回它的**命令状态行**（`UPDATE 1` / `UPDATE 0`）。
 *
 * ⚠️ 不能复用 `psql()`：那个函数**故意**过滤掉状态行（为了拿 `RETURNING` 的纯值）。
 * 这里要的恰恰是状态行本身（`affected` 的语义）。
 */
function psqlStatus(sql) {
  const raw = execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", sql],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
  // `-tAc` 下写语句只输出状态行（无 RETURNING）⇒ 取最后一行。
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}

/** 生产同款 CAS 谓词（与 `claimBacklogReenqueue` 逐字一致 —— 这是本条的被测对象）。 */
function casSql(id) {
  // ⚠️ 若改了 `agent-session.service.ts` 的谓词，**这里必须同步**，否则本条测的不是生产行为。
  return (
    `UPDATE agent_sessions SET "backlogReenqueueCount" = "backlogReenqueueCount" + 1 ` +
    `WHERE id = '${id}' AND "backlogReenqueueCount" < 1 AND status = 'pending'`
  );
}

async function main() {
  try {
    // ── ① 列的形状 ──────────────────────────────────────────────────────
    const col = psql(
      `SELECT is_nullable || '|' || coalesce(column_default,'(none)') ` +
        `FROM information_schema.columns ` +
        `WHERE table_name='agent_sessions' AND column_name='backlogReenqueueCount'`,
    );
    check(
      "① 列已存在且形状正确（可空 + 默认 0 ⇒ catalog-only、存量零回填）",
      col === "YES|0",
      `is_nullable|default = ${col || "(缺列)"}`,
    );
    if (col !== "YES|0") throw new Error("列形状不符 —— 先跑迁移 1790000000099");

    // ── ② ★ 并发 CAS ⇒ 单赢家 ───────────────────────────────────────────
    const id = psql(
      `INSERT INTO agent_sessions (kind,status,"triggerSource","createdAt","updatedAt","backlogReenqueueCount") ` +
        `VALUES ('task','pending','${PROBE_TAG}',now(),now(),0) RETURNING id`,
    );
    check("② 造一条 `pending` 探针会话", !!id, `id=${id}`);

    // 起 CONCURRENCY 个**真并发** psql 进程抢同一行。用 spawn 而不是顺序 await ——
    // 顺序执行永远只有一个赢家，那样的测试**证明不了**并发安全。
    const { spawn } = await import("node:child_process");
    const runs = Array.from({ length: CONCURRENCY }, () => {
      return new Promise((resolve) => {
        const p = spawn("docker", [
          "exec", PG_CONTAINER,
          "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", casSql(id),
        ]);
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("close", () => resolve(out.trim()));
      });
    });
    const outs = await Promise.all(runs);
    const winners = outs.filter((o) => o === "UPDATE 1").length;

    check(
      `③ ★ 并发 ${CONCURRENCY} 个 CAS ⇒ **只有一个赢家**（这是多副本安全的实证）`,
      winners === 1,
      `赢家=${winners} / ${CONCURRENCY}（各进程输出：${outs.map((o) => o.replace("UPDATE ", "")).join(",")}）`,
    );

    const finalCount = psql(
      `SELECT "backlogReenqueueCount" FROM agent_sessions WHERE id='${id}'`,
    );
    check(
      "④ 计数最终 = 1（不是 2+ —— 那意味着同一条会话会被补多次）",
      finalCount === "1",
      `count=${finalCount}`,
    );

    // ── ⑤ 额度耗尽 ⇒ 再 CAS 必失败（幂等边界）───────────────────────────
    const again = psqlStatus(casSql(id));
    check(
      "⑤ 已补过的会话 ⇒ 再 CAS **必失败**（`UPDATE 0`）—— 额度耗尽后不再补",
      again === "UPDATE 0",
      `第二次 CAS = ${again}`,
    );

    // ── ⑥ 非 pending ⇒ CAS 必失败（判定与 CAS 之间的时间窗）───────────────
    const id2 = psql(
      `INSERT INTO agent_sessions (kind,status,"triggerSource","createdAt","updatedAt","backlogReenqueueCount") ` +
        `VALUES ('task','running','${PROBE_TAG}',now(),now(),0) RETURNING id`,
    );
    const nonPending = psqlStatus(casSql(id2));
    check(
      "⑥ 非 `pending` 的会话 ⇒ CAS **必失败**（判定后、CAS 前可能已被推进成 running）",
      nonPending === "UPDATE 0",
      `status=running 时 CAS = ${nonPending}`,
    );
  } finally {
    let deleted = "?";
    try {
      deleted = psql(`DELETE FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`);
    } catch (err) {
      console.error(`⚠️ 清理失败：${err?.message ?? err}`);
    }
    const left = psql(
      `SELECT count(*) FROM agent_sessions WHERE "triggerSource"='${PROBE_TAG}'`,
    );
    check(
      "⑦ 清理生效：探针会话残留 = 0（**回读**确认，不是「我删了」）",
      left === "0",
      `DELETE=${deleted} 残留=${left}`,
    );
  }

  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n${failed.length === 0 ? "✔" : "✘"} R216 自动补 CAS 真机探针：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `（失败：${failed.map((f) => f.name).join(" / ")}）` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("探针异常终止：", err?.message ?? err);
  process.exit(2);
});
