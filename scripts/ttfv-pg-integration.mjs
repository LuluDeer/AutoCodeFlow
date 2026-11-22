#!/usr/bin/env node
/**
 * R310 —— TTFV funnel 核心真库行为验证脚本。**本文件是验证脚本，不是产品代码。**
 *
 * ## 验什么（4 项）
 * 1. DDL 有效性：照 `migrations/1790000000101-AddFunnelEvents.ts` 的 CREATE TABLE +
 *    复合索引 + dedupe_key 唯一索引 DDL，在真 PG 上原样执行成功（列类型/长度/PK/索引均核对）。
 * 2. 幂等写入：复刻 `FunnelEventsService.record` 的 `INSERT ... ON CONFLICT (dedupe_key)
 *    DO NOTHING RETURNING` 语义——同一 dedupeKey 第一次 returning 有 1 行，第二次 0 行。
 * 3. 事件对账：同一 install_id 写入 install_completed / task_first_success 两条事件
 *    （dedupeKey 前缀不同互不冲突），按 event_name 分组各得 1 条。
 * 4. 中位数 SQL：照方案 §4.3 阶段1代理口径，在临时 mini task_executions 上真跑
 *    PERCENTILE_CONT(0.5)，5/10/15 分钟三条样本 ⇒ 10 分钟（另插噪声行验证过滤条件）。
 *
 * ## 为什么必须真库
 * 前 20 轮均为单测/内存替身/静态哨针，无法证明 migration SQL 能被 PG 接受、
 * ON CONFLICT 依赖的唯一索引真的生效、RETURNING 能区分真插入与冲突、分位聚合
 * 在 PG 的 numeric/double 语义下算出 expectation。本脚本断言的是数据库实际副作用。
 *
 * ## 隔离策略
 * 只创建统一前缀 `ttfv_r310_` 的临时表/索引（不碰真实 funnel_events/task_executions），
 * 启动时 DROP IF EXISTS，finally 中无条件 DROP 并复查 pg_tables；口令只进 Client
 * connectionString，不打印；无 DSN 打印 SKIP 并 exit 0（不假绿也不误红）。
 *
 * 用法：node scripts/ttfv-pg-integration.mjs --dsn=<url> | --dsn <url> | DATABASE_URL=<url>
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "../..");
// 复用 admin-api 的 pg 驱动（避免为真机验证脚本新增依赖）
const require = createRequire(`${REPO_ROOT}/apps/admin-api/package.json`);
const { Client } = require("pg");

/** 与 approval-consume-pg-race.mjs 相同的 DSN 解析优先级。 */
function resolveDsn() {
  const eq = process.argv.find((a) => a.startsWith("--dsn="));
  if (eq) return { dsn: eq.slice("--dsn=".length), from: "--dsn=" };
  const i = process.argv.indexOf("--dsn");
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return { dsn: process.argv[i + 1], from: "--dsn <url>" };
  }
  if (process.env.DATABASE_URL) {
    return { dsn: process.env.DATABASE_URL, from: "DATABASE_URL" };
  }
  console.log(
    "SKIP: 需要 --dsn=<url> / --dsn <url> / DATABASE_URL 才能做真 PG 验证（无 DSN 按 SKIP exit 0，不假绿）",
  );
  process.exit(0);
}

const { dsn: DSN, from: DSN_FROM } = resolveDsn();

const PREFIX = "ttfv_r310_";
const EVENTS = `${PREFIX}funnel_events`;
const EXECS = `${PREFIX}task_executions`;
const IDX_PAIR = `${PREFIX}idx_funnel_events_install_id_event_name`;
const IDX_UNIQUE = `${PREFIX}uq_funnel_events_dedupe_key`;

/** 防止 PG 错误信息回带连接串中的口令。 */
function redact(text) {
  return String(text)
    .split(DSN)
    .join("[REDACTED_DSN]")
    .replace(/\/\/[^:@\s]+:[^@\s]+@/g, "//[REDACTED]@");
}

