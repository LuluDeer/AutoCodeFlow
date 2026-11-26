import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N16「发布背书 + 失败归责」：capabilities 增加发布/背书/钉版/声明四列。
 *
 * - owner / backer：发布者身份键与部门/角色背书（backer 非个人），均 nullable。
 * - versionPin：钉死版本，语义化版本或 hex hash，最长 64；nullable。
 * - attestation：声明 `{signer, at?, scope?}`，封闭键由 service 校验；nullable。
 *
 * **不回填**：历史行的语义无人可推断，NULL 就是「未声明」的诚实表达。
 *
 * 幂等：DO 块内按 information_schema.columns 逐列判定，重复 up 不会重复加列；
 * down 同样逐列判定存在才 DROP，revert 重放无副作用。不使用 CONCURRENTLY
 * （加列本身不重建索引，遵守 check-migrations.mjs 的守卫约定）。
 */
export class AddCapabilityAttestation1790000000107 implements MigrationInterface {
  name = "AddCapabilityAttestation1790000000107";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'owner'
        ) THEN
          ALTER TABLE "capabilities" ADD COLUMN "owner" varchar(128);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'backer'
        ) THEN
          ALTER TABLE "capabilities" ADD COLUMN "backer" varchar(128);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'versionPin'
        ) THEN
          ALTER TABLE "capabilities" ADD COLUMN "versionPin" varchar(64);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'attestation'
        ) THEN
          ALTER TABLE "capabilities" ADD COLUMN "attestation" jsonb;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'attestation'
        ) THEN
          ALTER TABLE "capabilities" DROP COLUMN "attestation";
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'versionPin'
        ) THEN
          ALTER TABLE "capabilities" DROP COLUMN "versionPin";
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'backer'
        ) THEN
          ALTER TABLE "capabilities" DROP COLUMN "backer";
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'capabilities' AND column_name = 'owner'
        ) THEN
          ALTER TABLE "capabilities" DROP COLUMN "owner";
        END IF;
      END $$
    `);
  }
}
