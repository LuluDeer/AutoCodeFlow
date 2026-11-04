/**
 * verify-smoke-retention.mjs —— 场景 4：X5「维护簇出仓」的**真库真删除**验证。
 *
 * ## 被验对象（commit 71e593ae 之后的位置）
 *
 *   · `cleanupExpiredMetricsHistory` → 出仓到 `ExecutorMaintenance` 协作者
 *     （apps/admin-api/src/modules/executor/executor-maintenance.collaborator.ts:150），
 *     Facade 上保留 public 转发层（executor.service.ts:6772）——**转发层是
 *     jest.spyOn 的拦截面，必须走它**，否则既有实现级断言静默失效。
 *   · `cleanupOldRecords` → 仍在 Facade（executor.service.ts:6602 @Cron 入口，
 *     :6612 Body，:6650 cleanupOldTaskExecutions）。
 *
 * ## 本脚本的处置
 *
 * **在 admin-api 容器内**运行（镜像里已带 dist/ + typeorm + pg），用**真
 * TypeORM DataSource** 连**真 PG**，构造真实的 ExecutorService / ExecutorMaintenance，
 * 然后调用**生产代码路径本身**跑删除——不是手写等价 SQL。
 *
 * 之所以在容器内而不是宿主机跑：镜像里已有编译产物与依赖；宿主跑 ts-node
 * 需要额外装 reflect-metadata/typeorm 装饰器环境，易与生产不一致。
 *
 * ## 断言（每条都落到 SQL 结果上）
 *
 *   A. 过期行**真的被删**（metrics_history / task_executions 各测过期+新鲜两行）
 *   B. 新鲜行**必须存活**（cutoff 谓词之外）
 *   C. **分批**正确：造 5001 行过期 ⇒ affected == 5001（跨两批；批大小 5000）
 *   D. **幂等**：再跑一次 ⇒ affected == 0
 *   E. **不影响活跃数据**：tasks / executors / system_configs 行数不变
 *
 * 用法（容器内）：node /app/verify-smoke-retention.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/app/dist/data-source.js");

const { AppDataSource } = require("/app/dist/data-source.js");
const { ExecutorService } = require("/app/dist/modules/executor/executor.service.js");
const { ExecutorMaintenance } = require("/app/dist/modules/executor/executor-maintenance.collaborator.js");
const { ExecutorMetricsHistory } = require("/app/dist/modules/executor/entities/executor-metrics-history.entity.js");
const { Executor } = require("/app/dist/modules/executor/entities/executor.entity.js");
const { TaskExecution } = require("/app/dist/modules/task/entities/task-execution.entity.js");
const { Task } = require("/app/dist/modules/task/entities/task.entity.js");

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass += 1; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail += 1; };
const step = (m) => console.log(`\n=== ${m} ===`);

// 真实配置（容器 env 已满足 production fail-fast）
const cfg = require("/app/dist/config/configuration.js").default();
/** 最小 ConfigService 形态：点路径取值，喂给真实实现用。 */
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

/** 批大小（与生产常量同源，避免脚本里写死漂移） */
const METRICS_BATCH = require("/app/dist/modules/executor/executor-maintenance.collaborator.js")
  .METRICS_RETENTION_BATCH_SIZE;
const EXEC_BATCH = ExecutorService.EXECUTION_RETENTION_BATCH_SIZE ?? 5000;

