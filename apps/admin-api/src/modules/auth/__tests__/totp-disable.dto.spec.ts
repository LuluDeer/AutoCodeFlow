import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";
import { AuditService } from "../../../modules/audit/audit.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：POST /auth/totp/disable 的 body 从内联类型
 * （metatype=Object，全局 ValidationPipe 整面跳过——实测 `{"foo":"bar",
 * "password":"x"}` 被静默收下）换为 TotpDisableDto 后的全局纪律回归。
 *
 * supertest 走真实参数管道 + 与 main.ts 同参的全局 ValidationPipe
 * （whitelist + forbidNonWhitelisted + transform），钉住「多余字段必 400」
 * 在这一面的恢复；合法双形态（password / code 二选一）照常透传 service。
 */
describe("AuthController totpDisable body 纪律（F-53）", () => {
  let app: INestApplication;
  let authService: { totpDisable: jest.Mock };

  beforeAll(async () => {
    authService = {
      totpDisable: jest.fn().mockResolvedValue({ disabled: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 全局管道同参（本套件不走完整 bootstrap）。
    const { ValidationPipe } = await import("@nestjs/common");
    const { HttpExceptionFilter } =
      await import("../../../common/filters/http-exception.filter");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    // 守卫被放行后 @CurrentUser() 取 req.user——注入一个假身份，
    // 让「合法 body」用例能走完 handler（user.id 透传 service）。
    app.use((req: unknown, _res: unknown, next: () => void) => {
      (req as { user?: unknown }).user = { id: 1, username: "u" };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("多余字段 → 400 VALIDATION_FAILED（此前被静默收下的 UIAUDIT 实测探针）", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/totp/disable")
      .send({ foo: "bar", password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(authService.totpDisable).not.toHaveBeenCalled();
  });

  it("code 形态错（非 6 位数字）→ 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/totp/disable")
      .send({ code: "12abc" });
    expect(res.status).toBe(400);
    expect(authService.totpDisable).not.toHaveBeenCalled();
  });

  it("合法 body（password 确认）照常透传 service", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/totp/disable")
      .send({ password: "pw" });
    expect(res.status).toBe(201); // POST 缺省 201（路由无 @HttpCode）。
    expect(authService.totpDisable).toHaveBeenCalledWith(1, {
      password: "pw",
      code: undefined,
    });
  });
});
