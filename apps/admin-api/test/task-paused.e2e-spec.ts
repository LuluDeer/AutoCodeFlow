/**
 * task PAUSED 缺省真 PG 进程内集成（第 3 级）。
 *
 * 验证目标：
 *  - POST /tasks 不传 status 时响应 status=paused；
 *  - 同一事务外读真 PG 行，status 确实落为 paused；
 *  - information_schema.columns 的 DB 层默认值同样为 paused。
 */
process.env.SELFTEST_SKIP_ENV_FILE = "1";
process.env.DB_PASSWORD ||= "test-db-password";
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret-0123456789ab";
process.env.EXECUTOR_SECRET ||= "test-executor-secret-16";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const appHelper = require("./helpers/app.helper") as typeof import("./helpers/app.helper");

import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { DataSource } from "typeorm";
import { Task, TaskStatus } from "../src/modules/task/entities/task.entity";

jest.setTimeout(120_000);

const STAMP = process.env.HARDENING_STAMP ?? randomUUID().slice(0, 8);

describe("task status 缺省 paused · 真 PG 验证", () => {
  let app: INestApplication | undefined;
  let dataSource: DataSource;
  let token = "";
  let createdId = "";

  beforeAll(async () => {
    app = await appHelper.createTestApp();
    dataSource = app.get(DataSource);
    token = await appHelper.loginAsAdmin(app);
  });

  afterAll(async () => {
    if (dataSource && createdId) {
      await dataSource.getRepository(Task).delete({ id: createdId });
    }
    if (app) await app.close();
  });

  it("POST /tasks 缺省 paused：响应、库行与 information_schema 默认值三处一致", async () => {
    const res = await request(app!.getHttpServer())
      .post("/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: `task-paused-${STAMP}`,
        triggerType: "manual",
      })
      .expect(201);

    const body = res.body?.data ?? res.body;
    createdId = body?.id ?? "";
    expect(createdId).not.toBe("");
    expect(body.status).toBe(TaskStatus.PAUSED);

    const row = await dataSource.getRepository(Task).findOne({
      where: { id: createdId },
    });
    expect(row?.status).toBe(TaskStatus.PAUSED);

    const defaults = await dataSource.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'tasks'
          AND column_name = 'status'`,
    );
    expect(defaults).toHaveLength(1);
    expect(String(defaults[0]?.column_default ?? "")).toContain("'paused'");
  });
});