function report(name, ok, detail) {
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function verifyDdl(c) {
  // 与 migration 101 的 up() 同构，仅替换表名/索引名以隔离在临时命名空间。
  await c.query(`DROP TABLE IF EXISTS ${EVENTS}`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS} (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "install_id" character varying(128) NOT NULL,
      "event_name" character varying(64) NOT NULL,
      "task_id_hash" character varying(128) NULL,
      "execution_id_hash" character varying(128) NULL,
      "ts" TIMESTAMP WITH TIME ZONE NOT NULL,
      "dedupe_key" character varying(255) NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "ttfv_r310_pk_funnel_events" PRIMARY KEY ("id")
    )
  `);
  await c.query(`
    CREATE INDEX IF NOT EXISTS ${IDX_PAIR}
      ON ${EVENTS} ("install_id", "event_name")
  `);
  await c.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${IDX_UNIQUE}
      ON ${EVENTS} ("dedupe_key")
  `);

  const cols = await c.query(
    `SELECT column_name, data_type, character_maximum_length
       FROM information_schema.columns WHERE table_name = $1
      ORDER BY ordinal_position`,
    [EVENTS],
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  const expected = [
    ["id", "uuid", null],
    ["install_id", "character varying", 128],
    ["event_name", "character varying", 64],
    ["task_id_hash", "character varying", 128],
    ["execution_id_hash", "character varying", 128],
    ["ts", "timestamp with time zone", null],
    ["dedupe_key", "character varying", 255],
    ["created_at", "timestamp with time zone", null],
  ];
  const columnsOk =
    cols.rowCount === expected.length &&
    expected.every(([name, type, len]) => {
      const col = byName.get(name);
      return (
        col?.data_type === type &&
        (len === null
          ? col.character_maximum_length === null
          : Number(col.character_maximum_length) === len)
      );
    });
  const pk = await c.query(
    `SELECT constraint_type FROM information_schema.table_constraints
      WHERE table_name = $1 AND constraint_type = 'PRIMARY KEY'`,
    [EVENTS],
  );
  // pg_indexes 也包含 PRIMARY KEY 隐式索引；这里只核对 migration 显式创建的两条索引。
  const idx = await c.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = $1 AND indexname <> 'ttfv_r310_pk_funnel_events'
      ORDER BY indexname`,
    [EVENTS],
  );
  const idxNames = idx.rows.map((r) => r.indexname).sort();
  const indexesOk =
    idx.rowCount === 2 && idxNames[0] === IDX_PAIR && idxNames[1] === IDX_UNIQUE;
  const ok = columnsOk && pk.rowCount === 1 && indexesOk;
  return report(
    "① DDL 有效性（migration 101 真执行）",
    ok,
    `列 ${cols.rowCount}/8（类型+长度核对=${columnsOk}），PK=${pk.rowCount === 1}，索引=[${idxNames.join(", ")}]`,
  );
}

async function verifyIdempotent(c) {
  const key = "ttfv-r310-dedupe:idem-once";
  const installId = "ttfv-r310-install-idem";
  const sql = `
    INSERT INTO ${EVENTS} ("install_id", "event_name", "ts", "dedupe_key")
    VALUES ($1, 'install_completed', now(), $2)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING dedupe_key
  `;
  const first = await c.query(sql, [installId, key]);
  const second = await c.query(sql, [installId, key]);
  const total = await c.query(
    `SELECT COUNT(*)::int AS n FROM ${EVENTS} WHERE dedupe_key = $1`,
    [key],
  );
  const ok =
    first.rowCount === 1 &&
    first.rows[0]?.dedupe_key === key &&
    second.rowCount === 0 &&
    Number(total.rows[0].n) === 1;
  return report(
    "② 幂等写入（ON CONFLICT DO NOTHING RETURNING）",
    ok,
    `first.returning=${first.rowCount} 行(${first.rows[0]?.dedupe_key ?? "null"}), ` +
      `second.returning=${second.rowCount} 行, 表内该 key=${total.rows[0].n} 行`,
  );
}

async function verifyPairReconciliation(c) {
  const installId = "ttfv-r310-install-pair";
  const base = new Date("2026-11-21T00:00:00.000Z");
  const events = [
    {
      name: "install_completed",
      key: `install-completed:${installId}`,
      ts: base,
    },
    {
      name: "task_first_success",
      key: "first-success:ttfv-r310-taskhash",
      ts: new Date(base.getTime() + 10 * 60_000),
    },
  ];
  const sql = `
    INSERT INTO ${EVENTS} ("install_id", "event_name", "ts", "task_id_hash", "dedupe_key")
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING dedupe_key
  `;
  const inserted = [];
  for (const e of events) {
    const r = await c.query(sql, [
      installId,
      e.name,
      e.ts,
      e.name === "task_first_success" ? "ttfv-r310-taskhash" : null,
      e.key,
    ]);
    inserted.push(r.rowCount);
  }
  const grouped = await c.query(
    `SELECT event_name, COUNT(*)::int AS n FROM ${EVENTS}
      WHERE install_id = $1 GROUP BY event_name ORDER BY event_name`,
    [installId],
  );
  const counts = Object.fromEntries(
    grouped.rows.map((r) => [r.event_name, Number(r.n)]),
  );
  const ok =
    inserted.every((n) => n === 1) &&
    grouped.rowCount === 2 &&
    counts.install_completed === 1 &&
    counts.task_first_success === 1;
  return report(
    "③ 事件对账（同 install 两种事件各一条、dedupeKey 不冲突）",
    ok,
    `inserted=[${inserted.join(",")}]，分组=${JSON.stringify(counts)}`,
  );
}

async function verifyMedianSql(c) {
  await c.query(`DROP TABLE IF EXISTS ${EXECS}`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${EXECS} (
      "taskId" character varying(128) NOT NULL,
      "endTime" TIMESTAMP WITH TIME ZONE,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "status" character varying(32) NOT NULL,
      "synthetic" boolean NOT NULL
    )
  `);
  const base = new Date("2026-11-21T00:00:00.000Z");
  const rows = [
    ["ttfv-r310-t5", 5, "success", false],
    ["ttfv-r310-t10", 10, "success", false],
    ["ttfv-r310-t15", 15, "success", false],
    // 噪声：synthetic / 非 success / endTime < createdAt 都必须被 WHERE 过滤
    ["ttfv-r310-noise-synthetic", 1, "success", true],
    ["ttfv-r310-noise-failed", 2, "failed", false],
    ["ttfv-r310-noise-negative", -3, "success", false],
  ];
  const insert = `
    INSERT INTO ${EXECS} ("taskId", "endTime", "createdAt", "status", "synthetic")
    VALUES ($1, $2, $3, $4, $5)
  `;
  for (const [taskId, minutes, status, synthetic] of rows) {
    await c.query(insert, [
      taskId,
      new Date(base.getTime() + minutes * 60_000),
      base,
      status,
      synthetic,
    ]);
  }

  // §4.3 阶段1代理口径 SQL：task_executions 替换为临时表，tasks 用同表聚合 CTE 代替。
  const sql = `
    WITH first_success AS (
      SELECT e."taskId", MIN(e."endTime") AS first_success_at
      FROM ${EXECS} e
      WHERE e."status" = 'success'
        AND e."synthetic" = false
        AND e."endTime" IS NOT NULL
        AND e."endTime" >= e."createdAt"
      GROUP BY e."taskId"
    ), tasks AS (
      SELECT e."taskId" AS id, MIN(e."createdAt") AS "createdAt"
      FROM ${EXECS} e GROUP BY e."taskId"
    )
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (fs.first_success_at - t."createdAt")) / 60.0
      ) AS ttfv_proxy_minutes,
      COUNT(*) AS sample_size
    FROM first_success fs
    JOIN tasks t ON t."id" = fs."taskId"
    WHERE t."createdAt" >= $1
  `;
  const r = await c.query(sql, [new Date("2026-11-01T00:00:00.000Z")]);
  const median = Number(r.rows[0].ttfv_proxy_minutes);
  const n = Number(r.rows[0].sample_size);
  const ok = n === 3 && Math.abs(median - 10) < 1e-9;
  return report(
    "④ 中位数 SQL（PERCENTILE_CONT(0.5)）",
    ok,
    `ttfv_proxy_minutes=${median}，sample_size=${n}（有效样本 5/10/15 分钟，噪声 3 行已过滤）`,
  );
}

