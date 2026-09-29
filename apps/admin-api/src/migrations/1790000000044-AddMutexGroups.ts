import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * MUTEX-01（应用互斥组）：同设备 × 同组的应用执行串行化。
 *
 * ── 需求 ─────────────────────────────────────────────────────────────────
 * 部署的自动化应用里，有一类对同一外部资源（如紫鸟浏览器）做自动化操作——
 * 它们**互相之间**不能在同一台设备上并发（会抢浏览器实例），但与其它无冲突
 * 应用（接口类）可以照常并发，设备自身的 maxConcurrentTasks 槽位照常生效。
 * 语义钉死为：**同一台设备上，同一互斥组的执行同时最多 N 个（N = 组内并发数，
 * 默认 1）；跨组互不影响；跨设备互不影响。**
 *
 * ── 形态 ─────────────────────────────────────────────────────────────────
 * 1. `mutex_groups` 配置实体：组名（唯一）+ 设备内并发数（默认 1）。
 *    应用通过 `applications.mutexGroupId` 挂组（可空 = 不参与互斥，行为与
 *    引入前逐字节一致）。挂应用而非挂任务：用户心智模型是「紫鸟类应用」，
 *    一个应用通常多个任务，逐任务配会配出遗漏（用户拍板）。
 * 2. `task_executions.mutexGroupId` **冗余快照列**（无 FK）：执行行创建时从
 *    task→application 带下。互斥占用判定是热路径上的单表查询（不 join），
 *    且执行的生命周期（排队/重试/回收）与组配置解耦——组被删后，在途执行
 *    仍按创建时的组语义走完，历史执行不因组删除而失真（故不 FK SET NULL）。
 * 3. `execution_status_enum` 补 `waiting` 值：互斥阻塞的执行进入显式排队态。
 *    为什么必须是专门状态而不是停在 PENDING：stale sweep 的 PENDING 桶会把
 *    超过 10 分钟未派发的 PENDING 行清扫成 FAILED（never_dispatched）——
 *    排队 10 分钟就被误杀；且 UI 需要区分「队列待跑」与「互斥排队等分配」。
 *
 * ── 占用账本为什么从执行行推导而不加计数器 ───────────────────────────────
 * executors 已有 runningTaskCount 计数账本（泄露靠 register/restart 自愈）。
 * 互斥占用若再加一份 jsonb 计数器，等于引入第二个会泄露的账本，而其自愈面
 * （执行器不认识组、无法心跳上报）比 runningTaskCount 更弱；且幽灵占用会让
 * 同组执行在该设备上**无限期排队**。改为从执行行推导占用
 * （status='running' AND executorAddress=:addr AND mutexGroupId=:g）：
 * 终态跃迁（A1 统一终态门）自动释放占用，无计数器可泄露；竞态由 dispatch
 * 占坑事务内的 executors 行锁串行化关闭（同设备派发互相排队，占用读到的
 * 永远是已提交状态）。部分索引只为占用判定服务。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ADD VALUE
 * IF NOT EXISTS（对齐 1790000000020 的 enum 补值先例——PG 不支持从 enum
 * 删值，down 只回滚表/列，值域保持超集，与仓内不可逆迁移惯例一致）。
 */
export class AddMutexGroups1790000000044 implements MigrationInterface {
  name = "AddMutexGroups1790000000044";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mutex_groups" (
        "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"                  VARCHAR NOT NULL UNIQUE,
        "maxConcurrentPerDevice" INTEGER NOT NULL DEFAULT 1,
        "description"           VARCHAR NULL,
        "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "ck_mutex_groups_max_concurrent_positive"
          CHECK ("maxConcurrentPerDevice" >= 1)
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "mutexGroupId" UUID NULL`,
    );
    // 挂组引用：组删除后应用回到「不参与互斥」（SET NULL，与 projectId 同款）。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_applications_mutex_group'
        ) THEN
          ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_mutex_group"
            FOREIGN KEY ("mutexGroupId") REFERENCES "mutex_groups"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_applications_mutex_group" ON "applications" ("mutexGroupId")`,
    );

    // 执行行的组快照：无 FK（见类头注——组删除不得改写在途/历史执行）。
    await queryRunner.query(
      `ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "mutexGroupId" UUID NULL`,
    );
    // 占用判定索引：dispatch 占坑事务内的
    // `WHERE executorAddress=:addr AND mutexGroupId=:g AND status='running'`
    // 计数查询走它；部分索引只覆盖真正参与互斥的行（组为空的执行不进索引）。
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_task_executions_group_occupancy"
       ON "task_executions" ("executorAddress", "mutexGroupId")
       WHERE "status" = 'running' AND "mutexGroupId" IS NOT NULL`,
    );

    // 排队态（MUTEX-01）：互斥阻塞的执行显式进入 waiting，等待唤醒重派。
    // 不进 stale sweep 的 PENDING 桶 / RUNNING 桶（两桶按 status 精确过滤），
    // 排队多久都不会被误回收；人工 kill/取消经 A1 终态门照常可用。
    await queryRunner.query(
      `ALTER TYPE "execution_status_enum" ADD VALUE IF NOT EXISTS 'waiting'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PG 无法删除 enum 值；值域保持补齐后的超集即可，无需操作。
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_executions_group_occupancy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "mutexGroupId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_applications_mutex_group"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP CONSTRAINT IF EXISTS "fk_applications_mutex_group"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "mutexGroupId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "mutex_groups"`);
  }
}
