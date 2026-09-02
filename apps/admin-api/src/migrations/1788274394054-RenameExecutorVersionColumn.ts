import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameExecutorVersionColumn1788274394054 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "executors" RENAME COLUMN "version" TO "executorVersion"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "executors" RENAME COLUMN "executorVersion" TO "version"`);
    }

}
