import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1717473142683 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // PERF-01: Add indexes for performance optimization

    // Tasks table indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tasks_status" ON "tasks"("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tasks_trigger_type" ON "tasks"("triggerType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tasks_status_trigger_type" ON "tasks"("status", "triggerType")
    `);

    // Task executions table indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_created_at" ON "task_executions"("createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_task_id_created_at" ON "task_executions"("taskId", "createdAt" DESC)
    `);

    // Execution log lines table indexes (already exists but ensure it's there)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_execution_log_lines_execution_id" ON "execution_log_lines"("executionId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_execution_log_lines_line_number" ON "execution_log_lines"("lineNumber")
    `);

    // Audit logs table indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs"("createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_id" ON "audit_logs"("userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_logs_action" ON "audit_logs"("action")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_logs_resource" ON "audit_logs"("resource")
    `);

    // Executors table indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executors_status" ON "executors"("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executors_last_heartbeat" ON "executors"("lastHeartbeat")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tasks indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_trigger_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_status_trigger_type"`);

    // Drop task executions indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_task_executions_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_task_executions_task_id_created_at"`);

    // Drop execution log lines indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_execution_log_lines_execution_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_execution_log_lines_line_number"`);

    // Drop audit logs indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_logs_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_logs_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_logs_resource"`);

    // Drop executors indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_executors_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_executors_last_heartbeat"`);
  }
}
