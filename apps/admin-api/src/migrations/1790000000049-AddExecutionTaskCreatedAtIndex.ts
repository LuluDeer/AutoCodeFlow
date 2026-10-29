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
 *
 * 回滚对称（第 4 轮 T3 守卫 check-migration-symmetry 抓到的「回滚锁表」）：
 * down 曾是普通 `DROP INDEX`——task_executions 是最高频写入大表，普通 DROP
 * 取 ACCESS EXCLUSIVE 锁，回滚期间整表写入排队，与「up 不锁写」自相矛盾。
 * 现改为 `DROP INDEX CONCURRENTLY IF EXISTS`（up 用 CONCURRENTLY 建，down
 * 就必须同样 CONCURRENTLY 拆）；DROP 同为单条语句、同样吃连接池 30s
 * statement_timeout，故 down 复用 up 的会话级 SET + finally RESET 豁免
 * （口径同 1790000000075）。
 */
export class AddExecutionTaskCreatedAtIndex1790000000049 implements MigrationInterface {
  name = "AddExecutionTaskCreatedAtIndex1790000000049";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 连接池对每条语句设 statement_timeout=30s；CONCURRENTLY 是**单条**
    // 语句，大表构建可能超过 30s。本迁移 transaction=false，SET LOCAL
    // 没有事务块会退化成警告 + 无效（对照 0037 的写法不可照抄）——因此
    // 用会话级 SET 并在 finally 复位（连接会归还池，污染会波及后续查询）。
    // 超时的后果不是"重跑即可"：PG 会留下 indisvalid=false 的同名索引，
    // IF NOT EXISTS 会命中它并跳过，索引永远建不起来。
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_task_executions_task_id_created_at_id"
      ON "task_executions" ("taskId", "createdAt" DESC, "id" DESC)
    `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 对称：普通 DROP INDEX 会锁表，必须 CONCURRENTLY；超时豁免同 up
    // （单条语句受 30s 限制，被取消则回滚半途中断、留下半删索引）。
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_task_id_created_at_id"
    `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
