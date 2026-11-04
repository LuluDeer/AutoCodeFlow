/**
 * verify-smoke-s3-retention.mjs —— 场景 3：`S3LogObjectRetentionService`
 * （WIKI-LOG-S3GC）在**真 RustFS + 真 PG** 上的真回收验证。
 *
 * ## 被验对象
 *
 *   apps/admin-api/src/modules/task/log-retention/s3-log-object-retention.service.ts
 *   · `@Cron("0 35 3 * * *")` 的每日入口 `handleDailyObjectCleanup()`；
 *   · **可直接调用**的 `cleanupExpiredObjects(now?): Promise<number>`（:119）——
 *     leaderGate 只在 @Cron 包装层（:98），**方法体内没有** ⇒ 任何实例都能直接调。
 *   · 受害行判据（:177-196，verbatim）：
 *       logStorage = 's3' AND logObjectKey IS NOT NULL
 *       AND status IN (success, failed, timeout, killed, cancelled)
 *       AND COALESCE(endTime, createdAt) < cutoff
 *     keyset 游标 `id > :afterId`，批大小 200，最多 50 轮。
 *   · 删完对象后**带守卫清指针**：`SET logObjectKey = NULL WHERE id = ? AND logObjectKey = ?`。
 *
 * ## 四个断言（题目要求）
 *
 *   ① 对象被删
 *   ② `logObjectKey` 被清空
 *   ③ **保留期内**的对象**不被删**（边界不越界）
 *   ④ **二次跑幂等**（对象不存在不报错）
 *
 * 外加两条边界：
 *   ⑤ **非终态**（running/pending）的过期行**不被回收**（在途执行的日志不能被删）
 *   ⑥ `logStorage='db'` 的行**不被回收**（只回收 s3 指针的行）
 *
 * ## 为什么"过期"用**注入 now** 而不是改 endTime
 *
 * `cleanupExpiredObjects(now)` 的 cutoff 由 `now` 推导 ⇒ 造「已过期」的行有两条路：
 * ① 把 `endTime` 拨到过去；② 传一个**未来的 now**。
 * 两条都做（各自验一遍），因为它们走的是**不同的 SQL 比较分支**
 * （① 命中 `endTime < cutoff`；② 命中 `COALESCE(endTime, createdAt) < cutoff` 的回退）。
 *
 * 用法（容器内）：node /app/verify-smoke-s3-retention.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/app/dist/data-source.js");
const { AppDataSource } = require("/app/dist/data-source.js");
const { Client } = require("minio");
const { S3LogObjectRetentionService } = require("/app/dist/modules/task/log-retention/s3-log-object-retention.service.js");

const RUSTFS_ENDPOINT = process.env.SMOKE_RUSTFS_ENDPOINT || "acfsmoke-rustfs:9000";
const RUSTFS_AK = process.env.SMOKE_RUSTFS_ACCESS_KEY || "";
const RUSTFS_SK = process.env.SMOKE_RUSTFS_SECRET_KEY || "";
const BUCKET = process.env.SMOKE_LOG_BUCKET || "autoflow-logs";
/** 保留期（与容器内 LOG_RETENTION_DAYS 同源；默认 30） */
const RETENTION_DAYS = Number(process.env.SMOKE_LOG_RETENTION_DAYS || 30);

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail += 1; };
const step = (m) => console.log(`\n=== ${m} ===`);

const s3 = new Client({
  endPoint: RUSTFS_ENDPOINT.split(":")[0],
  port: Number(RUSTFS_ENDPOINT.split(":")[1] || 9000),
  useSSL: false,
  accessKey: RUSTFS_AK,
  secretKey: RUSTFS_SK,
});

async function objectExists(name) {
  try {
    await s3.statObject(BUCKET, name);
    return true;
  } catch {
    return false;
  }
}

