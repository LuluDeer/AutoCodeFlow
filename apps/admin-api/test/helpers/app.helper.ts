import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import * as request from "supertest";
import { AppModule } from "../../src/app.module";

/**
 * Bootstrap a full NestJS application for e2e testing.
 * Uses the real AppModule, so requires a running DB and Redis
 * (or properly mocked environment variables).
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();
  return app;
}

/**
 * Log in as the default admin user and return the accessToken.
 * Defaults to admin / admin123 — override via env vars
 * ADMIN_TEST_USER and ADMIN_TEST_PASS if needed.
 */
export async function loginAsAdmin(app: INestApplication): Promise<string> {
  const username = process.env.ADMIN_TEST_USER ?? "admin";
  const password = process.env.ADMIN_TEST_PASS ?? "admin123";

  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ username, password })
    .expect(201);

  const token: string = res.body?.accessToken ?? res.body?.data?.accessToken;
  if (!token) {
    throw new Error(
      `loginAsAdmin: accessToken not found in response: ${JSON.stringify(res.body)}`,
    );
  }
  return token;
}
