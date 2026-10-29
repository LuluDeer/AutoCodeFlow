import { Test } from "@nestjs/testing";
import {
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "../auth.service";
import { UsersService } from "../../users/users.service";
import { RefreshToken } from "../entities/refresh-token.entity";
import { User } from "../../users/entities/user.entity";
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
  // R32-A4: TOTP 状态写入改走 users 表的列级 UPDATE（auth.service 注入 User 仓储）
  let userRepo: any;

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
    userRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
        { provide: getRepositoryToken(User), useValue: userRepo },
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
      const compareSpy = jest
        .spyOn(bcrypt, "compare")
        .mockResolvedValue(true as never);
      // 该 spy 在本文件内跨用例共享，先清计数再断言「本用例恰好一次」。
      compareSpy.mockClear();
      await expect(
        service.login({ username: "admin", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      // R10: an ACTIVE lock must not be cleared — only expired ones are.
      expect(usersService.clearExpiredLock).not.toHaveBeenCalled();
      // SEC-LOCK-TIMING: a locked account must NOT short-circuit before
      // bcrypt — otherwise its response time (<10ms) is distinguishable from
      // the unknown-user path (~100ms), enumerating "exists AND locked".
      expect(compareSpy).toHaveBeenCalledTimes(1);
    });

    // SEC-LOCK-TIMING（审计 P1-3）：锁定路径与「用户不存在」路径必须付出
    // 等价的 bcrypt 成本——两者都恰好一次 compare（不存在的用户比对
    // DUMMY_BCRYPT_HASH，锁定的用户比对真实 hash）。
    it("SEC-LOCK-TIMING: 锁定路径与未知用户路径的 bcrypt 次数一致（无时序预言机）", async () => {
      const compareSpy = jest.spyOn(bcrypt, "compare");

      usersService.findByUsername.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      } as any);
      compareSpy.mockClear();
      await expect(
        service.login({ username: "admin", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      const lockedCalls = compareSpy.mock.calls.length;

      usersService.findByUsername.mockResolvedValue(null);
      compareSpy.mockClear();
      await expect(
        service.login({ username: "nobody", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      const unknownCalls = compareSpy.mock.calls.length;

      expect(lockedCalls).toBe(1);
      expect(unknownCalls).toBe(lockedCalls);
    });

    it("SEC-LOCK-TIMING: 锁定期间不递增失败计数（不给锁窗续期）", async () => {
      usersService.findByUsername.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      } as any);
      jest.spyOn(bcrypt, "compare").mockResolvedValue(false as never);
      await expect(
        service.login({ username: "admin", password: "wrong" }),
      ).rejects.toThrow(/账号已锁定/);
      expect(usersService.recordLoginFailure).not.toHaveBeenCalled();
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

    /**
     * REFRESH-META（审计 P2，2026-10-17）：轮换必须保留会话的 UA/IP。
     *
     * 缺陷现场：`return this.generateTokens(user)` 不带 meta，轮换出的新
     * refresh_tokens 行 userAgent/ip 恒为 NULL。access token 只有 15 分钟，
     * 几乎所有活跃会话一天后都轮换过——GET /auth/sessions 的设备/来源列
     * 大面积变 null，异常登录排查失去依据。
     */
    it("REFRESH-META：新行继承被消费行的 UA/IP（会话列表不丢设备信息）", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: "valid-jti-uuid",
      } as any);
      refreshTokenRepo.findOne.mockResolvedValue({
        jti: "valid-jti-uuid",
        userId: 1,
        revoked: false,
        userAgent: "Mozilla/5.0 (original)",
        ip: "203.0.113.7",
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue(mockUser as any);

      await service.refreshToken("valid-token");

      const saved = refreshTokenRepo.save.mock.calls.at(-1)?.[0];
      expect(saved).toMatchObject({
        userAgent: "Mozilla/5.0 (original)",
        ip: "203.0.113.7",
      });
    });

    it("REFRESH-META：调用方显式传入的 UA/IP 优先于继承值", async () => {
      jwtService.verify.mockReturnValue({
        sub: 1,
        username: "admin",
        type: "refresh",
        jti: "valid-jti-uuid",
      } as any);
      refreshTokenRepo.findOne.mockResolvedValue({
        jti: "valid-jti-uuid",
        userAgent: "old-agent",
        ip: "10.0.0.1",
      } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue(mockUser as any);

      await service.refreshToken("valid-token", {
        userAgent: "new-agent",
        ip: "198.51.100.2",
      });

      const saved = refreshTokenRepo.save.mock.calls.at(-1)?.[0];
      expect(saved).toMatchObject({
        userAgent: "new-agent",
        ip: "198.51.100.2",
      });
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
        reason: new UnauthorizedException("刷新令牌已被吊销"),
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
        "刷新令牌已被吊销",
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
        "刷新令牌已被吊销",
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

  describe("refreshToken sessionVersion 比对（A-1）", () => {
    // A-1（R3-A 审计）: 改密/全量吊销 bump sessionVersion 后，改密前签发的
    // refresh token（ver 快照落后）不得再换出新 token——被窃 30 天链就此断掉。
    const consumedPayload = {
      sub: 1,
      username: "admin",
      type: "refresh",
      jti: mockJti,
    };

    it("ver 快照与库中 sessionVersion 失配（改密后旧 refresh）→ 401 且该链已被消费", async () => {
      jwtService.verify.mockReturnValue({ ...consumedPayload, ver: 0 } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue({
        ...mockUser,
        sessionVersion: 1, // 改密后 bump 过
      } as any);

      await expect(service.refreshToken("stale-refresh")).rejects.toThrow(
        new UnauthorizedException("会话已被吊销"),
      );
      // 轮换消费先行（DR-07 fail-closed）：该 jti 已被吊销，不再签发新对
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { jti: mockJti, revoked: false },
        { revoked: true },
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("ver 快照与库中 sessionVersion 一致（未改密）→ 正常轮换（回归）", async () => {
      jwtService.verify.mockReturnValue({ ...consumedPayload, ver: 3 } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue({
        ...mockUser,
        sessionVersion: 3,
      } as any);

      const result = await service.refreshToken("valid-refresh");
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });

    it("存量无 ver claim 的旧 refresh token → 兼容放行（与 access 侧同形态）", async () => {
      jwtService.verify.mockReturnValue(consumedPayload as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 1 });
      usersService.findByIdOrNull.mockResolvedValue({
        ...mockUser,
        sessionVersion: 9, // 旧令牌无 ver，不做比对
      } as any);

      await expect(
        service.refreshToken("legacy-refresh"),
      ).resolves.toHaveProperty("accessToken");
    });
  });

  // ─── REFRESH-REUSE（R32-A4 审计）：轮换重放的级联吊销 ─────────────────────
  // 现状测量：轮换消费是原子的（UPDATE ... WHERE revoked=false），并发重放
  // 只有一个赢家——这一点已有 DR-07 用例钉住。但**重放被拒之后**没有任何
  // 后续动作：被消费的 jti 是谁用过的、它换出的那条后继链还活着与否，代码
  // 一律不管。轮换的威胁模型恰恰是「同一枚 refresh 出现两次 = 其中一次来自
  // 窃取者」——此时窃取者往往已经换到了一对**全新的**有效令牌（那次请求
  // 就是赢家），而「拒绝第二次」只挡住了重复使用的那一次，挡不住已经换到
  // 手的新链。fail-closed 的做法是在检出重放时吊销该会话所属用户的全部活跃
  // refresh（含后继链）并 bump sessionVersion（在途 access 一并即刻失效）。
  describe("REFRESH-REUSE: 重放已消费的 refresh → 级联吊销", () => {
    const replayed = {
      sub: 1,
      username: "admin",
      type: "refresh",
      jti: mockJti,
    };

    it("检出重放（jti 行仍在但已 revoked）→ 401 + 吊销该用户全部活跃 refresh + bump 会话版本", async () => {
      jwtService.verify.mockReturnValue({ ...replayed } as any);
      // 原子消费影响 0 行 = 这枚 jti 已被消费（重放）或从未存在
      refreshTokenRepo.update.mockResolvedValue({ affected: 0 });
      // 行仍存在且 revoked=true ⇒ 命中的是「已消费」分支，不是「未知 jti」
      refreshTokenRepo.findOne.mockResolvedValue({
        jti: mockJti,
        userId: 3,
        revoked: true,
      });

      await expect(service.refreshToken("replayed-token")).rejects.toThrow(
        new UnauthorizedException("刷新令牌已被吊销"),
      );

      // 级联：吊销的是**行所属**用户（3），不是凭 JWT claim 的自报 sub（1）
      expect(usersService.bumpSessionVersion).toHaveBeenCalledWith(3);
      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { userId: 3, revoked: false },
        { revoked: true },
      );
      // 绝不签发：重放请求本身拿不到任何新令牌
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it("未知 jti（库中无行，如已被清理）→ 只 401，不做全量吊销（不扩大破坏面）", async () => {
      jwtService.verify.mockReturnValue({ ...replayed } as any);
      refreshTokenRepo.update.mockResolvedValue({ affected: 0 });
      refreshTokenRepo.findOne.mockResolvedValue(null);

      await expect(service.refreshToken("unknown-jti")).rejects.toThrow(
        new UnauthorizedException("刷新令牌已被吊销"),
      );
      expect(usersService.bumpSessionVersion).not.toHaveBeenCalled();
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe("cleanupExpiredTokens", () => {
    it("deletes tokens with expiresAt in the past", async () => {
      await service.cleanupExpiredTokens();
      expect(refreshTokenRepo.delete).toHaveBeenCalled();
    });

    // A-10（R3-A 审计）: 吊销即刻失效但行本身此前只随 expiresAt 清理——
    // 被吊销的行要滞留至多 30 天。追加「吊销满 7 天」清理（同一次 cron）。
    it("A-10: 同一 cron 内追加清理 revoked=true 且 createdAt<now-7d 的行", async () => {
      const before = Date.now();
      await service.cleanupExpiredTokens();

      const calls = refreshTokenRepo.delete.mock.calls as Array<
        [Record<string, unknown>]
      >;
      expect(calls).toHaveLength(2);
      const secondArg = calls[1][0];
      expect(secondArg).toEqual({
        revoked: true,
        createdAt: expect.anything(),
      });
      // LessThan 传的是 TypeORM FindOperator，取其内部 value（Date）比对
      const op = secondArg.createdAt as { value: unknown };
      const cutoff = new Date(op.value as Date).getTime();
      // 锚点是 createdAt（保留近一周吊销痕迹），容差 5s
      expect(cutoff).toBeLessThanOrEqual(before - 7 * 86_400_000 + 5_000);
      expect(cutoff).toBeGreaterThan(before - 7 * 86_400_000 - 60_000);
    });

    it("A-10: 第一段清理仍只按 expiresAt（回归）", async () => {
      await service.cleanupExpiredTokens();
      expect(refreshTokenRepo.delete).toHaveBeenNthCalledWith(1, {
        expiresAt: expect.anything(),
      });
    });

    // rt-5（CRON-GUARD）: @nestjs/schedule 的 cron 回调**不 await** 返回的
    // Promise —— 方法体抛错 = unhandledRejection → main.ts 的
    // gracefulFatalShutdown → 整实例 exit(1)（所有 API 一起 503）。
    // 两条断言缺一不可：不 reject（不杀进程）+ warn 带 cron 名（不静默吞）。
    it("rt-5: repo 抛错时 cron 入口不 reject，并 warn 出可定位的 cron 名", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      try {
        refreshTokenRepo.delete.mockRejectedValueOnce(
          new Error("connection terminated unexpectedly"),
        );
        await expect(service.cleanupExpiredTokens()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("auth.cleanupExpiredTokens"),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
