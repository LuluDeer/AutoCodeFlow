import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshTokenTable1717473142680 implements MigrationInterface {
  name = 'RefreshTokenTable1717473142680';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"        SERIAL PRIMARY KEY,
        "jti"       VARCHAR NOT NULL,
        "userId"    INTEGER NOT NULL,
        "revoked"   BOOLEAN NOT NULL DEFAULT false,
        "expiresAt" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_refresh_tokens_jti" UNIQUE ("jti")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_jti" ON "refresh_tokens" ("jti")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_userId" ON "refresh_tokens" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
  }
}
