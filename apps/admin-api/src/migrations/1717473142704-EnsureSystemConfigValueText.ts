import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DB-007: system_configs.value 声明为无长度上限的 TEXT。
 *
 * entity 对应改动：system-config.entity.ts 中 value 保持
 *   @Column({ type: "text", nullable: true })
 *   并补充注释说明不允许改回 varchar（防长 JSON/提示词被静默截断）。
 *
 * 评估结论：value 需存 JSON（valueType='json'，config.service.ts 中做
 * JSON.parse 校验）、AI 提示词模板等长文本，长度不可预估，固定 varchar(N)
 * 均有截断风险，故显式声明 TEXT（语义与现状一致，无数据变更风险）。
 *
 * 本迁移为声明式收敛：初始建表时即 TEXT，正常库无需变更；仅当手工改过
 * 列类型（如 varchar）时才修复回 TEXT。
 */
export class EnsureSystemConfigValueText1717473142704
  implements MigrationInterface
{
  name = "EnsureSystemConfigValueText1717473142704";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'system_configs'
            AND column_name = 'value'
            AND data_type <> 'text'
        ) THEN
          ALTER TABLE "system_configs" ALTER COLUMN "value" TYPE TEXT;
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 无法还原为"未声明的 TEXT"状态；保持 TEXT 即可，无需操作。
  }
}
