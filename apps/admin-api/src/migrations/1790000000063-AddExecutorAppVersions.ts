import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R3-A（部署模型评审 2026-10-23 §4.3 / §九 9.3-1）：设备级应用版本事实表
 * `executor_app_versions` + executors 增 `installedPackages` jsonb 列。
 *
 * ## 为什么需要
 *
 * 此前中台没有任何「设备上真正跑哪版」的事实源——getReleases 的版本行只能
 * 从最近一次部署行**推断**生效状态（§P4「历史版本也显示生效」），派发面的
 * 版本跟随（resolveVersionFollowPackage）也只能按部署行推断（§P5）。本表
 * 承接执行器心跳上报的设备级事实（currentVersion / retainedVersions /
 * currentReleaseKey / runMode / lastDeployedAt），中台从此**持有事实**。
 *
 * ## 行语义
 *
 * 一行 = (executorId, applicationId) 的**最新一份设备事实**（唯一键，心跳
 * 整替语义见 ExecutorService.applyReportedAppVersions：数组里没有的应用行
 * 删除 = 设备已卸载；deployedApps 键缺失 = 旧执行器 → 完全不动）。不是
 * 历史流水（部署动作追溯走 app_deployment_events）。
 *
 * ## 外键级联
 *
 * - executorId → executors.id ON DELETE CASCADE：执行器行删除（运维清理/
 *   指纹重注册）时设备事实随之清掉——没有设备就没有版本事实，留着的只是
 *   会被读面误读的孤儿行（先例 app_deployment_events.applicationId）。
 * - applicationId → applications.id ON DELETE CASCADE：应用删除时 NETOPT-8③
 *   已扇出设备卸载，事实行随应用一起消失。
 *
 * ## installedPackages 列
 *
 * executors 增可空 jsonb（与 interpreters 列同形态）：**必须可空、不给
 * DEFAULT** —— NULL = 未上报（旧执行器），[] = 已上报且无安装包，两态混淆
 * 会让 P10 的设备级包版本收敛读面把存量行误读成「什么都没装」。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，重复执行与
 * revert 重放均无副作用。无存量回填——存量设备的事实从下一次新版执行器
 * 心跳开始积累（混合窗口期的读面/派发面回退语义见对应消费点注释）。
 */
export class AddExecutorAppVersions1790000000063 implements MigrationInterface {
  name = "AddExecutorAppVersions1790000000063";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "executor_app_versions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "executorId" UUID NOT NULL,
        "applicationId" UUID NOT NULL,
        "currentVersion" VARCHAR,
        "currentReleaseKey" VARCHAR,
        "retainedVersions" JSONB,
        "runMode" VARCHAR,
        "lastDeployedAt" TIMESTAMPTZ,
        "lastReportedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- 2026-10-25 补：实体的 @CreateDate/@UpdateDateColumn（91-93 行）从
        -- 首版建表就缺席（缺口成因与本表 ALTER 收口见 1790000000066 迁移）。
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_executor_app_versions_executor_application"
          UNIQUE ("executorId", "applicationId"),
        CONSTRAINT "FK_executor_app_versions_executorId"
          FOREIGN KEY ("executorId") REFERENCES "executors"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_executor_app_versions_applicationId"
          FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);
    // 读面（getReleases devices 聚合）按 applicationId 取全部设备行。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executor_app_versions_application"
      ON "executor_app_versions" ("applicationId")
    `);
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "installedPackages" JSONB NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "installedPackages"`,
    );
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_executor_app_versions_application"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "executor_app_versions"
    `);
  }
}
