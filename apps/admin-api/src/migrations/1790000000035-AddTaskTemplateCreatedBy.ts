import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * E-P2-S1：task_templates 增 `createdBy` varchar(100) 可空列。
 *
 * 背景：删除自定义模板此前无归属校验（BOLA）。产品已拍板「属主/管理员模型」：
 *  - 创建模板时记录当前 JWT username；
 *  - 删除端点改为「属主或 ADMIN」；
 *  - 历史行 createdBy=NULL 安全回退：仅 ADMIN 可删。
 *
 * 幂等：ADD/DROP COLUMN IF [NOT] EXISTS——重放与 revert 均无副作用。
 */
export class AddTaskTemplateCreatedBy1790000000035
  implements MigrationInterface
{
  name = "AddTaskTemplateCreatedBy1790000000035";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_templates"
      ADD COLUMN IF NOT EXISTS "createdBy" varchar(100)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_templates" DROP COLUMN IF EXISTS "createdBy"
    `);
  }
}
