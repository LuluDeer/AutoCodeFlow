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
      "findByUsername" | "findById" | "recordLoginFailure" | "resetLoginFailure"
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
    it("returns new tokens for a valid refresh token without jti", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
      } as any);
      usersService.findById.mockResolvedValue(mockUser as any);
      const result = await service.refreshToken("valid-token");
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
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
      refreshTokenRepo.findOne.mockResolvedValue(null);
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
      refreshTokenRepo.findOne.mockResolvedValue({
        jti: mockJti,
        revoked: true,
      });
      await expect(service.refreshToken("revoked-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("SEC-02: token rotation — consumed token is immediately revoked before issuing new one", async () => {
      const record = { jti: mockJti, revoked: false };
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: mockJti,
      } as any);
      usersService.findById.mockResolvedValue(mockUser as any);
      refreshTokenRepo.findOne.mockResolvedValue(record);
      await service.refreshToken("good-token");
      // First save call should be the revocation of the old token
      expect(refreshTokenRepo.save).toHaveBeenCalledWith({
        jti: mockJti,
        revoked: true,
      });
    });
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
