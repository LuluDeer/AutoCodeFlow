import * as fs from "fs";
import * as path from "path";
import { AddExecutionArtifactsListIndexes1790000000109 } from "../../../migrations/1790000000109-ExecutionArtifactsListIndexes";

const MIGRATION_FILE = path.join(
  __dirname,
  "../../../migrations/1790000000109-ExecutionArtifactsListIndexes.ts",
);
const ENTITY_FILE = path.join(
  __dirname,
  "../entities/execution-artifact.entity.ts",
);
const flatten = (s: string) => s.replace(/\s+/g, " ");

const TASK_INDEX = "idx_execution_artifacts_task_created_at_id";
const APP_INDEX = "idx_execution_artifacts_application_created_at_id";

describe("DATAOPS：execution_artifacts 分页索引迁移 up/down", () => {
  it("up 建两条 CONCURRENTLY 复合索引，down 逆序回收，超时设置成对复位", async () => {
    const qr = { query: jest.fn().mockResolvedValue(undefined) };
    const migration = new AddExecutionArtifactsListIndexes1790000000109();

    expect(migration.transaction).toBe(false);

    await migration.up(qr as never);
    const upSql = qr.query.mock.calls.map((c) => c[0] as string);
    expect(upSql[0]).toBe("SET statement_timeout = 0");
    expect(upSql[upSql.length - 1]).toBe("RESET statement_timeout");
    expect(upSql).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TASK_INDEX}" ON "execution_artifacts" ("taskId", "createdAt" DESC, "id" DESC)`,
    );
    expect(upSql).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${APP_INDEX}" ON "execution_artifacts" ("applicationId", "createdAt" DESC, "id" DESC)`,
    );
    expect(upSql.findIndex((s) => s.includes(`"${TASK_INDEX}"`))).toBeLessThan(
      upSql.findIndex((s) => s.includes(`"${APP_INDEX}"`)),
    );

    qr.query.mockClear();
    await migration.down(qr as never);
    const downSql = qr.query.mock.calls.map((c) => c[0] as string);
    expect(downSql[0]).toBe("SET statement_timeout = 0");
    expect(downSql[downSql.length - 1]).toBe("RESET statement_timeout");
    expect(downSql).toContain(
      `DROP INDEX CONCURRENTLY IF EXISTS "${APP_INDEX}"`,
    );
    expect(downSql).toContain(
      `DROP INDEX CONCURRENTLY IF EXISTS "${TASK_INDEX}"`,
    );
    expect(downSql.findIndex((s) => s.includes(`"${APP_INDEX}"`))).toBeLessThan(
      downSql.findIndex((s) => s.includes(`"${TASK_INDEX}"`)),
    );
  });

  it("实体 @Index 与迁移 DDL 同名同列（方向按约定只落 DDL）", () => {
    const entity = fs.readFileSync(ENTITY_FILE, "utf8");
    const migration = flatten(fs.readFileSync(MIGRATION_FILE, "utf8"));

    expect(entity).toContain(`@Index("${TASK_INDEX}", [`);
    expect(entity).toContain(`@Index("${APP_INDEX}", [`);
    expect(migration).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TASK_INDEX}" ON "execution_artifacts" ("taskId", "createdAt" DESC, "id" DESC)`,
    );
    expect(migration).toContain(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${APP_INDEX}" ON "execution_artifacts" ("applicationId", "createdAt" DESC, "id" DESC)`,
    );
  });
});
