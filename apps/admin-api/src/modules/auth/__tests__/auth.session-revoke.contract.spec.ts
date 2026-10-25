import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";
import { AuditService } from "../../audit/audit.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { AppError } from "../../../common/errors/app-error";

/**
 * F-56（UIAUDIT 后端轮 P3-3）：DELETE /auth/sessions/:id 错误封套归位。
 *
 * 旧行为（live 实测）：`DELETE /api/auth/sessions/abc` → 200
 * `{"code":200,"data":{"success":false}}`——HTTP 成功、语义失败的双层解读，
 * 调用方必须二次读 success 标志；与全站「错误必 4xx+errorCode」形态相悖。
 *
 * 新契约（本 spec 走真实路由栈钉住）：
 *   · id 形态非法 → 400 INVALID_VALUE_FORMAT（ParseIntShapePipe，与 users 同源）；
 *   · 不存在/不属于你 → 404 SESSION_NOT_FOUND（AppError，目录状态 401→404：
 *     401 会触发 admin-web 拦截器的「会话过期」跳登录链，放大成整页登出）；
 *   · 命中 → 200 {success:true}（既有形态不变，SecuritySettings 消费面零改动）。
 */
describe("DELETE /auth/sessions/:id 错误封套（F-56）", () => {
  let app: INestApplication;
  let authService: { revokeSession: jest.Mock };

  beforeAll(async () => {
    authService = { revokeSession: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        // log 必须 resolved——控制器对审计调用 .catch()（fail-open 包装），
        // undefined 没有 .catch。
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    const { HttpExceptionFilter } =
      await import("../../../common/filters/http-exception.filter");
    app.useGlobalFilters(new HttpExceptionFilter());
    app.use((req: unknown, _res: unknown, next: () => void) => {
      (req as { user?: unknown }).user = { id: 1, username: "u" };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    authService.revokeSession.mockClear();
  });

  it("形态非法（abc）→ 400 INVALID_VALUE_FORMAT，不再 200 {success:false}", async () => {
    const res = await request(app.getHttpServer()).delete("/auth/sessions/abc");
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(authService.revokeSession).not.toHaveBeenCalled();
  });

  it("不存在/不属于你（999）→ 404 SESSION_NOT_FOUND（service 透传）", async () => {
    authService.revokeSession.mockRejectedValueOnce(
      new AppError("SESSION_NOT_FOUND"),
    );
    const res = await request(app.getHttpServer()).delete("/auth/sessions/999");
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe("SESSION_NOT_FOUND");
    expect(res.body.message).toContain("会话不存在");
  });

  it("命中 → 200 {success:true}（消费面既有形态不变）", async () => {
    const res = await request(app.getHttpServer()).delete("/auth/sessions/42");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(authService.revokeSession).toHaveBeenCalledWith(1, 42);
  });
});
