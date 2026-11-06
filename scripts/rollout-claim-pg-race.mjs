#!/usr/bin/env node
/**
 * R52（2026-11-05）：**真实 PG** 验证 `rolloutBatchClaimId` 的「条件 UPDATE + 部分唯一索引」引擎行为。
 *
 * R30 只做到"确定性判据 + 静态契约"，真机那笔降级了；本轮补上。
 *
 * ## 三组
 * 1. **同批次并发认领**（N 轮）：两条独立连接并发
 *    `UPDATE … SET "rolloutBatchClaimId"=$batch WHERE id=$owner AND "rolloutBatchClaimId" IS NULL`
 *    ⇒ **恰好一条 affected=1**（CAS 生效）。
 * 2. **跨批次（同 application）**：第三条连接为**同一 application** 的另一行认领**另一个批次**
 *    ⇒ 必须被**部分唯一索引**拒绝（期望 `23505` + 索引名 `uq_app_deployments_rollout_claim`）。
 * 3. **反向验证**：`DROP INDEX` 后重跑组 2 的形态 ⇒ **两条批次同时成功**（证明索引是唯一防线），
 *    随后重建索引并清理。
 *
 * ## 索引定义（**逐字**来自迁移 `1790000000095-AddRolloutBatchClaim.ts:79-83`）
 *     CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deployments_rollout_claim"
 *     ON "app_deployments" ("applicationId")
 *     WHERE "rolloutBatchClaimId" IS NOT NULL
 * 本脚本建**同形**表 `app_deployments_r52` + 同名索引以复用真实 DDL 语义。
 *
 * ## 用法
 *   node scripts/rollout-claim-pg-race.mjs --dsn=postgres://postgres:r52@127.0.0.1:55452/r52 --rounds=10
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "../..");
const require = createRequire(`${REPO_ROOT}/apps/admin-api/package.json`);
const { Client } = require("pg");

/**
 * R100：连接串解析 —— **优先 `--dsn=<url>`，其次 `--dsn <url>`，再次 `DATABASE_URL`**。
 * 三处都没有 ⇒ 打印 SKIP 并 exit 0（与 `npm run test:pg-race` 语义一致，不静默绿也不误红）。
 * 为什么要有这条：R99 实测 `--dsn <url>`（空格形式）会被旧 `arg()` 忽略 ⇒ 静默回落到历史容器端口。
 */
function resolveDsn(defaultDsn) {
  const eq = process.argv.find((a) => a.startsWith("--dsn="));
  if (eq) return { dsn: eq.slice("--dsn=".length), from: "--dsn=" };
  const i = process.argv.indexOf("--dsn");
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return { dsn: process.argv[i + 1], from: "--dsn <url>" };
  }
  if (process.env.DATABASE_URL) return { dsn: process.env.DATABASE_URL, from: "DATABASE_URL" };
  console.log(`SKIP: 需要 --dsn=<url> / --dsn <url> / DATABASE_URL（真机 PG 用例；旧默认值 ${defaultDsn} 已不再使用）`);
  process.exit(0);
}

const arg = (flag, dflt) => {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : dflt;
};
const { dsn: DSN, from: DSN_FROM } = resolveDsn("postgres://postgres:r52@127.0.0.1:55452/r52");
const ROUNDS = Number(arg("--rounds", "10"));
const TBL = "app_deployments_r52";
const IDX = "uq_app_deployments_rollout_claim";

const client = async () => {
  const c = new Client({ connectionString: DSN });
  await c.connect();
  return c;
};

