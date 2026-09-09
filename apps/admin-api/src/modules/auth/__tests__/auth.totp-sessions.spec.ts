import { Test } from "@nestjs/testing";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "../auth.service";
import { UsersService } from "../../users/users.service";
import { RefreshToken } from "../entities/refresh-token.entity";
import * as bcrypt from "bcrypt";
import { hotp } from "../totp.util";

/**
 * SEC-03: TOTP opt-in flow + session management service tests.
 * Codes are generated with the same deterministic hotp() used in production
 * (fixed secret + known counter) — no real clock dependence.
 */
const FIXED_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC seed
const NOW_SECONDS = 1_800_000_000; // arbitrary fixed instant
const CURRENT_COUNTER = Math.floor(NOW_SECONDS / 30);

const goodCode = () => hotp(FIXED_SECRET, CURRENT_COUNTER);
const nextWindowCode = () => hotp(FIXED_SECRET, CURRENT_COUNTER + 1);
const badCode = () => {
  const c = goodCode();
  return c === "000000" ? "000001" : "000000";
};

const baseUser = {
  id: 1,
  username: "alice",
  password: "hashed",
  isActive: true,
  totpSecret: null as string | null,
  totpEnabled: false,
};

describe("AuthService — SEC-03 TOTP + sessions", () => {
  let service: AuthService;
  let usersService: jest.Mocked<
    Pick<
      UsersService,
      | "findByUsername"
      | "findById"
      | "findByIdRaw"
      | "recordLoginFailure"
      | "resetLoginFailure"
      | "clearExpiredLock"
      | "saveUser"
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, "sign" | "verify">>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let refreshTokenRepo: any;

  const makeUser = (over: Partial<typeof baseUser> = {}) => ({
    ...baseUser,
    ...over,
  });

  beforeEach(async () => {
    usersService = {
      findByUsername: jest.fn(),
      findById: jest
        .fn()
        .mockImplementation(async (id: number) => makeUser({ id })),
      findByIdRaw: jest
        .fn()
        .mockImplementation(async (id: number) => makeUser({ id })),
      recordLoginFailure: jest.fn().mockResolvedValue(undefined),
      resetLoginFailure: jest.fn().mockResolvedValue(undefined),
      clearExpiredLock: jest.fn().mockResolvedValue(true),
      saveUser: jest.fn().mockImplementation(async (u: any) => u),
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
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
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
    // SEC-03 determinism: pin the TOTP clock to a fixed instant so codes are
    // generated against a known counter (no global Date patching).
    (service as any).clock = () => NOW_SECONDS;
    jest.spyOn(bcrypt, "compare").mockResolvedValue(true as never);
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── login totpRequired branch ────────────────────────────────────────────

  describe("login with TOTP (SEC-03)", () => {
    it("returns { totpRequired: true } (200-contract) instead of tokens for TOTP-enabled users", async () => {
      usersService.findByUsername.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      const result = await service.login({ username: "alice", password: "p" });
      expect(result).toEqual({ totpRequired: true });
      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(refreshTokenRepo.save).not.toHaveBeenCalled();
    });

    it("keeps the token path unchanged for users without TOTP (backward compat)", async () => {
      usersService.findByUsername.mockResolvedValue(makeUser() as any);
      const result = await service.login({ username: "alice", password: "p" });
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });

    it("falls through to tokens when totpEnabled but secret missing (data drift safety)", async () => {
      usersService.findByUsername.mockResolvedValue(
        makeUser({ totpEnabled: true, totpSecret: null }) as any,
      );
      const result = await service.login({ username: "alice", password: "p" });
      expect(result).toHaveProperty("accessToken");
    });
  });

  // ─── totp verify login ────────────────────────────────────────────────────

  describe("totpVerifyLogin (SEC-03)", () => {
    const totpUser = () =>
      makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true });

    it("issues tokens for username+password+valid code", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      const result = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: goodCode(),
      });
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(usersService.resetLoginFailure).toHaveBeenCalledWith(1);
    });

    it("accepts a code from the adjacent ±1 window", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      const result = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: nextWindowCode(),
      });
      expect(result).toHaveProperty("accessToken");
    });

    it("rejects a wrong code and records a login failure (no brute-force bypass)", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: badCode(),
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.recordLoginFailure).toHaveBeenCalledWith(
        1,
        expect.any(Object),
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("rejects wrong password before even checking the code", async () => {
      jest.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "wrong",
          code: goodCode(),
        }),
      ).rejects.toThrow("Invalid credentials");
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("rejects verify for accounts without TOTP enabled (endpoint misuse)", async () => {
      usersService.findByUsername.mockResolvedValue(makeUser() as any);
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: goodCode(),
        }),
      ).rejects.toThrow("TOTP is not enabled");
    });
  });

  // ─── setup / enable / disable ─────────────────────────────────────────────

  describe("totpSetup/enable/disable (SEC-03)", () => {
    it("setup stages a base32 secret + otpauth URL without enabling", async () => {
      const result = await service.totpSetup(1);
      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(result.otpauthUrl).toContain("otpauth://totp/AutoCodeFlow:alice");
      expect(result.otpauthUrl).toContain(`secret=${result.secret}`);
      expect(usersService.saveUser).toHaveBeenCalledWith(
        expect.objectContaining({ totpSecret: result.secret }),
      );
      // enabled flag untouched by setup
      const saved = usersService.saveUser.mock.calls[0][0];
      expect(saved.totpEnabled).toBe(false);
    });

    it("setup refuses when TOTP is already enabled", async () => {
      usersService.findById.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      await expect(service.totpSetup(1)).rejects.toThrow(BadRequestException);
    });

    it("enable with a valid code flips totpEnabled=true (end-to-end: setup→enable→login requires verify→verify issues)", async () => {
      // stage
      usersService.findById.mockResolvedValue(makeUser() as any);
      const { secret } = await service.totpSetup(1);
      // enable with correct code derived from the staged secret
      const code = hotp(secret, CURRENT_COUNTER);
      await service.totpEnable(1, code);
      expect(usersService.saveUser).toHaveBeenLastCalledWith(
        expect.objectContaining({ totpEnabled: true }),
      );

      // login now demands the second factor
      usersService.findByUsername.mockResolvedValue(
        makeUser({ totpSecret: secret, totpEnabled: true }) as any,
      );
      const login = await service.login({ username: "alice", password: "p" });
      expect(login).toEqual({ totpRequired: true });

      // verify issues tokens
      const tokens = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: hotp(secret, CURRENT_COUNTER),
      });
      expect(tokens).toHaveProperty("accessToken");
    });

    it("enable with a wrong code fails and leaves the staged secret disabled", async () => {
      usersService.findById.mockImplementation(
        async (id: number) => makeUser({ id, totpSecret: FIXED_SECRET }) as any,
      );
      await expect(service.totpEnable(1, badCode())).rejects.toThrow(
        "Invalid TOTP code",
      );
      expect(usersService.saveUser).not.toHaveBeenCalled();
    });

    it("enable without a staged secret is rejected", async () => {
      usersService.findById.mockResolvedValue(makeUser() as any);
      await expect(service.totpEnable(1, goodCode())).rejects.toThrow(
        /No TOTP secret staged/,
      );
    });

    it("disable with the correct password clears secret and flag", async () => {
      usersService.findByIdRaw.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      const result = await service.totpDisable(1, { password: "pw" });
      expect(result).toEqual({ disabled: true });
      const saved = usersService.saveUser.mock.calls[0][0];
      expect(saved.totpEnabled).toBe(false);
      expect(saved.totpSecret).toBeNull();
    });

    it("disable with a valid TOTP code works (password optional)", async () => {
      usersService.findByIdRaw.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      const result = await service.totpDisable(1, { code: goodCode() });
      expect(result).toEqual({ disabled: true });
    });

    it("disable without valid confirmation is rejected (stolen JWT cannot turn 2FA off)", async () => {
      jest.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
      usersService.findByIdRaw.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      await expect(
        service.totpDisable(1, { password: "wrong", code: badCode() }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.saveUser).not.toHaveBeenCalled();
    });

    it("disable on a non-TOTP account is an idempotent no-op", async () => {
      usersService.findByIdRaw.mockResolvedValue(makeUser() as any);
      const result = await service.totpDisable(1, {});
      expect(result).toEqual({ disabled: false });
      expect(usersService.saveUser).not.toHaveBeenCalled();
    });
  });

  // ─── session management ───────────────────────────────────────────────────

  describe("sessions (SEC-03)", () => {
    const rows = [
      {
        id: 11,
        jti: "jti-a",
        createdAt: new Date("2026-09-01T10:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
        revoked: false,
        userAgent: "Mozilla/5.0",
        ip: "10.0.0.1",
        userId: 1,
      },
      {
        id: 12,
        jti: "jti-b",
        createdAt: new Date("2026-09-02T10:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
        revoked: false,
        userAgent: null,
        ip: null,
        userId: 1,
      },
    ];

    it("lists active sessions and flags the current one by sid", async () => {
      refreshTokenRepo.find.mockResolvedValue(rows);
      const list = await service.listSessions(1, "jti-b");
      expect(list).toHaveLength(2);
      expect(list.find((s) => s.id === 11)).toMatchObject({
        current: false,
        userAgent: "Mozilla/5.0",
        ip: "10.0.0.1",
      });
      expect(list.find((s) => s.id === 12)).toMatchObject({
        current: true,
        userAgent: null,
      });
    });

    it("queries only non-revoked rows of the owning user", async () => {
      refreshTokenRepo.find.mockResolvedValue([]);
      await service.listSessions(1, null);
      expect(refreshTokenRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.anything(),
          order: { createdAt: "DESC" },
        }),
      );
      const where = refreshTokenRepo.find.mock.calls[0][0].where;
      expect(JSON.stringify(where)).toContain("revoked");
    });

    it("revokes a single own session (DR-04 semantics: revoked=true)", async () => {
      await service.revokeSession(1, 11);
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { id: 11, userId: 1, revoked: false },
        { revoked: true },
      );
    });

    it("rejects revoking a session the user does not own", async () => {
      refreshTokenRepo.update.mockResolvedValue({ affected: 0 });
      await expect(service.revokeSession(1, 999)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("revoke-others keeps only the current sid", async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };
      refreshTokenRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.revokeOtherSessions(1, "jti-a");
      expect(result).toEqual({ revoked: 3 });
      expect(qb.where).toHaveBeenCalledWith(
        '"userId" = :userId AND "revoked" = false AND "jti" != :sid',
        { userId: 1, sid: "jti-a" },
      );
    });

    it("revoke-others without sid degenerates to revoke-all (fail-safe)", async () => {
      const result = await service.revokeOtherSessions(1, null);
      expect(result).toEqual({ revoked: -1 });
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 1, revoked: false },
        { revoked: true },
      );
    });

    it("generateTokens stamps session metadata and signs sid claim into the access token", async () => {
      usersService.findByUsername.mockResolvedValue(makeUser() as any);
      await service.login(
        { username: "alice", password: "p" },
        {
          userAgent: "UA-TEST",
          ip: "127.0.0.1",
        },
      );
      expect(refreshTokenRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: "UA-TEST", ip: "127.0.0.1" }),
      );
      // access token payload includes sid mirroring the refresh jti
      const accessCall = jwtService.sign.mock.calls.find(
        (c: any[]) => c[0]?.type === "access",
      );
      const refreshCall = jwtService.sign.mock.calls.find(
        (c: any[]) => c[0]?.type === "refresh",
      );
      expect((accessCall?.[0] as any)?.sid).toBe(
        (refreshCall?.[0] as any)?.jti,
      );
    });
  });
});
