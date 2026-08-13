import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApplicationVersionsTable1717473142686 implements MigrationInterface {
  name = "CreateApplicationVersionsTable1717473142686";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "application_versions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId" UUID NOT NULL,
        "version" VARCHAR NOT NULL,
        "gitCommit" VARCHAR,
        "snapshot" JSONB NOT NULL,
        "sourceDeploymentId" VARCHAR,
        "status" VARCHAR NOT NULL DEFAULT 'released',
        "createdBy" VARCHAR,
        "description" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_application_versions_applicationId"
          FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_application_versions_applicationId" ON "application_versions" ("applicationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_application_versions_applicationId_version" ON "application_versions" ("applicationId", "version")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_application_versions_createdAt" ON "application_versions" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_application_versions_sourceDeploymentId" ON "application_versions" ("sourceDeploymentId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_application_versions_sourceDeploymentId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_application_versions_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_application_versions_applicationId_version"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_application_versions_applicationId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "application_versions"`);
  }
}
