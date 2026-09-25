import { Test } from "@nestjs/testing";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "../auth.service";
import { UsersService } from "../../users/users.service";
import { RefreshToken } from "../entities/refresh-token.entity";
import bcrypt from "bcrypt";

const mockUser = {
  id: 1,
  username: "admin",
  password: "hashed",
  isActive: true,
};
const mockJti = "test-jti-uuid";

describe("AuthService (__tests__)", () => {
  let service: AuthService;
  let usersService: jest.Mocked<
    Pick<
      UsersService,
      | "findByUsername"
      | "findById"
      | "findByIdOrNull"
      | "recordLoginFailure"
      | "resetLoginFailure"
      | "clearExpiredLock"
      | "bumpSessionVersion"
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, "sign" | "verify">>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let refreshTokenRepo: any;

  beforeEach(async () => {
    usersService = {
      findByUsername: jest.fn(),
      // R-04: refreshToken 走 findByIdOrNull（null = 用户已删除）。findById
      // 保留为抛 404 的守卫桩：若实现回退到 findById，refreshToken 会以
      // NotFoundException（404）爆出而非 401，用例即红——钉住「401 而非
      // 404」的存在性泄漏语义。
      findById: jest.fn().mockImplementation((id: number) => {
        throw new NotFoundException(`User #${id} not found`);
      }),
      findByIdOrNull: jest.fn(),
      recordLoginFailure: jest.fn().mockResolvedValue(undefined),
      resetLoginFailure: jest.fn().mockResolvedValue(undefined),
      clearExpiredLock: jest.fn().mockResolvedValue(true),
      bumpSessionVersion: jest.fn().mockResolvedValue(undefined),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue("signed-token"),
      verify: jest.fn(),
    };
    configService = { get: jest.fn().mockReturnValue("secret") };
    refreshTokenRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((d) => d),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokenRepo,
        },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  // ─── A5：SSE 短效票据 ────────────────────────────────────────────────────
  describe("issueSseTicket (A5)", () => {
    const sseUser = { id: 7, username: "bob", sessionVersion: 2 };

    it("签发 type=sse_ticket、30s TTL 的票据，并带上 ver 会话版本快照", () => {
      const result = service.issueSseTicket(sseUser);

      expect(result.ticket).toBe("signed-token");
      const calls = jwtService.sign.mock.calls;
      const [payload, options] = calls[calls.length - 1] as [
        Record<string, unknown>,
        { expiresIn: string },
      ];
      expect(payload.type).toBe("sse_ticket");
      expect(payload.sub).toBe(7);
      expect(payload.username).toBe("bob");
      // 与 access token 共用 ver 快照 ⇒ 登出/改密后已签发票据同样即时失效
      expect(payload.ver).toBe(2);
      expect(payload.jti).toBeDefined();
      expect(options.expiresIn).toBe("30s");
    });

    it("A5 语义守卫：有效期必须远短于 access token（15m），否则本改动失去意义", () => {
      const before = Date.now();
      const { expiresAt } = service.issueSseTicket(sseUser);
      const ttlMs = new Date(expiresAt).getTime() - before;
      // 关键是上界：若有人把 TTL 抬回分钟级（等于把长效令牌重新写进 URL），
      // 此例必须转红——这正是 A5 要防的退化。
      expect(ttlMs).toBeGreaterThan(25_000);
      expect(ttlMs).toBeLessThan(60_000);
    });

    it("不落库、不触碰 refresh token 表（票据是派生物，不是会话）", () => {
      refreshTokenRepo.save.mockClear();
      service.issueSseTicket(sseUser);
      expect(refreshTokenRepo.save).not.toHaveBeenCalled();
      expect(refreshTokenRepo.create).not.toHaveBeenCalled();
    });
  });

  describe("login", () => {
    it("returns accessToken and refreshToken on valid credentials", async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      const result = await service.login({
        username: "admin",
        password: "pass",
      });
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(usersService.resetLoginFailure).toHaveBeenCalledWith(mockUser.id);
    });

    it("throws UnauthorizedException when user does not exist", async () => {
      usersService.findByUsername.mockResolvedValue(null);
      await expect(
        service.login({ username: "nobody", password: "x" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("F-4: runs bcrypt.compare against a dummy hash when user does not exist (timing equalization)", async () => {
      const compareSpy = jest
        .spyOn(bcrypt, "compare")
        .mockResolvedValue(false as never);
      compareSpy.mockClear(); // other tests in this file share the same spy
      usersService.findByUsername.mockResolvedValue(null);
      await expect(
        service.login({ username: "nobody", password: "x" }),
      ).rejects.toThrow(UnauthorizedException);
      // The compare must still happen (not short-circuited by user == null),
      // against the module's pre-computed dummy hash so the unknown-user path
      // costs the same bcrypt CPU time as the wrong-password path.
      expect(compareSpy).toHaveBeenCalledTimes(1);
      expect(compareSpy).toHaveBeenCalledWith(
        "x",
        expect.stringMatching(/^\$2[aby]\$12\$/),
      );
      expect(usersService.recordLoginFailure).not.toHaveBeenCalled();
    });

    it("throws UnauthorizedException on wrong password and increments failure counter", async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
      await expect(
        service.login({ username: "admin", password: "wrong" }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.recordLoginFailure).toHaveBeenCalledWith(
        mockUser.id,
        expect.any(Object),
      );
    });

    it("SEC-05: throws when account is locked", async () => {
      const lockedUser = {
        ...mockUser,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      };
      usersService.findByUsername.mockResolvedValue(lockedUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      await expect(
        service.login({ username: "admin", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      // R10: an ACTIVE lock must not be cleared — only expired ones are.
      expect(usersService.clearExpiredLock).not.toHaveBeenCalled();
    });

    // R10: after the lock window expires, the fail counter must be reset
    // BEFORE the password check — otherwise loginFailCount is still at
    // MAX_FAIL and one fresh failure re-locks instantly (permanent lockout).
    it("R10: expired lock + wrong password resets the counter before recording the new failure", async () => {
      const expiredLockUser = {
        ...mockUser,
        loginFailCount: 5,
        lockedUntil: new Date(Date.now() - 60_000), // window already passed
      };
      usersService.findByUsername.mockResolvedValue(expiredLockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
      await expect(
        service.login({ username: "admin", password: "wrong" }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.clearExpiredLock).toHaveBeenCalledWith(mockUser.id);
      // Ordering: the reset happens BEFORE recordLoginFailure, so the new
      // failure increments from 0 (1 < MAX_FAIL → no immediate re-lock).
      const resetCall = (usersService.clearExpiredLock as jest.Mock).mock
        .invocationCallOrder[0];
      const failCall = (usersService.recordLoginFailure as jest.Mock).mock
        .invocationCallOrder[0];
      expect(resetCall).toBeLessThan(failCall);
    });

    it("R10: expired lock + correct password logs in normally", async () => {
      const expiredLockUser = {
        ...mockUser,
        loginFailCount: 5,
        lockedUntil: new Date(Date.now() - 60_000),
      };
      usersService.findByUsername.mockResolvedValue(expiredLockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      const result = await service.login({
        username: "admin",
        password: "pass",
      });
      expect(result).toHaveProperty("accessToken");
      expect(usersService.clearExpiredLock).toHaveBeenCalledWith(mockUser.id);
      expect(usersService.resetLoginFailure).toHaveBeenCalledWith(mockUser.id);
    });

    it("R10: user without any lock never touches clearExpiredLock", async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      await service.login({ username: "admin", password: "pass" });
      expect(usersService.clearExpiredLock).not.toHaveBeenCalled();
    });

    it("SEC-05: throws when account is disabled (isActive=false)", async () => {
      const disabledUser = { ...mockUser, isActive: false };
      usersService.findByUsername.mockResolvedValue(disabledUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      await expect(
        service.login({ username: "admin", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("persists refresh token after successful login", async () => {
      usersService.findByUsername.mockResolvedValue(mockUser as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
      await service.login({ username: "admin", password: "pass" });
      expect(refreshTokenRepo.save).toHaveBeenCalled();
    });
  });

  describe("refreshToken", () => {
    it("returns new tokens for a valid refresh token with jti", async () => {
      // SEC-002: a refresh token must carry jti — without it the revocation
      // check would be skipped, bypassing token-rotation protection.
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: "valid-jti-uuid",
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue(mockUser as any);
      const result = await service.refreshToken("valid-token");
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });

    it("rejects refresh token without jti (SEC-002)", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
      } as any);
      await expect(service.refreshToken("old-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws if token type is not "refresh"', async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "access",
      } as any);
      await expect(service.refreshToken("bad-type-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("throws if jwt.verify throws", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error("expired");
      });
      await expect(service.refreshToken("expired-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // R-04: 已删除用户仍持有效 refresh token 时必须 401（UnauthorizedException），
    // 而非经 findById 泄漏 404 "User #N not found"（存在性 + 数字 id 泄漏）。
    it("R-04: deleted user (findByIdOrNull → null) gets 401, never the 404 from findById", async () => {
      jwtService.verify.mockReturnValue({
        sub: 99,
        username: "ghost",
        type: "refresh",
        jti: mockJti,
      } as any);
      usersService.findByIdOrNull.mockResolvedValue(null as any);
      await expect(service.refreshToken("valid-token")).rejects.toThrow(
        UnauthorizedException,
      );
      expect(usersService.findByIdOrNull).toHaveBeenCalledWith(99);
      // 404 泄漏面（findById）必须保持零调用
      expect(usersService.findById).not.toHaveBeenCalled();
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("SEC-02: throws when jti token record is not found in DB", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.refreshToken("unknown-jti-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("SEC-02: throws when jti token is already revoked", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.refreshToken("revoked-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("SEC-02: token rotation — consumed token is immediately revoked before issuing new one", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      } as any);
      usersService.findByIdOrNull.mockResolvedValue(mockUser as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      await service.refreshToken("good-token");
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { jti: mockJti, revoked: false },
        { revoked: true },
      );
    });
  });

  describe("DR-07 atomic consumption", () => {
    beforeEach(() => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      });
      usersService.findByIdOrNull.mockResolvedValue(mockUser as any);
    });

    it("allows only one concurrent refresh of the same jti", async () => {
      refreshTokenRepo.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });
      const generate = jest.spyOn(service as any, "generateTokens");
      const results = await Promise.allSettled([
        service.refreshToken("same-token"),
        service.refreshToken("same-token"),
      ]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: new UnauthorizedException("Refresh token has been revoked"),
      });
      expect(usersService.findByIdOrNull).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(refreshTokenRepo.update).toHaveBeenCalledTimes(2);
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { jti: mockJti, revoked: false },
        { revoked: true },
      );
    });

    it("rejects an undefined affected count without looking up the user", async () => {
      refreshTokenRepo.update.mockResolvedValue({ affected: undefined });
      await expect(service.refreshToken("token")).rejects.toThrow(
        "Refresh token has been revoked",
      );
      expect(usersService.findByIdOrNull).not.toHaveBeenCalled();
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("rejects an inactive user after consuming the token", async () => {
      usersService.findByIdOrNull.mockResolvedValue({
        ...mockUser,
        isActive: false,
      } as any);
      await expect(service.refreshToken("token")).rejects.toThrow(
        UnauthorizedException,
      );
      expect(refreshTokenRepo.update).toHaveBeenCalledTimes(1);
      expect(usersService.findByIdOrNull).toHaveBeenCalledWith(1);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("keeps the old token consumed if issuance fails", async () => {
      refreshTokenRepo.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ affected: 0 });
      jwtService.sign.mockImplementation(() => {
        throw new Error("signing failed");
      });
      await expect(service.refreshToken("token")).rejects.toThrow(
        "signing failed",
      );
      await expect(service.refreshToken("token")).rejects.toThrow(
        "Refresh token has been revoked",
      );
      expect(usersService.findByIdOrNull).toHaveBeenCalledTimes(1);
      expect(jwtService.sign).toHaveBeenCalledTimes(1);
    });

    it.each(["signature", "type", "jti"])(
      "rejects invalid %s before consumption",
      async (invalid) => {
        if (invalid === "signature") {
          jwtService.verify.mockImplementation(() => {
            throw new Error("expired");
          });
        } else {
          jwtService.verify.mockReturnValue({
            sub: 1,
            type: invalid === "type" ? "access" : "refresh",
            jti: invalid === "jti" ? undefined : mockJti,
          });
        }
        await expect(service.refreshToken("token")).rejects.toThrow(
          UnauthorizedException,
        );
        expect(refreshTokenRepo.update).not.toHaveBeenCalled();
        expect(usersService.findByIdOrNull).not.toHaveBeenCalled();
        expect(jwtService.sign).not.toHaveBeenCalled();
      },
    );
  });

  describe("revokeAllForUser", () => {
    it("SEC-02: marks all active refresh tokens as revoked", async () => {
      await service.revokeAllForUser(1);
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 1, revoked: false },
        { revoked: true },
      );
    });

    it("WIKI-AUTH-REVOC: logout 先原子 bump 会话版本再吊销 refresh（在途 access token 即刻失配 401）", async () => {
      await service.revokeAllForUser(1);
      expect(usersService.bumpSessionVersion).toHaveBeenCalledWith(1);
      // Ordering: bump happens BEFORE the refresh-token revocation — the
      // access-token surface is cut first; either order is correct, this
      // pins the implementation.
      const bumpCall = (usersService.bumpSessionVersion as jest.Mock).mock
        .invocationCallOrder[0];
      const revokeCall = (refreshTokenRepo.update as jest.Mock).mock
        .invocationCallOrder[0];
      expect(bumpCall).toBeLessThan(revokeCall);
    });
  });

  // WIKI-AUTH-REVOC: token 签发单点（login / refresh 汇聚 generateTokens）
  // 携带 ver = sessionVersion 签发时快照。
  describe("generateTokens ver claim (WIKI-AUTH-REVOC)", () => {
    it("login 签发的 access/refresh token 均携带 ver 快照", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...mockUser,
        sessionVersion: 3,
      } as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);

      await service.login({ username: "admin", password: "pass" });

      const accessCall = jwtService.sign.mock.calls.find(
        (c: any[]) => c[0]?.type === "access",
      );
      const refreshCall = jwtService.sign.mock.calls.find(
        (c: any[]) => c[0]?.type === "refresh",
      );
      expect(accessCall?.[0]).toMatchObject({ sub: 1, ver: 3 });
      expect(refreshCall?.[0]).toMatchObject({ sub: 1, ver: 3 });
    });

    it("refresh 轮换签发的新 token 携带最新 sessionVersion", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue({
        ...mockUser,
        sessionVersion: 7,
      } as any);

      await service.refreshToken("valid-token");

      const accessCall = jwtService.sign.mock.calls.find(
        (c: any[]) => c[0]?.type === "access",
      );
      expect(accessCall?.[0]).toMatchObject({ ver: 7 });
    });
  });

  describe("cleanupExpiredTokens", () => {
    it("deletes tokens with expiresAt in the past", async () => {
      await service.cleanupExpiredTokens();
      expect(refreshTokenRepo.delete).toHaveBeenCalled();
    });
  });
});
