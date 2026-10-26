import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ARTIFACTS-INDEX-46（部署模型评审 2026-10-23 §4.6）：执行产物元数据索引表
 * `execution_artifacts`。
 *
 * ## 为什么需要
 *
 * 产物清单此前只存 `task_executions.artifacts` jsonb（FEAT-05，迁移
 * 1789600000000）——「这个应用/任务的产物有哪些」不可查询：jsonb 数组无索引，
 * 只能全表扫执行行再解数组。本表把清单**关系化**为每产物一行，供
 * GET /artifacts?applicationId=&taskId=&page= 按应用/任务维度索引查询。
 *
 * ## 行语义
 *
 * 一行 = 某次执行清单里的一个产物（唯一 (executionId, name)）。列值与 jsonb
 * 清单条目逐字段同源（name/size/sha256），外加冗余维度列：
 *   - `taskId`：冗余自执行行（task_executions.taskId）——按任务查产物不必回连执行表；
 *   - `applicationId`：冗余自任务行（tasks.applicationId）——按应用查产物。可空：
 *     任务可以不挂应用（脚本任务），且应用删除后该行不连带消失（FK ON DELETE
 *     SET NULL，与 1790000000008/0009 的 projectId 同款语义）。
 *
 * ## 外键级联
 *
 * - `executionId → task_executions.id ON DELETE CASCADE`：删任务级联删执行行
 *   （1717473142679），执行行没了清单行必须跟着走——否则孤儿清单行会把
 *   GET /artifacts 的结果污染成「幽灵产物」。
 * - `applicationId → applications.id ON DELETE SET NULL`：应用删除后产物行保留、
 *   归属清空——历史执行产物是事实，不因应用下线失真（与 projectId SET NULL 同款）。
 *
 * ## 不回填（刻意）
 *
 * 存量 jsonb 清单**不迁移**：与 1790000000055/0061「不猜映射」先例一致——
 * 存量行的 applicationId 需按任务快照回溯，任务可能已删/已改挂应用，任何回填
 * 都是在猜。读面语义：GET /artifacts 只查新表，存量执行无新表行 → 如实返回空
 * （过渡期语义，见 service 注释）；按执行读清单的既有端点 GET
 * /tasks/executions/:execId/artifacts 继续读 jsonb，不受影响。
 *
 * ## 双轨写（不破坏既有链路）
 *
 * 终态回调写点（task.service.handleCallback）在写 jsonb 的同一位置同步 upsert
 * 本表（winner 分支，幂等：重报整替）。TTL 清理（artifacts-retention）在置空
 * jsonb 的同一批同步 delete 本表行——两侧始终同宽。
 *
 * 幂等：CREATE TABLE / INDEX 均 IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class ExecutionArtifactsIndex1790000000065 implements MigrationInterface {
  name = "ExecutionArtifactsIndex1790000000065";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "execution_artifacts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "executionId" UUID NOT NULL,
        "taskId" UUID NOT NULL,
        "applicationId" UUID,
        "name" VARCHAR(255) NOT NULL,
        "size" INTEGER NOT NULL,
        "sha256" VARCHAR(64) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_execution_artifacts_execution_name"
          UNIQUE ("executionId", "name"),
        CONSTRAINT "FK_execution_artifacts_executionId"
          FOREIGN KEY ("executionId") REFERENCES "task_executions"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_execution_artifacts_applicationId"
          FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL
      )
    `);
    // 查询面：GET /artifacts?taskId= 的主谓词；同值行随执行终态插入有序，createdAt 兜底排序。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_task"
      ON "execution_artifacts" ("taskId")
    `);
    // 查询面：GET /artifacts?applicationId= 的主谓词（按应用聚合是 §4.6 的核心痛点）。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_execution_artifacts_application"
      ON "execution_artifacts" ("applicationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_execution_artifacts_application"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_execution_artifacts_task"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "execution_artifacts"
    `);
  }
}
