import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * WIKI-OPT-2（配置历史强化）：config_history 补 valueType / isSecret 两列
 * 元数据（均 nullable varchar/boolean）。
 *
 * 背景（repo-wiki page-19 评审结论）：
 * - 历史行此前只存 value/description——配置被删除后回滚无法恢复类型与
 *   敏感标记（只能落默认值 "string"/false），存在语义缺口；
 * - 历史保密：读面掩码此前只按「当前配置行是否 secret」推断，配置被删除
 *   或取消 secret 标记后，历史读面可能暴露曾经的机密旧值。历史行持久化
 *   isSecret 后，读面可按行级标记掩码。
 *
 * NULL 语义：存量行两列为 NULL = 元数据不可知（迁移前只记录 value/
 * description）——读面与回滚对 NULL 行沿用旧推断（按当前配置行 isSecret /
 * 默认值），零破坏升级。
 *
 * 幂等：IF [NOT] EXISTS 写法，重复执行与 revert 重放均无副作用。
 */
export class AddConfigHistoryMetadata1790000000016 implements MigrationInterface {
  name = "AddConfigHistoryMetadata1790000000016";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config_history"
      ADD COLUMN IF NOT EXISTS "valueType" VARCHAR NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "config_history"
      ADD COLUMN IF NOT EXISTS "isSecret" BOOLEAN NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "config_history" DROP COLUMN IF EXISTS "isSecret"
    `);
    await queryRunner.query(`
      ALTER TABLE "config_history" DROP COLUMN IF EXISTS "valueType"
    `);
  }
}
