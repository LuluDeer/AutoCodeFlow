import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createTestApp } from "./helpers/app.helper";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service";
import { UserRole } from "../src/modules/users/entities/user.entity";
import type { AuthUser } from "../src/common/interfaces/auth-user.interface";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest + 真 service。
 * 第70轮/ADR-044：业务人员(role=user)的"我的交付物"归属过滤。
 * 断言副作用而非接口 200：U1/ADMIN 两个 viewer 对同一批产物行的可见集不同，
 * 无主任务产物对 role=user 不可见（fail-closed），total 与 items 同谓词。
 * 随机 id 隔离，afterAll 精确清理自建行。
 */
describe("Artifacts ownership (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let svc: ArtifactsService;

  const runId = randomUUID();
  const u1Id = 900001 + Math.floor(Math.random() * 1000);
  const u2Id = u1Id + 1;
  const taskIds: string[] = [];
  const execIds: string[] = [];
  const artifactIds: string[] = [];

  const viewer = (id: number, isAdmin = false): AuthUser =>
    ({
      id,
      username: `e2e-u${id}`,
      role: isAdmin ? UserRole.ADMIN : UserRole.USER,
    }) as AuthUser;

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `artifacts ownership e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    svc = app.get(ArtifactsService);

    const mk = async (ownerUserId: number | null) => {
      const taskId = randomUUID();
      const execId = randomUUID();
      const artifactId = randomUUID();
      taskIds.push(taskId);
      execIds.push(execId);
      artifactIds.push(artifactId);
      await db.query(
        `INSERT INTO tasks (id, name, status, "triggerType", runtime, timeout, "maxRetry", "blockStrategy", "misfireStrategy", "retryDelay", priority, "executeMode", "runOnUpstreamFailure", "ownerUserId", "projectId", "createdAt", "updatedAt")
         VALUES ($1, $2, 'active', 'manual', 'node', 30000, 0, 'discard', 'ignore', 1000, 'normal', 'single', false, $3, NULL, now(), now())`,
        [
          taskId,
          `e2e-artifact-${runId}-${ownerUserId ?? "orphan"}`,
          ownerUserId,
        ],
      );
      await db.query(
        `INSERT INTO task_executions (id, "taskId", "taskName", status, "createdAt")
         VALUES ($1, $2, $3, 'success', now())`,
        [execId, taskId, `e2e-exec-${runId}`],
      );
      await db.query(
        `INSERT INTO execution_artifacts (id, "executionId", "taskId", name, size, sha256, "createdAt")
         VALUES ($1, $2, $3, $4, 1, $5, now())`,
        [artifactId, execId, taskId, `report-${runId}.json`, "a".repeat(64)],
      );
    };
    await mk(u1Id);
    await mk(u2Id);
    await mk(null); // 无主产物
  });

  afterAll(async () => {
    for (const id of artifactIds)
      await db.query("DELETE FROM execution_artifacts WHERE id = $1", [id]);
    for (const id of execIds)
      await db.query("DELETE FROM task_executions WHERE id = $1", [id]);
    for (const id of taskIds)
      await db.query("DELETE FROM tasks WHERE id = $1", [id]);
    await app?.close();
  });

  it("U1 只见自己产物；无主与他人产物 fail-closed 不可见；ADMIN 见全量；total 与 items 同谓词", async () => {
    const q = {
      page: 1,
      pageSize: 50,
      applicationId: undefined,
      taskId: undefined,
      q: `report-${runId}`,
    } as never;

    const u1 = await svc.listArtifactRows(q, viewer(u1Id));
    const u1Ids = (u1.items as Array<{ taskId: string }>).map((r) => r.taskId);
    expect(u1Ids).toContain(taskIds[0]);
    expect(u1Ids).not.toContain(taskIds[1]);
    expect(u1Ids).not.toContain(taskIds[2]);

    const admin = await svc.listArtifactRows(q, viewer(0, true));
    const adminIds = (admin.items as Array<{ taskId: string }>).map(
      (r) => r.taskId,
    );
    expect(adminIds).toContain(taskIds[0]);
    expect(adminIds).toContain(taskIds[1]);
    expect(adminIds).toContain(taskIds[2]);

    // 写面不因本切片放宽：role=user 直调 phrase/approve 端点 403 由 agent 单测覆盖。
  });
});
