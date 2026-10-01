import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A4（第三轮审计·低）：task_executions 补 (taskId, "createdAt" DESC, "id" DESC)
 * 复合索引——执行历史分页/详情列表的确定性排序。
 *
 * 背景：
 * - 既有 idx_task_executions_task_id_created_at（1717473142683 建，("taskId",
 *   "createdAt" DESC)）只能免排序到 createdAt 列——同一毫秒创建的执行行
 *   （批量触发/回滚/广播扇出是常态）createdAt 打平，计划器仍要额外排序
 *   （或返回顺序不稳定）；
 * - 消费面（task.service.findAll 执行历史、detail 分页、terminal 对账）的
 *   稳定排序键是 (taskId, createdAt DESC, id DESC)——id 作 tiebreaker 既
 *   保证确定性（UUID 无时序，但同毫秒内仍需一个稳定第二键），也让 keyset
 *   分页可用。此前靠 TypeORM 隐式 order + PG 运行时排序，索引无法覆盖。
 *
 * 旧索引处置：**保留并存**（保守选项）。("taskId","createdAt") 是新索引的
 * 严格左前缀，建好后旧索引纯冗余（只付写入维护成本），后续可单独出迁移
 * DROP；本迁移不顺手删——CONCURRENTLY 建索引失败（无效索引由 PG 自动清理、
 * 可重跑）与 DROP 是两类操作，耦合在同一条迁移里会让"建索引失败 + 旧索引
 * 已删"叠加出回归窗口。
 *
 * 并发建索引：task_executions 是最高频写入大表，走 CREATE INDEX CONCURRENTLY
 * ——PG 硬约束 "CONCURRENTLY 不能在事务块内执行"，故声明 transaction = false
 * （TypeORM MigrationExecutor 读迁移实例属性，false 时不包外层事务），口径
 * 同 1790000000022。每条语句自身原子，IF NOT EXISTS 保证重跑可重入。
 * down 为人工 revert 路径（维护窗口执行），保持普通 DROP。
 */
export class AddExecutionTaskCreatedAtIndex1790000000049 implements MigrationInterface {
  name = "AddExecutionTaskCreatedAtIndex1790000000049";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_task_executions_task_id_created_at_id"
      ON "task_executions" ("taskId", "createdAt" DESC, "id" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_executions_task_id_created_at_id"
    `);
  }
}
