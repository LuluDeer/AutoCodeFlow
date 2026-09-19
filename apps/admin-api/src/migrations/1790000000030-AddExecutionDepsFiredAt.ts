import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NETOPT-3②（第二轮深潜）：task_executions.depsFiredAt——依赖扇出完成标记。
 *
 * 背景（扇出静默丢失的三条路径）：
 * 1. handleCallback 扇出整体吞错：triggerDependentTasks 的 trigger() 抛错
 *    （入队失败）只记日志，回调仍回 success=true，执行器整批重试时该执行行
 *    已终态 → affected=0 → 依赖触发永久丢失；
 * 2. claimDependencyTrigger 先推进下游 lastTriggerTime 再 trigger()——
 *    trigger 失败时 10s 去重窗口内的重放被吸收、窗口外无任何再跑机制；
 * 3. 终态提交后、扇出前进程崩溃 → 执行器整批重发落重复回调分支（affected=0）
 *    → 只补日志，不重放扇出。
 *
 * 语义：NULL = 该执行的 SUCCESS 终态虽已落定，但依赖扇出未确认完成（重复
 * 回调遇 NULL 必须重放扇出）；非 NULL = 扇出全部成功（或无可触发的下游），
 * 重复回调不再重放。这是**旁路标记列，不是终态**——不参与 A1 状态机
 * transitionToTerminal 的终态集合，也不允许任何写路径借它改写 status。
 *
 * 落值纪律：仅当扇出全部成功后由 TaskService 写入（条件 UPDATE
 * depsFiredAt IS NULL → now，天然幂等）；失败/部分失败不落，留 NULL 供
 * 重放与观测（depsFiredAt IS NULL 的 SUCCESS 行 + error 日志即可定位丢失窗）。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS，重复执行与
 * revert 重放均无副作用。timestamptz 对齐 event_outbox 既有时间列风格
 * （迁移 1790000000003）。
 */
export class AddExecutionDepsFiredAt1790000000030 implements MigrationInterface {
  name = "AddExecutionDepsFiredAt1790000000030";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "depsFiredAt" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      DROP COLUMN IF EXISTS "depsFiredAt"
    `);
  }
}
