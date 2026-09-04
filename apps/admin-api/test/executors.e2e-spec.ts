import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

describe("Executors (e2e)", () => {
  let app: INestApplication;
  let accessToken: string;
  let registeredExecutorId: string;

  beforeAll(async () => {
    app = await createTestApp();
    accessToken = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // --------------------------------------------------------- POST /executors/register
  describe("POST /executors/register", () => {
    // verifyExecutorToken() accepts the DB key "executor.sharedToken" if set,
    // otherwise the env value executor.sharedToken = EXECUTOR_SECRET ||
    // EXECUTOR_SHARED_TOKEN. With no token configured the endpoint refuses
    // ALL registrations (401), so these tests are env-dependent.
    const sharedToken =
      process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || "";

    it("should register an executor and return executor data", async () => {
      if (!sharedToken) {
        return; // no token configured → register always 401, skip
      }
      const payload = {
        address: `127.0.0.1:${30000 + Math.floor(Math.random() * 10000)}`,
        appName: "e2e-test-executor",
        groupName: "test",
        tags: ["e2e"],
        description: "Executor registered by e2e tests",
      };

      const res = await request(app.getHttpServer())
        .post("/executors/register")
        .set("Authorization", `Bearer ${sharedToken}`)
        .send(payload)
        .expect(201);

      const executor = res.body?.data ?? res.body;
      expect(executor).toHaveProperty("id");
      expect(executor.address).toBe(payload.address);
      registeredExecutorId = executor.id;
    });

    it("should return 401 when executor shared token is required but missing", async () => {
      // This test is environment-dependent — skip if no shared token is configured
      if (!sharedToken) {
        return;
      }

      await request(app.getHttpServer())
        .post("/executors/register")
        .send({ address: "127.0.0.1:9999", appName: "unauthorized-executor" })
        // No Authorization header → should be rejected
        .expect(401);
    });
  });

  // -------------------------------------------------------------- GET /executors
  describe("GET /executors", () => {
    it("should return 401 when no token is provided", async () => {
      await request(app.getHttpServer()).get("/executors").expect(401);
    });

    it("should return executor list with valid JWT token", async () => {
      const res = await request(app.getHttpServer())
        .get("/executors")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      const body = res.body;
      const items = body?.data ?? body;
      expect(Array.isArray(items)).toBe(true);
    });
  });

  // --------------------------------------------------------- GET /executors/groups
  describe("GET /executors/groups", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer()).get("/executors/groups").expect(401);
    });

    it("should return groups list with valid token", async () => {
      const res = await request(app.getHttpServer())
        .get("/executors/groups")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      const items = res.body?.data ?? res.body;
      expect(Array.isArray(items)).toBe(true);
    });
  });

  // ---------------------------------------------------------- GET /executors/:id
  describe("GET /executors/:id", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer()).get("/executors/some-id").expect(401);
    });

    it("should return executor detail for existing executor", async () => {
      if (!registeredExecutorId) return;

      const res = await request(app.getHttpServer())
        .get(`/executors/${registeredExecutorId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      const executor = res.body?.data ?? res.body;
      expect(executor.id).toBe(registeredExecutorId);
    });

    it("should return 404 for non-existent executor", async () => {
      await request(app.getHttpServer())
        .get("/executors/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(404);
    });
  });

  // --------------------------------------------------------- PATCH /executors/:id
  describe("PATCH /executors/:id", () => {
    it("should return 401 without token", async () => {
      await request(app.getHttpServer())
        .patch("/executors/some-id")
        .send({ description: "updated" })
        .expect(401);
    });

    it("should update executor metadata", async () => {
      if (!registeredExecutorId) return;

      const res = await request(app.getHttpServer())
        .patch(`/executors/${registeredExecutorId}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ description: "updated by e2e test", maxConcurrentTasks: 5 })
        .expect(200);

      const executor = res.body?.data ?? res.body;
      expect(executor).toBeDefined();
    });
  });
});
