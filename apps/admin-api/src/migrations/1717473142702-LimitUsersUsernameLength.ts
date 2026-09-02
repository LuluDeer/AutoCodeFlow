import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DB-006: users.username 收敛为 VARCHAR(128)。
 *
 * entity 对应改动：user.entity.ts
 *   @Column({ unique: true, length: 128 }) + @Length(3, 128)
 *
 * InitialSchema 建表时 username 为无长度限制的 VARCHAR，与 varchar(255) 默认
 * 行为不一致且影响唯一索引效率。本迁移统一为 VARCHAR(128)。
 *
 * 执行前预检查（存在超长用户名时 ALTER 会失败——不静默截断，属预期，
 * 需先人工处理这些账号）：
 *   SELECT id, "username" FROM "users" WHERE length("username") > 128;
 *
 * 幂等说明：DO 块中已按 information_schema 判断当前长度，无需重复执行。
 */
export class LimitUsersUsernameLength1717473142702
  implements MigrationInterface
{
  name = "LimitUsersUsernameLength1717473142702";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'users'
            AND column_name = 'username'
            AND data_type = 'character varying'
            AND (character_maximum_length IS NULL OR character_maximum_length <> 128)
        ) THEN
          ALTER TABLE "users" ALTER COLUMN "username" TYPE VARCHAR(128);
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "username" TYPE VARCHAR`,
    );
  }
}
