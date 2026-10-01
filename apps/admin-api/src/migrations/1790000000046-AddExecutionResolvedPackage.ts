import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-22 方案 A v1 配套观测：task_executions 记录派发时刻解析的应用包。
 *
 * 背景（生产反馈 2026-09-30）：任务执行永远跑应用「当前上传版本」——派发那
 * 一刻解析 applications.packageUrl（30s 正缓存）附加到下发载荷，执行器每次
 * 现下载解压到 per-execution 目录。执行行此前不记录「本次到底用的哪个包/
 * 哪个版本」，应用连续上传多版后历史执行的版本不可回溯（「这台设备上次跑
 * 的是 v1 还是 v2」只能靠猜）——这也是方案 B（版本跟随部署）的核实成本来源。
 *
 * 两列均 NULL：git/glue 渠道任务没有包概念（代码随派发载荷下发/执行器自行
 * clone），恒 NULL；zip 渠道在 dispatch 解析成功后写入，解析失败走既有失败
 * 路径（failureReason=APPLICATION_MISSING 等）。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionResolvedPackage1790000000046 implements MigrationInterface {
  name = "AddExecutionResolvedPackage1790000000046";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "resolvedPackageUrl" VARCHAR NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "resolvedPackageVersion" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "resolvedPackageVersion"
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "resolvedPackageUrl"
    `);
  }
}
