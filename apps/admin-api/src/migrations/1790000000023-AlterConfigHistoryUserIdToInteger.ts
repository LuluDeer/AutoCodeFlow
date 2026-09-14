import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PK-21（DEEP_REVIEW 0ef3bbe）：config_history."userId" 列类型由 VARCHAR
 * 对齐全库其余 userId（integer）。
 *
 * 背景：
 * - 1789000000001 建 config_history 时 "userId" 落成 VARCHAR，实体同步声明
 *   userId: string；而 users.id / audit_logs.userId / project_members.userId /
 *   api_keys.userId / refresh_tokens.userId 均为 integer——跨表按操作人
 *   关联/审计透视时类型不齐，API 输出形态不统一；
 * - 写面自始至终只由 config.controller 以 String(user.id) 写入（AuthUser.id
 *   已是 number），存量值均为数字字符串或 NULL，可安全 ::integer 转换；
 * - 本迁移不是"实体对齐既有 DB"的零迁移情形（PK-10 先例）：DB 事实确为
 *   VARCHAR，故需 ALTER COLUMN TYPE 同步 DB 与实体。
 *
 * 幂等：ALTER COLUMN TYPE 重复执行等价 no-op（列已是 integer 时再转一次
 *   仍为 integer，PG 不报错）。USING "userId"::integer 对非数字存量行直接
 *   报错（fail-fast）——这是期望行为：存量脏数据不应被静默吞掉。
 * down：回退为 VARCHAR（用 ::text 反向转换）。
 */
export class AlterConfigHistoryUserIdToInteger1790000000023
  implements MigrationInterface
{
  name = "AlterConfigHistoryUserIdToInteger1790000000023";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "config_history" ALTER COLUMN "userId" TYPE INTEGER USING "userId"::integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "config_history" ALTER COLUMN "userId" TYPE VARCHAR USING "userId"::text`,
    );
  }
}
