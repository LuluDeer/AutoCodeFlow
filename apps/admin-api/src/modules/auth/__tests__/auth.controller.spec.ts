import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";
// P2-4: 登录失败审计只认 AppError（业务失败）——本 spec 据此构造失败面。
import { AppError } from "../../../common/errors/app-error";
import { AuditService } from "../../audit/audit.service";
import { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";

const mockAuthService = () => ({
  login: jest.fn(),
  refreshToken: jest.fn(),
  revokeAllForUser: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockReq = { ip: "192.168.1.1" } as any;
const adminUser: AuthUser = {
  id: 1,
  username: "admin",
  role: UserRole.ADMIN,
} as AuthUser;

describe("AuthController", () => {
  let controller: AuthController;
  let authSvc: ReturnType<typeof mockAuthService>;
  let auditSvc: ReturnType<typeof mockAuditService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useFactory: mockAuthService },
        { provide: AuditService, useFactory: mockAuditService },
      ],
    }).compile();

    controller = module.get(AuthController);
    authSvc = module.get(AuthService);
    auditSvc = module.get(AuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("login", () => {
    it("delegates to authService.login and logs audit", async () => {
      const dto = { username: "admin", password: "secret" } as any;
      const tokens = { accessToken: "at", refreshToken: "rt" };
      authSvc.login.mockResolvedValue(tokens);

      const result = await controller.login(dto, mockReq);

      // SEC-03: controller now passes request metadata (UA/IP) for the
      // session list; assertion covers the added second argument.
      expect(authSvc.login).toHaveBeenCalledWith(dto, {
        userAgent: null,
        ip: "192.168.1.1",
      });
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "admin",
          action: "auth.login",
          resource: "auth",
          ip: "192.168.1.1",
        }),
      );
      expect(result).toEqual(tokens);
    });

    it("still returns tokens even when audit log throws", async () => {
      const dto = { username: "admin", password: "secret" } as any;
      const tokens = { accessToken: "at", refreshToken: "rt" };
      authSvc.login.mockResolvedValue(tokens);
      auditSvc.log.mockRejectedValue(new Error("DB down"));

      const result = await controller.login(dto, mockReq);

      expect(result).toEqual(tokens);
    });

    it("propagates auth service errors", async () => {
      authSvc.login.mockRejectedValue(new Error("invalid credentials"));
      await expect(
        controller.login({ username: "bad", password: "bad" } as any, mockReq),
      ).rejects.toThrow("invalid credentials");
    });

    // ─── P2-4（2026-10-25 审计）：失败路径补审计 ──────────────────────────
    // 此前 audit.log 只在 login 成功后执行，INVALID_USERNAME_OR_PASSWORD /
    // LOGIN_LOCKED / ACCOUNT_INACTIVE 等失败零记录，无法回答爆破/撞库溯源。
    // 注意：AppError 构造时原型挂到 NestJS 内置异常类（app-error.ts），
    // 断言按 errorCode / 对应异常类，不能 toThrow(AppError)。
    it("密码错（AppError 业务失败）→ 审计 failure 行（含 ip、不含密码）后原样上抛", async () => {
      authSvc.login.mockRejectedValue(
        new AppError("INVALID_USERNAME_OR_PASSWORD"),
      );
      await expect(
        controller.login(
          { username: "admin", password: "wrong-pass" } as any,
          mockReq,
        ),
      ).rejects.toMatchObject({ errorCode: "INVALID_USERNAME_OR_PASSWORD" });

      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "admin",
          action: "auth.login",
          resource: "auth",
          result: "failure",
          ip: "192.168.1.1",
          detail: expect.objectContaining({
            errorCode: "INVALID_USERNAME_OR_PASSWORD",
          }),
        }),
      );
      // 绝不落密码：整份审计载荷里不允许出现明文口令
      const payload = auditSvc.log.mock.calls[0][0] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain("wrong-pass");
      // 成功行未写（login 失败后不应继续走成功审计）
      expect(auditSvc.log).toHaveBeenCalledTimes(1);
    });

    it("锁定（LOGIN_LOCKED）→ 审计 failure 行，detail 带失败原因码", async () => {
      authSvc.login.mockRejectedValue(
        new AppError("LOGIN_LOCKED", { minutes: 3 }),
      );
      await expect(
        controller.login(
          { username: "admin", password: "secret" } as any,
          mockReq,
        ),
      ).rejects.toMatchObject({ errorCode: "LOGIN_LOCKED" });
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "auth.login",
          result: "failure",
          detail: expect.objectContaining({ errorCode: "LOGIN_LOCKED" }),
        }),
      );
    });

    it("非业务异常（无 errorCode 的普通 Error）不记登录失败审计（只记业务失败）", async () => {
      authSvc.login.mockRejectedValue(new Error("connection reset"));
      await expect(
        controller.login(
          { username: "admin", password: "secret" } as any,
          mockReq,
        ),
      ).rejects.toThrow("connection reset");
      expect(auditSvc.log).not.toHaveBeenCalled();
    });

    it("失败审计自身故障 → best-effort 吞掉（不掩盖原始错误）", async () => {
      authSvc.login.mockRejectedValue(
        new AppError("INVALID_USERNAME_OR_PASSWORD"),
      );
      auditSvc.log.mockRejectedValue(new Error("audit DB down"));
      await expect(
        controller.login({ username: "admin", password: "x" } as any, mockReq),
      ).rejects.toMatchObject({ errorCode: "INVALID_USERNAME_OR_PASSWORD" });
      expect(auditSvc.log).toHaveBeenCalledTimes(1);
    });

    it("成功路径的既有 success 行不变（无 result 字段 = success）", async () => {
      authSvc.login.mockResolvedValue({
        accessToken: "at",
        refreshToken: "rt",
      });
      await controller.login(
        { username: "admin", password: "secret" } as any,
        mockReq,
      );
      const payload = auditSvc.log.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.result).toBeUndefined();
    });
  });

  describe("refreshToken", () => {
    it("delegates to authService.refreshToken", () => {
      const newTokens = { accessToken: "new-at", refreshToken: "new-rt" };
      authSvc.refreshToken.mockResolvedValue(newTokens);

      const dto = { refreshToken: "old-rt" } as any;
      controller.refreshToken(dto, mockReq);

      expect(authSvc.refreshToken).toHaveBeenCalledWith(
        "old-rt",
        expect.objectContaining({ ip: "192.168.1.1" }),
      );
    });

    // REFRESH-META（审计 P2）：轮换必须把当前请求的 UA/IP 交给 service，
    // 否则新 refresh 行的设备/来源列恒为 null（会话列表排查失去依据）。
    it("REFRESH-META: 透传请求 UA/IP 给 service", () => {
      authSvc.refreshToken.mockResolvedValue({} as any);
      const req = {
        headers: { "user-agent": "pytest/1.0" },
        ip: "203.0.113.5",
      } as any;

      controller.refreshToken({ refreshToken: "rt" } as any, req);

      expect(authSvc.refreshToken).toHaveBeenCalledWith("rt", {
        userAgent: "pytest/1.0",
        ip: "203.0.113.5",
      });
    });
  });

  describe("logout", () => {
    it("revokes all tokens for user and logs audit", async () => {
      authSvc.revokeAllForUser.mockResolvedValue(undefined);

      const result = await controller.logout(adminUser, mockReq);

      expect(authSvc.revokeAllForUser).toHaveBeenCalledWith(1);
      expect(auditSvc.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          username: "admin",
          action: "auth.logout",
          resource: "auth",
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it("returns success even when audit log throws", async () => {
      authSvc.revokeAllForUser.mockResolvedValue(undefined);
      auditSvc.log.mockRejectedValue(new Error("DB timeout"));

      const result = await controller.logout(adminUser, mockReq);

      expect(result).toEqual({ success: true });
    });

    it("propagates revoke errors (does not swallow them)", async () => {
      authSvc.revokeAllForUser.mockRejectedValue(
        new Error("token store failure"),
      );
      await expect(controller.logout(adminUser, mockReq)).rejects.toThrow(
        "token store failure",
      );
    });
  });

  describe("getProfile", () => {
    it("returns the current user directly", () => {
      const result = controller.getProfile(adminUser);
      expect(result).toBe(adminUser);
    });
  });

  // R-22（DEEP_REVIEW 0ef3bbe）: login Swagger 文案与实际限流值同源。
  // 旧文案硬编码 "Max5 attempts per minute"，与 LOGIN_THROTTLE_LIMIT 实际值
  // （默认 20/min）漂移；现 description 内插同一常量。此处钉住「文案里的数字
  // == @Throttle 真正生效的 limit」，防再次漂移。
  describe("R-22: login Swagger 文案与实际限流值同源", () => {
    const SWAGGER_OPERATION_META = "swagger/apiOperation";
    const LIMIT_KEY = "THROTTLER:LIMITdefault";

    it("description 的 attempts/min 数字 = login 路由 @Throttle limit", () => {
      const handler = (
        AuthController.prototype as unknown as Record<string, unknown>
      ).login as object;
      const op = Reflect.getMetadata(SWAGGER_OPERATION_META, handler) as {
        description?: string;
      };
      const limit = Reflect.getMetadata(LIMIT_KEY, handler) as number;
      expect(op).toBeDefined();
      expect(typeof limit).toBe("number");
      expect(op.description).toContain(`每分钟最多 ${limit} 次尝试`);
      // 回归守卫：旧的硬编码 5/min 文案不得复现
      expect(op.description).not.toContain("Max5");
    });
  });
});