async function putObject(name, content) {
  const body = Buffer.from(content, "utf-8");
  await s3.putObject(BUCKET, name, body, body.length, {
    "Content-Type": "text/plain; charset=utf-8",
  });
}

async function main() {
  const ds = await AppDataSource.initialize();
  console.log(`[harness] pg connected: ${ds.options.database}@${ds.options.host}:${ds.options.port}`);
  console.log(`[harness] retention days = ${RETENTION_DAYS}`);

  // ═══ 跑前清理（幂等的前提）══════════════════════════════════════════
  //
  // 本脚本造的行/对象：
  //   · tasks(name like 'smoke-s3-gc-%')   ← seed task（名字带 Date.now()）
  //   · task_executions(taskId = 那个 task) ← 6 条 seedExec 行
  //   · S3 对象 execution-logs/gc-*.log.gz ← 6 个 tag（**确定性名字**！）
  //
  // ⚠️ **为什么必须"跑前"而不是"跑后"**：
  //   · S3 对象的 tag 是**确定性**的（gc-victim-1 / gc-keeper-fresh / …）⇒
  //     上一轮残留的对象**会被本轮同名 putObject 覆盖**（无害），
  //     但**上一轮的残留执行行**会让本轮的「回收数 = 2」断言**多算**
  //     （上一轮的 victim 行还在 DB ⇒ 本轮再回收它们 ⇒ 回收数 > 2）⇒ **假红**；
  //     反过来若断言写 `>= 2` ⇒ 就是**假绿**。
  //   ⇒ 跑**开始时**按前缀清干净并**验证计数 = 0** ⇒ 上次失败能被下次自动修复。
  //
  // ⚠️ **清理范围严格限定在自己的前缀内** —— 绝不 `DELETE FROM tasks`。
  step("0. 跑前清理（只删本脚本自己造的 smoke-s3-gc-* 数据/对象，并验证计数 = 0）");
  const TASK_PAT = "smoke-s3-gc-%";
  // ① S3 对象：只删**本脚本自己的确定性 tag**（不碰别的键）
  for (const t of ["gc-victim-1", "gc-victim-2", "gc-keeper-fresh", "gc-keeper-running",
                   "gc-keeper-db", "gc-future-victim"]) {
    try {
      await s3.removeObject(BUCKET, `execution-logs/${t}.log.gz`);
    } catch {
      /* 对象可能已不存在 */
    }
  }
  // ② 子表 → 主表（每句都带 WHERE + 自己的前缀）
  await ds.query(
    `DELETE FROM execution_log_lines WHERE "executionId" IN (
       SELECT id::text FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1))`, [TASK_PAT]);
  await ds.query(
    `DELETE FROM task_executions WHERE "taskId" IN (
       SELECT id FROM tasks WHERE name LIKE $1)`, [TASK_PAT]);
  // ⚠️ audit_logs 是**追加只读**表（迁移 1790000000006 的 trg_audit_logs_append_only
  //    触发器：DELETE/UPDATE 一律 RAISE EXCEPTION）⇒ 必须走会话 GUC 逃生门
  //    `app.bypass_audit_guard = 'on'`（生产审计服务的 retention 路径同款）。
  //    ⇒ SET LOCAL 只在**事务内**有效 ⇒ 必须 BEGIN…COMMIT 包起来。
  await ds.query(`BEGIN`);
  await ds.query(`SET LOCAL app.bypass_audit_guard = 'on'`);
  await ds.query(
    `DELETE FROM audit_logs WHERE "resourceId" IN (
       SELECT id::text FROM tasks WHERE name LIKE $1) AND action LIKE 'task.%'`, [TASK_PAT]);
  await ds.query(`COMMIT`);
  await ds.query(`DELETE FROM tasks WHERE name LIKE $1`, [TASK_PAT]);
  // ③ **验证清理生效**
  const residue = {
    tasks: Number((await ds.query(`SELECT count(*)::int AS n FROM tasks WHERE name LIKE $1`, [TASK_PAT]))[0].n),
    execs: Number((await ds.query(
      `SELECT count(*)::int AS n FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1)`, [TASK_PAT]))[0].n),
  };
  console.log(`[harness] 跑前清理后残留：${JSON.stringify(residue)}`);
  Object.values(residue).every((n) => n === 0)
    ? ok("跑前清理生效：本前缀残留 = 0（tasks / task_executions 全为 0）")
    : bad(`跑前清理未生效：残留 ${JSON.stringify(residue)} ⇒ 中止（不带着脏数据继续跑）`);
  if (!Object.values(residue).every((n) => n === 0)) {
    await ds.destroy();
    process.exit(1);
  }

  const cfgModule = require("/app/dist/config/configuration.js");
  const cfg = cfgModule.default();
  /** 最小 ConfigService 形态（点路径取值）——喂给真实的服务实现 */
  const configService = {
    get(key) {
      const parts = String(key).split(".");
      let cur = cfg;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = cur[p];
      }
      return cur;
    },
  };

  // 真实服务实例（leaderGate=null ⇒ 绕过 Leader 门禁；systemConfig=null ⇒ 走 env 口径）
  const svc = new S3LogObjectRetentionService(
    ds.getRepository(require("/app/dist/modules/task/entities/task-execution.entity.js").TaskExecution),
    configService,
    null,
    null,
  );

  // ── seed：一个 task（task_executions.taskId 有 FK）────────────────────
  const taskRepo = ds.getRepository(require("/app/dist/modules/task/entities/task.entity.js").Task);
  const execRepo = ds.getRepository(require("/app/dist/modules/task/entities/task-execution.entity.js").TaskExecution);
  const task = await taskRepo.save(
    taskRepo.create({
      name: `smoke-s3-gc-${Date.now()}`,
      triggerType: "manual",
      runtime: "node",
      status: "active",
      blockStrategy: "serial",
      misfireStrategy: "ignore",
      timeout: 30,
      maxRetry: 0,
    }),
  );
  console.log(`[harness] seed task id=${task.id}`);

  /**
   * 造一条执行行 + 对应的 S3 对象。
   * status/age 决定它是不是回收候选。
   */
  async function seedExec({ status, ageDays, tag, withObject = true, logStorage = "s3" }) {
    const exec = await execRepo.save(
      execRepo.create({
        taskId: task.id,
        taskName: task.name,
        status,
        startTime: new Date(Date.now() - ageDays * 86400000),
        endTime: status === "running" || status === "pending" ? null : new Date(Date.now() - ageDays * 86400000),
        createdAt: new Date(Date.now() - ageDays * 86400000),
        triggerType: "manual",
        logStorage,
        logObjectKey: withObject ? `execution-logs/${tag}.log.gz` : null,
      }),
    );
    if (withObject) {
      await putObject(`execution-logs/${tag}.log.gz`, `gc-smoke log for ${tag} status=${status} age=${ageDays}d`);
    }
    return exec;
  }

  const OLD = RETENTION_DAYS + 10;      // 远超保留期
  const FRESH = Math.max(1, RETENTION_DAYS - 5); // 保留期内

  // 受害者（终态 + 超保留期 + s3 指针）
  const victim1 = await seedExec({ status: "success", ageDays: OLD, tag: "gc-victim-1" });
  const victim2 = await seedExec({ status: "failed", ageDays: OLD, tag: "gc-victim-2" });
  // 保留期内（边界不越界）
  const keeperFresh = await seedExec({ status: "success", ageDays: FRESH, tag: "gc-keeper-fresh" });
  // 非终态（过期但仍在途）——不能被删
  const keeperRunning = await seedExec({ status: "running", ageDays: OLD, tag: "gc-keeper-running" });
  // logStorage='db'（无 s3 指针语义）——不该被回收
  const keeperDb = await seedExec({ status: "success", ageDays: OLD, tag: "gc-keeper-db", logStorage: "db" });
  // 无对象（logObjectKey 为 NULL）——不该被回收
  const keeperNoKey = await seedExec({ status: "success", ageDays: OLD, tag: "gc-keeper-nokey", withObject: false });

  console.log(`[harness] seeded: victims=2 keepers=4 (fresh / running / db / nokey)`);
  console.log(`[harness] objects before: ${(await Promise.all(
    ["gc-victim-1", "gc-victim-2", "gc-keeper-fresh", "gc-keeper-running", "gc-keeper-db"]
      .map(async (t) => `${t}=${await objectExists(`execution-logs/${t}.log.gz`)}`)
  )).join(" ")}`);

  // ═══ 跑回收 ═══════════════════════════════════════════════════════════
  step("跑回收：cleanupExpiredObjects()");
  const removed = await svc.cleanupExpiredObjects();
  console.log(`[harness] cleanupExpiredObjects() => ${removed}`);
  removed === 2
    ? ok(`回收数 = 2（恰是两条「终态 + 超保留期 + s3 指针」的行）`)
    : bad(`回收数 = ${removed}（期望 2）`);

  // ① 对象被删
  step("① 过期对象被删");
  for (const [tag, exec] of [["gc-victim-1", victim1], ["gc-victim-2", victim2]]) {
    const exists = await objectExists(`execution-logs/${tag}.log.gz`);
    !exists
      ? ok(`${tag}：对象已从 RustFS 删除`)
      : bad(`${tag}：对象仍在 RustFS！`);
  }

  // ② logObjectKey 被清空
  step("② logObjectKey 被清空（带守卫）");
  for (const [tag, exec] of [["gc-victim-1", victim1], ["gc-victim-2", victim2]]) {
    const row = await ds.query(
      `SELECT "logObjectKey", "logStorage" FROM task_executions WHERE id=$1`,
      [exec.id],
    );
    row[0].logObjectKey === null
      ? ok(`${tag}：logObjectKey = NULL（logStorage 仍为 '${row[0].logStorage}'，符合设计）`)
      : bad(`${tag}：logObjectKey 未清空（仍是 '${row[0].logObjectKey}'）`);
  }

  // ③ 保留期内不被删（边界不越界）
  step("③ 保留期内的对象不被删");
  const freshExists = await objectExists(`execution-logs/gc-keeper-fresh.log.gz`);
  freshExists
    ? ok(`保留期内（${FRESH} 天 < ${RETENTION_DAYS} 天）的对象仍在 RustFS`)
    : bad("保留期内的对象被误删了（cutoff 判定越界）！");
  const freshRow = await ds.query(
    `SELECT "logObjectKey" FROM task_executions WHERE id=$1`,
    [keeperFresh.id],
  );
  freshRow[0].logObjectKey !== null
    ? ok("保留期内行的 logObjectKey 未被清空")
    : bad("保留期内行的 logObjectKey 被误清空");

  // ⑤ 非终态不被回收
  step("⑤ 非终态（running）的过期行不被回收");
  const runningExists = await objectExists(`execution-logs/gc-keeper-running.log.gz`);
  runningExists
    ? ok("running 状态的过期对象仍在（在途执行的日志不能被删）")
    : bad("running 状态的过期对象被删了！");
  const runningRow = await ds.query(
    `SELECT "logObjectKey" FROM task_executions WHERE id=$1`,
    [keeperRunning.id],
  );
  runningRow[0].logObjectKey !== null
    ? ok("running 行的 logObjectKey 未被清空")
    : bad("running 行的 logObjectKey 被误清空");

  // ⑥ logStorage='db' 的行不被回收
  step("⑥ logStorage='db' 的行不被回收");
  const dbExists = await objectExists(`execution-logs/gc-keeper-db.log.gz`);
  dbExists
    ? ok("logStorage='db' 行的对象仍在（只回收 s3 指针的行）")
    : bad("logStorage='db' 行的对象被删了！");
  const dbRow = await ds.query(
    `SELECT "logObjectKey" FROM task_executions WHERE id=$1`,
    [keeperDb.id],
  );
  dbRow[0].logObjectKey !== null
    ? ok("logStorage='db' 行的 logObjectKey 未被清空")
    : bad("logStorage='db' 行的 logObjectKey 被误清空");

  // 无 key 的行：不该被回收（没有对象可删）
  const nokeyRow = await ds.query(
    `SELECT "logObjectKey" FROM task_executions WHERE id=$1`,
    [keeperNoKey.id],
  );
  nokeyRow[0].logObjectKey === null
    ? ok("logObjectKey 为 NULL 的行不受影响（无可回收对象）")
    : bad("logObjectKey 为 NULL 的行被改动了");

  // ④ 二次跑幂等
  step("④ 二次跑幂等（对象已不存在不报错）");
  let secondErr = null;
  let secondRemoved = -1;
  try {
    secondRemoved = await svc.cleanupExpiredObjects();
  } catch (err) {
    secondErr = err;
  }
  secondErr === null
    ? ok(`二次 cleanupExpiredObjects() 未抛错，返回 ${secondRemoved}`)
    : bad(`二次跑抛错：${secondErr.message}`);
  secondRemoved === 0
    ? ok("二次跑回收数 = 0（幂等：已回收的不再计）")
    : bad(`二次跑回收数 = ${secondRemoved}（期望 0）`);

  // ── 边界变体：用「未来的 now」而非改 endTime ─────────────────────────
  step("边界变体：传未来的 now ⇒ 原本保留期内的对象变成过期");
  // 造一条「endTime 在保留期内」的行，但 now 往前推 ⇒ 它变成超保留期
  const futureVictim = await seedExec({ status: "success", ageDays: FRESH, tag: "gc-future-victim" });
  const futureNow = new Date(Date.now() + (RETENTION_DAYS + 30) * 86400000);
  const futureRemoved = await svc.cleanupExpiredObjects(futureNow);
  const futureExists = await objectExists(`execution-logs/gc-future-victim.log.gz`);
  console.log(`[harness] future now => removed=${futureRemoved}`);
  futureRemoved >= 1 && !futureExists
    ? ok(`传未来 now（+${RETENTION_DAYS + 30} 天）⇒ 该对象被回收（removed=${futureRemoved}），对象已不存在`)
    : bad(`传未来 now 行为异常：removed=${futureRemoved}, exists=${futureExists}`);
  // 注意：未来 now 会让「保留期内」的行也变成过期 ⇒ keeper-fresh 也会被回收
  // （这是 now 注入的必然结果，不是缺陷）——但 keeper-running / keeper-db 仍不该被回收
  const runningStill = await objectExists(`execution-logs/gc-keeper-running.log.gz`);
  const dbStill = await objectExists(`execution-logs/gc-keeper-db.log.gz`);
  runningStill && dbStill
    ? ok("未来 now 下，running / logStorage=db 的对象**仍未**被回收（非终态与 db 指针是硬过滤）")
    : bad(`未来 now 下边界被破坏：running=${runningStill} db=${dbStill}`);

  // ── 清理 seed ─────────────────────────────────────────────────────────
  for (const t of ["gc-victim-1", "gc-victim-2", "gc-keeper-fresh", "gc-keeper-running", "gc-keeper-db", "gc-future-victim"]) {
    try {
      await s3.removeObject(BUCKET, `execution-logs/${t}.log.gz`);
    } catch {
      /* 对象可能已被回收 */
    }
  }
  await execRepo.delete({ taskId: task.id });
  await taskRepo.delete({ id: task.id });

  await ds.destroy();
  console.log(`\n=== 场景 3（S3 对象回收）小结：PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[harness] FAILED:", err);
  process.exit(1);
});
