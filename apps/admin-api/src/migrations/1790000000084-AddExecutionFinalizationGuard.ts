import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * S3-C5（S3 §6.C5，P0 · 后果档=数据丢失）：**持久化收尾协调记录**。
 *
 * ## 为什么需要
 *
 * `recoverStaleExecutions` 是「扫描 + 批量置态」：把看起来卡住的 RUNNING 执行判死
 * 并落终态，再兑现重试预算（`scheduleRetryAfterRecovery` 创建新 PENDING 执行并
 * re-enqueue）。它此前**没有**「先证明没有更新的执行存在」这道护栏（对齐被调研
 * 项目 paperclip 的 `native_run_finalizations.ts:23-60` +
 * `preserved-result-finalization.ts:5-25` 五重护栏）。若那条执行其实已被重试/新
 * 触发产生了更新的 run（`createdAt >= 本行`），这次收尾会用旧快照（旧参数/旧包）
 * 重跑一遍同一批副作用，把新 run 的成果覆盖掉。
 *
 * 本表是「记录」那一半：每次收尾留一条持久化证据
 * （`attempt / leaseOwner / leaseExpiresAt / controllerBootId / recoveryHistory`）；
 * 「门禁」那一半写在 `scheduler.service.ts` 收尾用的条件 UPDATE 的 WHERE 里
 * （判据必须在 DB 层原子求值，不能靠进程内状态——admin-api 是多副本）。
 *
 * ## 为什么是独立表（方案 b）而不是 task_executions 上的 5 个列（方案 a）
 *
 * ① **读面契约不允许**（决定性理由）：本仓有一条机械不变量「实体列 ⊆ 执行读 DTO
 *    声明」（`modules/task/__tests__/execution-executor-id.dto.spec.ts`，防「加了列
 *    没加读面」复发）。把 5 列加到 `TaskExecution` 实体上，就会被迫把
 *    `leaseOwner/controllerBootId/recoveryHistory` 这些**内部收尾协调细节**发布到
 *    公开的执行响应契约里（还要重生成 `openapi.json` 与
 *    `apps/admin-web/src/types/generated/api-types.ts` 两个入库生成物）。独立表让
 *    读面一个字段都不动。
 * ② **生命周期与竞争面独立**（与审批单选独立表同源，见
 *    `agent-approval.entity.ts` 头注）：本表只有 stale sweep 一个写者，写形态是
 *    「按 executionId upsert + jsonb 追加」，与 `task_executions` 的终态竞争面
 *    （回调/人工 kill/processor claim）完全不重叠。
 * ③ **形态对齐 paperclip**：`native_run_finalizations` 就是「一行一个 run（runId
 *    主键）+ attempt + recoveryHistory」，我们同样以 `executionId` 为主键一执行一行。
 * ④ **不引入「有协调行但没终态」的持久窗**：协调行的写入与终态写入**在同一个
 *    事务内**（见 scheduler 的收尾事务），提交前对任何其他连接都不可见；事务回滚
 *    则两者一起消失。`recoveryHistory` 的 `kind` 进一步区分「收尾完成」与
 *    「拒绝收尾（deferred，行仍是 RUNNING）」——后者刻意不写租约，因此永远不会被
 *    误读成「有一次收尾正在进行」。
 *
 * ## metadata-only
 *
 * `CREATE TABLE`（新表，无数据）+ 两个索引，均不触碰既有表；`recoveryHistory`
 * 的 `DEFAULT '[]'::jsonb` 只对新行生效，**不回填任何存量行**（本表没有存量行）。
 * down 对称 `DROP TABLE`（索引随表级联消失）。
 */
export class AddExecutionFinalizationGuard1790000000084 implements MigrationInterface {
  name = "AddExecutionFinalizationGuard1790000000084";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "execution_finalizations" (
        "executionId" uuid NOT NULL,
        "taskId" uuid NOT NULL,
        "attempt" integer NOT NULL DEFAULT 0,
        "leaseOwner" varchar(255) NULL,
        "leaseExpiresAt" timestamptz NULL,
        "controllerBootId" varchar(64) NULL,
        "recoveryHistory" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_execution_finalizations" PRIMARY KEY ("executionId"),
        CONSTRAINT "fk_execution_finalizations_execution"
          FOREIGN KEY ("executionId") REFERENCES "task_executions"("id")
          ON DELETE CASCADE
      )
    `);
    // 运维/排障面：按任务列出「哪些执行有收尾协调记录」（executionId 主键服务
    // 门禁与 upsert 的等值查找）。
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_execution_finalizations_task_id" ON "execution_finalizations" ("taskId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "execution_finalizations"`);
  }
}
