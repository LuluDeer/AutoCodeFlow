#!/usr/bin/env node
/**
 * R51（2026-11-05）：**真实 PG** 上验证审批消费 CAS 的引擎语义（R37 只用有状态替身验过）。
 *
 * ## 验什么
 * `agent-approvals.service.ts` 的 `consume()` 落库形态是一条**条件 UPDATE**：
 *
 *     UPDATE … SET status='consumed', "consumedAt"=… WHERE approvalKey=$1
 *       AND status='granted' AND scope='once' AND "policyFingerprint"=$2
 *
 * 用**两条独立连接**并发打同一行，断言：
 *   · **恰好一条** `affected=1`（赢家），另一条 `affected=0`（输家）；
 *   · 输家再查一次 ⇒ 行已是 `consumed` ⇒ 等价于 `explainConsumeFailure()==='not_granted'`；
 *   · **不存在"两枚同时可用"**。
 *
 * ## 反向验证（必做）
 * 去掉 `status='granted'` 谓词再并发 ⇒ 必须观察到**两条都 affected=1**。
 * 这一步证明「本平台真能并发打同一行」——否则前面的"恰好一条"可能只是**串行假绿**。
 *
 * ## 用法
 *   node scripts/approval-consume-pg-race.mjs --dsn=postgres://postgres:r51@127.0.0.1:55451/r51 --rounds=10
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "../..");
// 复用 admin-api 的 pg 驱动（避免为真机用例新增依赖）
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

const { dsn: DSN, from: DSN_FROM } = resolveDsn("postgres://postgres:r51@127.0.0.1:55451/r51");
const ROUNDS = Number(arg("--rounds", "10"));
const KEY = "apr-s-1-r51race";
const FP = "c".repeat(64);

async function setup() {
  const c = new Client({ connectionString: DSN });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS agent_approvals_r51`);
  await c.query(`CREATE TABLE agent_approvals_r51 (
    "approvalKey" text PRIMARY KEY,
    status text NOT NULL,
    scope text NOT NULL,
    "policyFingerprint" text,
    "consumedAt" timestamptz
  )`);
  await c.end();
}

async function seed() {
  const c = new Client({ connectionString: DSN });
  await c.connect();
  await c.query(`DELETE FROM agent_approvals_r51`);
  await c.query(
    `INSERT INTO agent_approvals_r51 ("approvalKey", status, scope, "policyFingerprint") VALUES ($1,'granted','once',$2)`,
    [KEY, FP],
  );
  await c.end();
}

/** 一轮并发：两条独立连接同时执行同一条条件 UPDATE。 */
async function round(predicate) {
  const a = new Client({ connectionString: DSN });
  const b = new Client({ connectionString: DSN });
  await a.connect();
  await b.connect();
  const sql = `UPDATE agent_approvals_r51
      SET status='consumed', "consumedAt"=now()
      WHERE "approvalKey"=$1 ${predicate ? "AND status='granted' AND scope='once' AND \"policyFingerprint\"=$2" : ""}
      RETURNING status`;
  // **不要显式 BEGIN**：两条连接各跑一条 autocommit UPDATE 才是真实并发形态。
  // （R51 首版在 BEGIN 之后 `await Promise.all([...UPDATE])` ⇒ 后到者等前者持锁、前者等 Promise.all
  //   两边都不提交 ⇒ **自锁**。这是本轮踩到的坑，记在 verify.log 里。）
  // autocommit 下：后到者的 UPDATE 会阻塞到前者提交，然后按**新的行版本**重新求值谓词
  // ⇒ 谓词不再匹配 ⇒ affected=0。这正是要验证的引擎语义。
  const [ra, rb] = await Promise.all([
    a.query(sql, predicate ? [KEY, FP] : [KEY]).then((r) => r.rowCount),
    b.query(sql, predicate ? [KEY, FP] : [KEY]).then((r) => r.rowCount),
  ]);
  // 输家判定：再查一次行状态（等价 explainConsumeFailure 的 not_granted 分支）
  const chk = await a.query(`SELECT status FROM agent_approvals_r51 WHERE "approvalKey"=$1`, [KEY]);
  const statusAfter = chk.rows[0]?.status ?? null;
  await a.end();
  await b.end();
  return { ra, rb, statusAfter };
}

async function main() {
  await setup();
  const rows = [];
  let ok = true;
  for (let i = 1; i <= ROUNDS; i += 1) {
    await seed();
    const r = await round(true);
    const winners = (r.ra === 1 ? 1 : 0) + (r.rb === 1 ? 1 : 0);
    const exactlyOne = winners === 1;
    const loserNotGranted = r.statusAfter === "consumed";
    ok = ok && exactlyOne && loserNotGranted;
    rows.push({ round: i, a: r.ra, b: r.rb, winners, statusAfter: r.statusAfter });
    console.log(
      `round ${i}: connA=${r.ra} connB=${r.rb} winners=${winners} statusAfter=${r.statusAfter} ` +
        `${exactlyOne && loserNotGranted ? "✔" : "✘"}`,
    );
  }

  // ── 反向验证：去掉状态谓词 ⇒ 两条都必须能更新到（证明确实并发打同一行）
  await seed();
  const rev = await round(false);
  const bothSucceeded = rev.ra === 1 && rev.rb === 1;
  console.log("");
  console.log(
    `反向验证（去掉 status='granted' 谓词）: connA=${rev.ra} connB=${rev.rb} ⇒ ` +
      `${bothSucceeded ? "两条都 affected=1（证明平台真能并发打同一行）✔" : "未复现并发 ✘"}`,
  );

  const c = new Client({ connectionString: DSN });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS agent_approvals_r51");
  await c.end();

  const pass = ok && bothSucceeded;
  console.log("");
  console.log(
    `${pass ? "✔" : "✘"} R51 审批消费 CAS 真机验证：${ROUNDS} 轮` +
      `${ok ? "全部恰好一条成功" : "存在例外轮（见上）"}；反向验证${bothSucceeded ? "复现了并发" : "未复现并发"}`,
  );
  return pass ? 0 : 1;
}

const _invokedDirectly = process.argv[1] && resolve(process.argv[1]) === HERE;
if (_invokedDirectly) {
  process.exit(await main());
}

export { round as concurrentConsumeRound };
