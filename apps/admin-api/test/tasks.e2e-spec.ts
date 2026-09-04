import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

describe("Tasks (e2e)", () => {
  let app: INestApplication;
  let accessToken: string;
  let createdTaskId: string;

  beforeAll(async () => {
    app = await createTestApp();
    accessToken = await loginAsAdmin(app);
  });

  afterAll(async () => {
    // Clean up: delete the task created during tests if it still exists
    if (createdTaskId) {
      await request(app.getHttpServer())
        .delete(`/tasks/${createdTaskId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .catch(() => {
          /* ignore */
        });
    }
    await app.close();
  });

  // ------------------------------------------------------------------ GET /tasks
  describe("GET /tasks", () => {
    it("should return 401 when no token is provided", async () => {
      await request(app.getHttpServer()).get("/tasks").expect(401);
    });

    it("should return task list with valid token", async () => {
      const res = await request(app.getHttpServer())
        .get("/tasks")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      // Accept both paginated shape and plain array
      const body = res.body;
      const items = body?.data?.items ?? body?.items ?? body;
      expect(Array.isArray(items)).toBe(true);
    });

    it("should support page and pageSize query params", async () => {
      await request(app.getHttpServer())
        .get("/tasks?page=1&pageSize=5")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  // ----------------------------------------------------------------- POST /tasks
  describe("POST /tasks", () => {
    it("should return 401 when no token is provided", async () => {
      await request(app.getHttpServer())
        .post("/tasks")
        .send({ name: "test-task", type: "cron", schedule: "0 * * * *" })
        .expect(401);
    });

    it("should create a task and return 201", async () => {
      // Field names must match CreateTaskDto (triggerType/cronExpression);
      // the global ValidationPipe uses forbidNonWhitelisted, so legacy
      // `type`/`schedule`/`executorAddress` keys would be rejected with 400.
      const payload = {
        name: "e2e-test-task",
        description: "Created by e2e tests",
        triggerType: "cron",
        cronExpression: "0 * * * *",
        runtime: "shell",
      };

      const res = await request(app.getHttpServer())
        .post("/tasks")
        .set("Authorization", `Bearer ${accessToken}`)
        .send(payload)
        .expect(201);

      const task = res.body?.data ?? res.body;
      expect(task).toHaveProperty("id");
      expect(task.name).toBe("e2e-test-task");
      createdTaskId = task.id;
    });

    it("should return 400 when required fields are missing", async () => {
      await request(app.getHttpServer())
        .post("/tasks")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ description: "missing name and type" })
        .expect(400);
    });
  });

  // --------------------------------------------------------------- GET /tasks/:id
  describe("GET /tasks/:id", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer()).get("/tasks/some-id").expect(401);
    });

    it("should return task detail for existing task", async () => {
      if (!createdTaskId) return;

      const res = await request(app.getHttpServer())
        .get(`/tasks/${createdTaskId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      const task = res.body?.data ?? res.body;
      expect(task.id).toBe(createdTaskId);
    });

    it("should return 404 for non-existent task", async () => {
      await request(app.getHttpServer())
        .get("/tasks/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(404);
    });
  });

  // ------------------------------------------------------------- PATCH /tasks/:id
  describe("PATCH /tasks/:id", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer())
        .patch("/tasks/some-id")
        .send({ description: "updated" })
        .expect(401);
    });

    it("should update a task successfully", async () => {
      if (!createdTaskId) return;

      const res = await request(app.getHttpServer())
        .patch(`/tasks/${createdTaskId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ description: "updated by e2e test" })
        .expect(200);

      const task = res.body?.data ?? res.body;
      expect(task.description).toBe("updated by e2e test");
    });
  });

  // ------------------------------------------------------------ DELETE /tasks/:id
  describe("DELETE /tasks/:id", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer()).delete("/tasks/some-id").expect(401);
    });

    it("should delete a task successfully", async () => {
      if (!createdTaskId) return;

      await request(app.getHttpServer())
        .delete(`/tasks/${createdTaskId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      // Mark as deleted so afterAll cleanup skips it
      createdTaskId = "";
    });

    it("should return 404 for already-deleted task", async () => {
      await request(app.getHttpServer())
        .delete("/tasks/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
