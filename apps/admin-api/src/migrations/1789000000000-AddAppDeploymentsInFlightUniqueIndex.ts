import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R5: 关闭 deploy() 在途守卫的 TOCTOU 窗口。
 *
 * AppDeploymentService.deploy() 先 findOne(PENDING|DEPLOYING) 检查再 save，
 * 两个并发请求可能同时通过检查、各自插入一条在途部署，双开真实进程。
 * 应用层检查无法闭合该窗口，这里加数据库级守卫：applicationId 上的部分
 * 唯一索引，仅约束 status IN ('pending','deploying') 的行——同一应用任意
 * 时刻至多存在一条"部署中"的行；历史行与升级中的行（running/stopped/
 * failed/upgrading）不受影响。service 侧捕获 23505 转 409 Conflict
 * （文案对齐既有重复守卫提示）。
 *
 * 与升级路径的兼容性：upgrade()/pushDeployToExecutor(upgrade=true) 现将
 * 升级行保持为 'upgrading'（不在索引约束内），因此同一应用多实例的并发
 * 滚动升级（upgradeAll / webhook triggerDeploy）不会相互触发唯一冲突。
 *
 * 幂等：CREATE UNIQUE INDEX IF NOT EXISTS（up）/ DROP INDEX IF EXISTS
 * （down），重放无副作用。
 *
 * 存量脏数据处理：若库中已因该缺陷积累了同一应用的多条在途行，直接建
 * 唯一索引会失败并中断迁移。先做一次确定性去重：每个 applicationId 按
 * (createdAt, id) 保留最早一条在途行，其余置为 failed 并写入说明性
 * statusMessage（保守取舍——多开的进程本就是缺陷产物，标记 failed 交由
 * 运维确认，而不是让迁移在脏数据上不可推进）。
 */
export class AddAppDeploymentsInFlightUniqueIndex1789000000000 implements MigrationInterface {
  name = "AddAppDeploymentsInFlightUniqueIndex1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 存量去重：同一应用仅保留最早一条在途行（语义上"先到的部署"获胜；
    // (createdAt, id) 排序保证结果确定，同刻创建也不会留死锁空间）。
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "applicationId"
                 ORDER BY "createdAt" ASC, id ASC
               ) AS rn
        FROM "app_deployments"
        WHERE "status" IN ('pending', 'deploying')
      )
      UPDATE "app_deployments" d
      SET "status" = 'failed',
          "statusMessage" = COALESCE(d."statusMessage", '')
            || ' [System] Duplicate in-flight deployment collapsed by migration AddAppDeploymentsInFlightUniqueIndex1789000000000'
      FROM ranked r
      WHERE r.id = d.id AND r.rn > 1
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_app_deployments_application_in_flight"
      ON "app_deployments" ("applicationId")
      WHERE "status" IN ('pending', 'deploying')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_app_deployments_application_in_flight"
    `);
  }
}
