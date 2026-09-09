import { Test } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "../auth.service";
import { UsersService } from "../../users/users.service";
import { RefreshToken } from "../entities/refresh-token.entity";
import * as bcrypt from "bcrypt";

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
      | "recordLoginFailure"
      | "resetLoginFailure"
      | "clearExpiredLock"
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, "sign" | "verify">>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let refreshTokenRepo: any;

  beforeEach(async () => {
    usersService = {
      findByUsername: jest.fn(),
      findById: jest.fn(),
      recordLoginFailure: jest.fn().mockResolvedValue(undefined),
      resetLoginFailure: jest.fn().mockResolvedValue(undefined),
      clearExpiredLock: jest.fn().mockResolvedValue(true),
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
      usersService.findById.mockResolvedValue(mockUser as any);
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

    it("throws if user is not found after token verification", async () => {
      jwtService.verify.mockReturnValue({
        sub: 99,
        username: "ghost",
        type: "refresh",
        jti: mockJti,
      } as any);
      usersService.findById.mockResolvedValue(null as any);
      await expect(service.refreshToken("valid-token")).rejects.toThrow(
        UnauthorizedException,
      );
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
      usersService.findById.mockResolvedValue(mockUser as any);
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
      usersService.findById.mockResolvedValue(mockUser as any);
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
      expect(usersService.findById).toHaveBeenCalledTimes(1);
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
      expect(usersService.findById).not.toHaveBeenCalled();
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("rejects an inactive user after consuming the token", async () => {
      usersService.findById.mockResolvedValue({
        ...mockUser,
        isActive: false,
      } as any);
      await expect(service.refreshToken("token")).rejects.toThrow(
        UnauthorizedException,
      );
      expect(refreshTokenRepo.update).toHaveBeenCalledTimes(1);
      expect(usersService.findById).toHaveBeenCalledWith(1);
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
      expect(usersService.findById).toHaveBeenCalledTimes(1);
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
        expect(usersService.findById).not.toHaveBeenCalled();
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
  });

  describe("cleanupExpiredTokens", () => {
    it("deletes tokens with expiresAt in the past", async () => {
      await service.cleanupExpiredTokens();
      expect(refreshTokenRepo.delete).toHaveBeenCalled();
    });
  });
});