async function main() {
  const ds = await AppDataSource.initialize();
  console.log(`[harness] connected: ${ds.options.database}@${ds.options.host}:${ds.options.port}`);

  const metricsRepo = ds.getRepository(ExecutorMetricsHistory);
  const execRepo = ds.getRepository(TaskExecution);
  const taskRepo = ds.getRepository(Task);
  const execorRepo = ds.getRepository(Executor);

  // ═══ 跑前清理（幂等的前提）══════════════════════════════════════════
  //
  // 本脚本造的行：
  //   · tasks(name like 'smoke-retention-%')  ← seed task
  //   · task_executions(taskId = 上面那个 task) ← A/B/C/F/G 各段造的执行行
  //   · executor_metrics_history(executorAddress like 'smoke-retention-%'
  //     或 'smoke-bulk-%' 或 'smoke-boundary')  ← metrics 行
  //
  // ⚠️ **为什么必须"跑前"而不是"跑后"**：
  //   上一轮实测跑到一半失败 ⇒ 残留行留在 DB 里。二次跑时：
  //   · seed task 的名字带 `Date.now()`（不会撞唯一索引）⇒ 但**上一轮残留的
  //     metrics 行还在** ⇒ 本轮的"批量删除 5001 行"断言会**多算**残留行
  //     ⇒ **假红**（更糟：若断言写的是 `>=`，就变成**假绿**）；
  //   · 残留的过期 metrics 行会让"新鲜行存活"断言的对照组被污染。
  //   ⇒ 跑**开始时**按前缀清干净并**验证计数 = 0** ⇒ 上次失败能被下次自动修复。
  //
  // ⚠️ **清理范围严格限定在自己的前缀内** —— 绝不 `DELETE FROM tasks`。
  //   每一句都带 WHERE + 自己的前缀。
  step("0. 跑前清理（只删本脚本自己造的 smoke-* 数据，并验证计数 = 0）");
  const PRE = {
    taskNamePat: "smoke-retention-%",
    metricsAddrPats: ["smoke-retention-%", "smoke-bulk-%", "smoke-boundary%"],
  };
  // ① 子表（先按本前缀任务的 id 反查 → 与主表严格同源）
  await ds.query(
    `DELETE FROM execution_log_lines WHERE "executionId" IN (
       SELECT id::text FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1))`,
    [PRE.taskNamePat],
  );
  await ds.query(
    `DELETE FROM task_executions WHERE "taskId" IN (
       SELECT id FROM tasks WHERE name LIKE $1)`,
    [PRE.taskNamePat],
  );
  // ⚠️ audit_logs 是**追加只读**表（迁移 1790000000006 的 trg_audit_logs_append_only
  //    触发器：DELETE/UPDATE 一律 RAISE EXCEPTION）⇒ 必须走会话 GUC 逃生门
  //    `app.bypass_audit_guard = 'on'`（生产审计服务的 retention 路径同款，
  //    见 apps/admin-api/src/modules/audit/audit.service.ts 的 AUDIT_GUARD_BYPASS_SQL）。
  //    ⇒ SET LOCAL 只在**事务内**有效 ⇒ 必须 BEGIN…COMMIT 包起来
  //    （事务结束自动失效 ⇒ 不留后门）。
  await ds.query(`BEGIN`);
  await ds.query(`SET LOCAL app.bypass_audit_guard = 'on'`);
  await ds.query(
    `DELETE FROM audit_logs WHERE "resourceId" IN (
       SELECT id::text FROM tasks WHERE name LIKE $1) AND action LIKE 'task.%'`,
    [PRE.taskNamePat],
  );
  await ds.query(`COMMIT`);
  await ds.query(`DELETE FROM tasks WHERE name LIKE $1`, [PRE.taskNamePat]);
  // ② metrics 行（没有 task 外链可挂靠 ⇒ 按 executorAddress 前缀删）
  for (const p of PRE.metricsAddrPats) {
    await ds.query(`DELETE FROM executor_metrics_history WHERE "executorAddress" LIKE $1`, [p]);
  }
  // ③ **验证清理生效**：本前缀的残留计数必须全 = 0
  const residue = {
    tasks: Number((await ds.query(`SELECT count(*)::int AS n FROM tasks WHERE name LIKE $1`, [PRE.taskNamePat]))[0].n),
    execs: Number((await ds.query(
      `SELECT count(*)::int AS n FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1)`, [PRE.taskNamePat]))[0].n),
    metrics: Number((await ds.query(
      `SELECT count(*)::int AS n FROM executor_metrics_history WHERE "executorAddress" LIKE ANY($1)`,
      [PRE.metricsAddrPats]))[0].n),
  };
  console.log(`[harness] 跑前清理后残留：${JSON.stringify(residue)}`);
  Object.values(residue).every((n) => n === 0)
    ? ok("跑前清理生效：本前缀残留 = 0（tasks / task_executions / metrics_history 全为 0）")
    : bad(`跑前清理未生效：残留 ${JSON.stringify(residue)} ⇒ 中止（不带着脏数据继续跑）`);
  if (!Object.values(residue).every((n) => n === 0)) {
    await ds.destroy();
    process.exit(1);
  }

  // ── 构造真实的 ExecutorService（走 Facade 的 public 路径）─────────────
  // 21 个位置参数；绝大多数用最小占位（既有 spec 的 `{} as never` 同款），
  // 关键的是 execRepo / metricsHistoryRepo / configService / dataSource 为真。
  const service = new ExecutorService(
    execorRepo,
    execRepo,
    taskRepo,
    metricsRepo,
    { add: async () => ({}) },          // taskQueue（cleanup 路径不用）
    configService,
    {},                                  // notificationService
    { findOne: async () => { throw new Error("no system config"); } },
    {},                                  // secretsCrypto
    null, null, null, null,              // eventBus/tracing/audit/leaderGate
    null, null, null, null, null, null, null,
    ds,
  );

  // ── seed 前置：一个 task（task_executions.taskId 有 FK）───────────────
  const task = await taskRepo.save(
    taskRepo.create({
      name: `smoke-retention-${Date.now()}`,
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

  const count = (repo) => repo.count();
  const before = {
    metrics: await count(metricsRepo),
    execs: await count(execRepo),
    tasks: await count(taskRepo),
    executors: await count(execorRepo),
  };
  console.log(`[harness] before: ${JSON.stringify(before)}`);

  // ═══ A/B. 过期行 vs 新鲜行 ═══════════════════════════════════════════
  step("A/B. 过期行被删、新鲜行存活（单行语义）");

  // metrics_history：过期 = createdAt < now - logRetention.days(30)
  const metricsDays = cfg.logRetention?.days ?? 30;
  const execDays = cfg.taskExecutionRetention?.days ?? 90;
  console.log(`[harness] retention: logRetention.days=${metricsDays} taskExecutionRetention.days=${execDays}`);

  const mOld = await metricsRepo.save(
    metricsRepo.create({
      executorAddress: "smoke-retention-addr",
      createdAt: new Date(Date.now() - (metricsDays + 10) * 86400000),
    }),
  );
  const mNew = await metricsRepo.save(
    metricsRepo.create({
      executorAddress: "smoke-retention-addr",
      createdAt: new Date(),
    }),
  );
  const eOld = await execRepo.save(
    execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: "success",
      startTime: new Date(Date.now() - (execDays + 10) * 86400000),
      createdAt: new Date(Date.now() - (execDays + 10) * 86400000),
      triggerType: "manual",
    }),
  );
  const eNew = await execRepo.save(
    execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: "success",
      startTime: new Date(),
      createdAt: new Date(),
      triggerType: "manual",
    }),
  );
  console.log(`[harness] seeded metrics old=${mOld.id} new=${mNew.id}; exec old=${eOld.id} new=${eNew.id}`);

  // 走 **Facade 的 public 转发层**（不是协作者直调——既有 spy 装在 Facade 上）
  const deletedMetrics = await service.cleanupExpiredMetricsHistory();
  const deletedExecs = await service.cleanupOldTaskExecutions(
    new Date(Date.now() - execDays * 86400000),
  );
  console.log(`[harness] deleted: metrics=${deletedMetrics} execs=${deletedExecs}`);

  const mOldAlive = await metricsRepo.findOneBy({ id: mOld.id });
  const mNewAlive = await metricsRepo.findOneBy({ id: mNew.id });
  const eOldAlive = await execRepo.findOneBy({ id: eOld.id });
  const eNewAlive = await execRepo.findOneBy({ id: eNew.id });

  mOldAlive === null
    ? ok(`过期 metrics_history 行已删（createdAt = now - ${metricsDays + 10} 天）`)
    : bad(`过期 metrics_history 行**仍在**（id=${mOld.id}）`);
  mNewAlive !== null
    ? ok("新鲜 metrics_history 行存活")
    : bad("新鲜 metrics_history 行被误删！");
  eOldAlive === null
    ? ok(`过期 task_executions 行已删（createdAt = now - ${execDays + 10} 天）`)
    : bad(`过期 task_executions 行**仍在**（id=${eOld.id}）`);
  eNewAlive !== null
    ? ok("新鲜 task_executions 行存活")
    : bad("新鲜 task_executions 行被误删！");

  deletedMetrics >= 1
    ? ok(`cleanupExpiredMetricsHistory 返回 ${deletedMetrics}（>=1）`)
    : bad(`cleanupExpiredMetricsHistory 返回 ${deletedMetrics}（应 >=1）`);
  deletedExecs >= 1
    ? ok(`cleanupOldTaskExecutions 返回 ${deletedExecs}（>=1）`)
    : bad(`cleanupOldTaskExecutions 返回 ${deletedExecs}（应 >=1）`);

  // ═══ D. 幂等 ════════════════════════════════════════════════════════════
  step("D. 幂等：再跑一次 ⇒ affected == 0");
  const againMetrics = await service.cleanupExpiredMetricsHistory();
  const againExecs = await service.cleanupOldTaskExecutions(
    new Date(Date.now() - execDays * 86400000),
  );
  againMetrics === 0
    ? ok("metrics 二次清理返回 0（幂等）")
    : bad(`metrics 二次清理返回 ${againMetrics}（应 0）`);
  againExecs === 0
    ? ok("executions 二次清理返回 0（幂等）")
    : bad(`executions 二次清理返回 ${againExecs}（应 0）`);

  // ═══ E. 活跃数据不受影响 ══════════════════════════════════════════════
  step("E. 活跃数据不受影响");
  const after = {
    metrics: await count(metricsRepo),
    execs: await count(execRepo),
    tasks: await count(taskRepo),
    executors: await count(execorRepo),
  };
  console.log(`[harness] after: ${JSON.stringify(after)}`);
  after.tasks === before.tasks
    ? ok(`tasks 行数不变（${before.tasks} → ${after.tasks}）`)
    : bad(`tasks 行数变了（${before.tasks} → ${after.tasks}）`);
  after.executors === before.executors
    ? ok(`executors 行数不变（${before.executors} → ${after.executors}）`)
    : bad(`executors 行数变了（${before.executors} → ${after.executors}）`);

  // ═══ C. 分批正确：5001 行过期 ⇒ 跨两批全删 ════════════════════════════
  step(`C. 分批删除：造 ${METRICS_BATCH + 1} 行过期 metrics ⇒ 应跨两批全删`);
  const bulk = [];
  for (let i = 0; i < METRICS_BATCH + 1; i += 1) {
    bulk.push(
      metricsRepo.create({
        executorAddress: `smoke-bulk-${i}`,
        createdAt: new Date(Date.now() - (metricsDays + 30) * 86400000),
      }),
    );
  }
  await metricsRepo.save(bulk, { chunk: 500 });
  const bulkBefore = await count(metricsRepo);
  const bulkDeleted = await service.cleanupExpiredMetricsHistory();
  const bulkAfter = await count(metricsRepo);
  console.log(`[harness] bulk: before=${bulkBefore} deleted=${bulkDeleted} after=${bulkAfter}`);
  bulkDeleted === METRICS_BATCH + 1
    ? ok(`跨两批删干净了 ${bulkDeleted} 行（= 批大小 ${METRICS_BATCH} + 1）`)
    : bad(`批量删除数不对：deleted=${bulkDeleted}（应 ${METRICS_BATCH + 1}）`);
  bulkBefore - bulkAfter === bulkDeleted
    ? ok("删除数与 count 差一致（没有漏删/多删）")
    : bad(`count 差 ${bulkBefore - bulkAfter} 与 deleted ${bulkDeleted} 不一致`);

  // ═══ G. 走完整 @Cron 入口 cleanupOldRecords（保留期由配置推导）══════════
  step("G. 完整 @Cron 入口 cleanupOldRecords（保留期来自 taskExecutionRetention.days）");
  // 让保留期可测：往 system_configs 不写（该键与本路径无关），而是直接
  // 验证 @Cron 入口在**默认保留期**下不误删新鲜行、且能删掉远超期的行。
  const eVeryOld = await execRepo.save(
    execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: "success",
      startTime: new Date(Date.now() - (execDays + 100) * 86400000),
      createdAt: new Date(Date.now() - (execDays + 100) * 86400000),
      triggerType: "manual",
    }),
  );
  const execsBeforeCron = await count(execRepo);
  // leaderGate = null（装配时传的 null）⇒ 门禁通过，等价于 Leader 实例
  await service.cleanupOldRecords();
  const execsAfterCron = await count(execRepo);
  const eVeryOldAlive = await execRepo.findOneBy({ id: eVeryOld.id });
  const eNewAfterCron = await execRepo.findOneBy({ id: eNew.id });
  console.log(`[harness] cron entry: before=${execsBeforeCron} after=${execsAfterCron}`);
  eVeryOldAlive === null
    ? ok(`@Cron 入口删掉了远超保留期的执行行（now - ${execDays + 100} 天）`)
    : bad(`@Cron 入口没删远超保留期的执行行（id=${eVeryOld.id}）`);
  eNewAfterCron !== null
    ? ok("@Cron 入口没有误删保留期内的新鲜执行行")
    : bad("@Cron 入口误删了保留期内的新鲜执行行！");

  // ═══ F. 保留期边界：cutoff 之前的行必须活 ═════════════════════════════
  step("F. 边界：cutoff 之前的行必须存活（不越界删）");
  const mBoundary = await metricsRepo.save(
    metricsRepo.create({
      executorAddress: "smoke-boundary",
      createdAt: new Date(Date.now() - (metricsDays - 1) * 86400000),
    }),
  );
  await service.cleanupExpiredMetricsHistory();
  const mBoundaryAlive = await metricsRepo.findOneBy({ id: mBoundary.id });
  mBoundaryAlive !== null
    ? ok(`保留期内（${metricsDays - 1} 天）的 metrics 行存活（cutoff 未越界）`)
    : bad("保留期内的 metrics 行被误删（cutoff 判定过宽）");

  // ── 清理 seed ─────────────────────────────────────────────────────────
  await metricsRepo.delete({ executorAddress: "smoke-retention-addr" });
  await metricsRepo.createQueryBuilder().delete()
    .where("\"executorAddress\" like :p", { p: "smoke-bulk-%" }).execute();
  await metricsRepo.delete({ executorAddress: "smoke-boundary" });
  await execRepo.delete({ taskId: task.id });
  await taskRepo.delete({ id: task.id });

  await ds.destroy();
  console.log(`\n=== 场景 4（X5 retention 真删除）小结：PASS=${pass} FAIL=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[harness] FAILED:", err);
  process.exit(1);
});
