import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { createTestApp } from "./helpers/app.helper";

describe("Auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------ login
  describe("POST /auth/login", () => {
    it("should return accessToken and refreshToken on valid credentials", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin", password: "admin123" })
        .expect(201);

      expect(res.body).toHaveProperty("accessToken");
      expect(res.body).toHaveProperty("refreshToken");
      expect(typeof res.body.accessToken).toBe("string");
    });

    it("should return 401 on wrong password", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin", password: "wrongpassword" })
        .expect(401);
    });

    it("should return 400 when username is missing", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ password: "admin123" })
        .expect(400);
    });

    it("should return 400 when password is missing", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin" })
        .expect(400);
    });

    it("should return 400 when body is empty", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({})
        .expect(400);
    });
  });

  // --------------------------------------------------------------- refresh
  describe("POST /auth/refresh", () => {
    it("should return new tokens when given a valid refreshToken", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin", password: "admin123" })
        .expect(201);

      const { refreshToken } = loginRes.body;

      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken })
        .expect(201);

      expect(res.body).toHaveProperty("accessToken");
      expect(res.body).toHaveProperty("refreshToken");
    });

    it("should return 401 when refreshToken is invalid", async () => {
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: "invalid.token.value" })
        .expect(401);
    });
  });

  // --------------------------------------------------------------- profile
  describe("GET /auth/profile", () => {
    it("should return 401 when no token is provided", async () => {
      await request(app.getHttpServer())
        .get("/auth/profile")
        .expect(401);
    });

    it("should return user profile when a valid token is provided", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin", password: "admin123" })
        .expect(201);

      const { accessToken } = loginRes.body;

      const res = await request(app.getHttpServer())
        .get("/auth/profile")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("username");
    });

    it("should return 401 when token is malformed", async () => {
      await request(app.getHttpServer())
        .get("/auth/profile")
        .set("Authorization", "Bearer not-a-real-token")
        .expect(401);
    });
  });

  // --------------------------------------------------------------- logout
  describe("POST /auth/logout", () => {
    it("should return 401 when no token is provided", async () => {
      await request(app.getHttpServer())
        .post("/auth/logout")
        .expect(401);
    });

    it("should revoke tokens and return success", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ username: "admin", password: "admin123" })
        .expect(201);

      const { accessToken } = loginRes.body;

      const res = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(201);

      expect(res.body).toEqual({ success: true });
    });
  });
});