async function main() {
  console.log(`DSN 来源：${DSN_FROM}（口令不落日志）`);
  const c = new Client({ connectionString: DSN });
  let connected = false;
  let ok = true;
  try {
    await c.connect();
    connected = true;
    // 不短路：即使某项失败也尽量跑完其余验证，方便一次拿到全部证据。
    const results = [
      await verifyDdl(c),
      await verifyIdempotent(c),
      await verifyPairReconciliation(c),
      await verifyMedianSql(c),
    ];
    ok = results.every(Boolean);
  } catch (e) {
    ok = false;
    report("真库验证执行异常", false, redact(e?.message ?? e));
  } finally {
    if (connected) {
      try {
        await c.query(`DROP TABLE IF EXISTS ${EVENTS}`);
        await c.query(`DROP TABLE IF EXISTS ${EXECS}`);
        const left = await c.query(
          `SELECT tablename FROM pg_tables WHERE tablename = ANY($1)`,
          [[EVENTS, EXECS]],
        );
        ok = report(
          "清理确认（finally 无条件 DROP 并复查）",
          left.rowCount === 0,
          left.rowCount === 0
            ? `${EVENTS} / ${EXECS} 均已删除`
            : `残留=[${left.rows.map((r) => r.tablename).join(", ")}]`,
        ) && ok;
      } catch (e) {
        ok = false;
        report("清理失败", false, redact(e?.message ?? e));
      }
      try {
        await c.end();
      } catch {
        // 连接已断开时无需处理
      }
    } else {
      console.log("— 清理确认：未建立连接，无临时表可清理");
    }
  }
  console.log("");
  console.log(
    `${ok ? "✔" : "✘"} R310 TTFV 真 PG 集成验证：${ok ? "4 项全部通过，临时表已清理" : "存在失败项（见上）"}`,
  );
  return ok ? 0 : 1;
}

process.exit(await main());