async function schema({ withIndex = true } = {}) {
  const c = await client();
  await c.query(`DROP TABLE IF EXISTS ${TBL}`);
  await c.query(`CREATE TABLE ${TBL} (
    id text PRIMARY KEY,
    "applicationId" text NOT NULL,
    "rolloutBatchClaimId" varchar NULL
  )`);
  if (withIndex) {
    // 逐字照抄迁移里的 DDL（只换表名）
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${IDX}" ON "${TBL}" ("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL`);
  }
  await c.end();
}

async function seed() {
  const c = await client();
  await c.query(`DELETE FROM ${TBL}`);
  // 同一 application 的两行 canary（owner 行 + 非 owner 行）
  await c.query(`INSERT INTO ${TBL} (id, "applicationId") VALUES ('d1','app-1'), ('d2','app-1')`);
  await c.end();
}

const claimSql = `UPDATE ${TBL} SET "rolloutBatchClaimId"=$2 WHERE id=$1 AND "rolloutBatchClaimId" IS NULL`;

async function group1() {
  const rows = [];
  let ok = true;
  for (let i = 1; i <= ROUNDS; i += 1) {
    await seed();
    const a = await client();
    const b = await client();
    // autocommit 单语句并发（R51 教训：不要在事务里 Promise.all 打同一行，会自锁）
    const [ra, rb] = await Promise.all([
      a.query(claimSql, ["d1", "batch-A"]).then((r) => r.rowCount),
      b.query(claimSql, ["d1", "batch-A"]).then((r) => r.rowCount),
    ]);
    await a.end();
    await b.end();
    const winners = (ra === 1 ? 1 : 0) + (rb === 1 ? 1 : 0);
    ok = ok && winners === 1;
    rows.push({ round: i, a: ra, b: rb, winners });
    console.log(`组1 round ${i}: connA=${ra} connB=${rb} winners=${winners} ${winners === 1 ? "✔" : "✘"}`);
  }
  return { ok, rows };
}

async function group2() {
  await seed();
  // 第一条连接：d1 认领 batch-A（owner 行）
  const a = await client();
  await a.query(claimSql, ["d1", "batch-A"]);
  // 第二条连接：同一 application 的**另一行** d2 认领**另一个批次**
  const b = await client();
  let code = null;
  let constraint = null;
  try {
    await b.query(claimSql, ["d2", "batch-B"]);
    console.log("组2: ✘ 未被拒绝（说明索引没生效）");
  } catch (e) {
    code = e.code ?? null;
    constraint = e.constraint ?? null;
    console.log(`组2: 被拒绝 code=${code} constraint=${constraint} ${code === "23505" ? "✔" : "✘"}`);
  }
  await a.end();
  await b.end();
  return { code, constraint, ok: code === "23505" };
}

async function group3() {
  // 反向验证：去掉部分唯一索引 ⇒ 两条批次必须都能成功
  await schema({ withIndex: false });
  await seed();
  const a = await client();
  const b = await client();
  const ra = (await a.query(claimSql, ["d1", "batch-A"])).rowCount;
  const rb = (await b.query(claimSql, ["d2", "batch-B"])).rowCount;
  await a.end();
  await b.end();
  const ok = ra === 1 && rb === 1;
  console.log(
    `组3（DROP INDEX 后）: d1@batch-A=${ra} d2@batch-B=${rb} ⇒ ${ok ? "两条都成功（证明索引是唯一防线）✔" : "未复现 ✘"}`,
  );
  return { ra, rb, ok };
}

async function main() {
  await schema({ withIndex: true });
  const g1 = await group1();
  const g2 = await group2();
  const g3 = await group3();
  // 清理：重建索引后把表删掉
  await schema({ withIndex: true });
  const c = await client();
  await c.query(`DROP TABLE IF EXISTS ${TBL}`);
  await c.end();

  const pass = g1.ok && g2.ok && g3.ok;
  console.log("");
  console.log(
    `${pass ? "✔" : "✘"} R52 rollout claim 真机验证：组1 ${ROUNDS} 轮` +
      `${g1.ok ? "全部恰好一条" : "存在例外"}；组2 ${g2.ok ? "23505 拒绝" : "未拒绝"}；组3 ${g3.ok ? "两条都成功" : "未复现"}`,
  );
  return pass ? 0 : 1;
}

const _invokedDirectly = process.argv[1] && resolve(process.argv[1]) === HERE;
if (_invokedDirectly) {
  process.exit(await main());
}

export { group1 as sameBatchRace, group2 as crossBatchConflict, group3 as indexDroppedReverse };
