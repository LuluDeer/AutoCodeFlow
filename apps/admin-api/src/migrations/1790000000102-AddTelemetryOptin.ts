import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R305 / TTFV opt-in 授权闸门：`telemetry_optin` —— 默认不采集的授权事实表。
 *
 * ## 为什么 install_id 唯一
 *
 * 授权判定的主体是安装实例，不是用户，也不是事件。同一个 install 多次
 * grant/revoke 改写的是「当前是否同意」这一份状态；若允许多行，查询侧就要在
 * 「按 opted_at 取最新」与「任意一行为 true 即放行」之间做选择，两者都会在并发
 * 写入下产生歧义（前者依赖时间戳精度，后者让一次撤销被旧授权行翻案）。唯一索引
 * 把「一个 install 一条当前状态」下沉到 DB，upsert 在多副本/重试下收敛到一行。
 *
 * ## 为什么 opt_in 用布尔列，而不是删除行表示撤销
 *
 * 删除行会让「从未授权」与「授权后撤销」在表上不可区分；而这两者在产品语义上
 * 不同：撤销必须先有过明确同意，重新授权前也不能出现「旧行删了、新行还没写」的
 * 模糊态。保留 `opt_in=false` 的行 + `opted_at` 时点，撤销就是一条可审计的事实，
 * 判定逻辑也只剩一个判据：`opt_in === true`。
 *
 * ## 为什么没有 updatedAt（why 见实体头注）
 *
 * `opted_at` 已经是状态变更时点，`updatedAt` 是同一事实的第二份真相。
 *
 * ## 索引
 *
 * - `uq_telemetry_optin_install_id`：幂等硬闸 + 判定点查的 covering 条件。
 *
 * 新表无存量行，`IF NOT EXISTS` 让重放无副作用；`down()` 逆序 DROP 索引与表。
 */
export class AddTelemetryOptin1790000000102 implements MigrationInterface {
  name = "AddTelemetryOptin1790000000102";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telemetry_optin" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "install_id" character varying(128) NOT NULL,
        "user_id_hash" character varying(128) NULL,
        "opt_in" boolean NOT NULL,
        "opted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "source" character varying(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telemetry_optin" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_telemetry_optin_install_id"
        ON "telemetry_optin" ("install_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_telemetry_optin_install_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "telemetry_optin"`);
  }
}
