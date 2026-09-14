import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";
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
  });

  describe("refreshToken", () => {
    it("delegates to authService.refreshToken", () => {
      const newTokens = { accessToken: "new-at", refreshToken: "new-rt" };
      authSvc.refreshToken.mockResolvedValue(newTokens);

      const dto = { refreshToken: "old-rt" } as any;
      controller.refreshToken(dto);

      expect(authSvc.refreshToken).toHaveBeenCalledWith("old-rt");
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
      expect(op.description).toContain(`Max ${limit} attempts per minute`);
      // 回归守卫：旧的硬编码 5/min 文案不得复现
      expect(op.description).not.toContain("Max5");
    });
  });
});
