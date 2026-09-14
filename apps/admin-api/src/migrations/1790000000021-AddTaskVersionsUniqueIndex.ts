import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PK-11（DEEP_REVIEW 0ef3bbe packages 批）：task_versions 缺
 * (taskId, version) 唯一约束。
 *
 * 背景：TaskService.saveVersion 用 MAX(version)+1 计数（COUNT 改 MAX 是
 * 早期修复），但该 SELECT 与 INSERT 之间没有事务/锁串行化，并发的
 * create/update 链路（同一任务同时两次编辑保存）可以各算出同一个
 * v<N> 各插一行——application_versions 有唯一约束而 task_versions 没有，
 * 属同类守卫缺口。版本回滚按 (taskId, version) 定位快照，重复行会让
 * "v3 到底是哪个快照"变成不确定行为。
 *
 * 存量脏数据处理（去重先例：AddAppDeploymentsInFlightUniqueIndex1789000000000）：
 * 若库中已因该竞态积累了同一 (taskId, version) 的多行，直接建唯一索引会
 * 失败并中断迁移。先做一次确定性去重：每个 (taskId, version) 按
 * (createdAt, id) 保留最早一条（"先到的快照"获胜，与 saveVersion 的
 * MAX+1 语义一致——重复版本号本就是竞态缺陷产物），其余行 DELETE。
 * (createdAt, id) 排序保证结果确定。
 *
 * 顺带回收旧的非唯一索引 idx_task_versions_taskId_version
 * （1789000000001 建）：唯一索引覆盖同一列前缀，留着只会加倍写入放大。
 *
 * 幂等：DELETE rn>1 天然幂等；CREATE/DROP INDEX IF [NOT] EXISTS，重复
 * 执行与 revert 重放均无副作用。down 不尝试恢复被删除的重复行（无法
 * 从索引回滚中复原数据），仅恢复非唯一索引形态。
 */
export class AddTaskVersionsUniqueIndex1790000000021 implements MigrationInterface {
  name = "AddTaskVersionsUniqueIndex1790000000021";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量去重：同一 (taskId, version) 仅保留最早一条。
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "taskId", "version"
                 ORDER BY "createdAt" ASC, id ASC
               ) AS rn
        FROM "task_versions"
      )
      DELETE FROM "task_versions" v
      USING ranked r
      WHERE r.id = v.id AND r.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_task_versions_taskId_version"
      ON "task_versions" ("taskId", "version")
    `);

    // 旧非唯一索引被唯一索引完全覆盖，回收之（幂等）。
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_versions_taskId_version"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ux_task_versions_taskId_version"
    `);

    // 恢复迁移前形态（非唯一索引）；被去重删除的行不可复原。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_versions_taskId_version"
      ON "task_versions" ("taskId", "version")
    `);
  }
}
