import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-05（执行产物 artifacts 通道）：task_executions 新增 jsonb 可空列 artifacts，
 * 保存执行器任务结束回调上报的产物清单 [{name,size,sha256}]。文件字节本身单独
 * PUT 上传到 uploads/artifacts/<execId>/（见 ArtifactsModule），本列仅存清单。
 *
 * nullable：NULL = 无产物或未上报（旧数据、以及未启用 artifacts 的执行器）。
 * best-effort：清单缺失或上传失败都不影响任务终态，故不设约束。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionArtifacts1789600000000 implements MigrationInterface {
  name = "AddExecutionArtifacts1789600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "artifacts" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "artifacts"
    `);
  }
}
