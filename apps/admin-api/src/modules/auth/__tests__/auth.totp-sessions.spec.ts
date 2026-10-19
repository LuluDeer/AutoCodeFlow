import { Test } from "@nestjs/testing";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuthService } from "../auth.service";
import { UsersService } from "../../users/users.service";
import { RefreshToken } from "../entities/refresh-token.entity";
import { User } from "../../users/entities/user.entity";
import bcrypt from "bcrypt";
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
      | "bumpSessionVersion"
      | "consumeTotpCounter"
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, "sign" | "verify">>;
  let configService: jest.Mocked<Pick<ConfigService, "get">>;
  let refreshTokenRepo: any;
  // R32-A4: TOTP 状态写入改走 users 表的列级 UPDATE（auth.service 注入 User 仓储）
  let userRepo: any;

  const makeUser = (over: Record<string, any> = {}) => ({
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
      // WIKI-AUTH-REVOC: revoke-others without sid degenerates to
      // revokeAllForUser which now bumps the session version.
      bumpSessionVersion: jest.fn().mockResolvedValue(undefined),
      // NETOPT-5⑤: 默认占位成功（不改变存量用例语义），重放用例单独覆写
      consumeTotpCounter: jest.fn().mockResolvedValue(true),
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
    userRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };

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
    const totpUser = (over: Record<string, any> = {}) =>
      makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true, ...over });

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
      ).rejects.toThrow("用户名或密码错误");
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
      ).rejects.toThrow("该账号未启用 TOTP");
    });

    // R-05（DEEP_REVIEW 0ef3bbe）: the TOTP second-factor path must mirror
    // login()'s R10 behavior — clear an EXPIRED lock before any failure is
    // recorded, otherwise a non-UI client that calls /auth/totp/verify
    // directly keeps loginFailCount stuck at MAX_FAIL and one fresh failure
    // immediately re-locks for another 15-minute window.
    it("R-05: expired lock + wrong TOTP code clears the lock BEFORE recording the new failure", async () => {
      usersService.findByUsername.mockResolvedValue(
        totpUser({
          loginFailCount: 5,
          lockedUntil: new Date(Date.now() - 60_000),
        }) as any,
      );
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: badCode(),
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.clearExpiredLock).toHaveBeenCalledWith(1);
      const resetCall = (usersService.clearExpiredLock as jest.Mock).mock
        .invocationCallOrder[0];
      const failCall = (usersService.recordLoginFailure as jest.Mock).mock
        .invocationCallOrder[0];
      expect(resetCall).toBeLessThan(failCall);
    });

    it("R-05: an ACTIVE lock is fast-failed without touching clearExpiredLock", async () => {
      usersService.findByUsername.mockResolvedValue(
        totpUser({
          lockedUntil: new Date(Date.now() + 10 * 60_000),
        }) as any,
      );
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: goodCode(),
        }),
      ).rejects.toThrow(/账号已锁定/);
      expect(usersService.clearExpiredLock).not.toHaveBeenCalled();
      expect(usersService.recordLoginFailure).not.toHaveBeenCalled();
    });

    it("R-05: expired lock + valid credentials clears the lock on the TOTP path too", async () => {
      usersService.findByUsername.mockResolvedValue(
        totpUser({
          loginFailCount: 5,
          lockedUntil: new Date(Date.now() - 60_000),
        }) as any,
      );
      const result = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: goodCode(),
      });
      expect(result).toHaveProperty("accessToken");
      expect(usersService.clearExpiredLock).toHaveBeenCalledWith(1);
    });

    it("R-05: user without any lock never touches clearExpiredLock on the TOTP path", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: goodCode(),
      });
      expect(usersService.clearExpiredLock).not.toHaveBeenCalled();
    });

    // ── NETOPT-5⑤: TOTP 重放防护 ──────────────────────────────────────
    it("replay: the SAME counter can only be consumed once (second attempt 401)", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      // 第一次占位成功，第二次（同 counter，即重放/并发占位失败）affected=0
      usersService.consumeTotpCounter
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const first = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: goodCode(),
      });
      expect(first).toHaveProperty("accessToken");

      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: goodCode(),
        }),
      ).rejects.toThrow("TOTP 验证码错误");
      // 第二次按无效码同形态记账：不能靠重放绕过锁定
      expect(usersService.recordLoginFailure).toHaveBeenCalledTimes(1);
      expect(usersService.resetLoginFailure).toHaveBeenCalledTimes(1);
    });

    it("advances: a HIGHER counter (next window) still passes after consumption", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      // 占位始终成功——单调递增的更高 counter 放行
      usersService.consumeTotpCounter.mockResolvedValue(true);

      await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: goodCode(),
      });
      const second = await service.totpVerifyLogin({
        username: "alice",
        password: "p",
        code: nextWindowCode(),
      });
      expect(second).toHaveProperty("accessToken");
      // 消费的是 totpVerify 命中的窗口 counter（当前窗口与 +1 窗口）
      expect(usersService.consumeTotpCounter).toHaveBeenNthCalledWith(
        1,
        1,
        CURRENT_COUNTER,
      );
      expect(usersService.consumeTotpCounter).toHaveBeenNthCalledWith(
        2,
        1,
        CURRENT_COUNTER + 1,
      );
    });

    it("users WITHOUT TOTP never touch the counter consumption (column stays NULL)", async () => {
      usersService.findByUsername.mockResolvedValue(makeUser() as any);
      await service.login({ username: "alice", password: "p" });
      expect(usersService.consumeTotpCounter).not.toHaveBeenCalled();
    });

    it("concurrent placeholder race: loser is rejected like an invalid code", async () => {
      usersService.findByUsername.mockResolvedValue(totpUser() as any);
      // 并发语义由 SQL 条件保证：两个同 counter 请求只有一个 affected=1
      usersService.consumeTotpCounter.mockResolvedValue(false);
      await expect(
        service.totpVerifyLogin({
          username: "alice",
          password: "p",
          code: goodCode(),
        }),
      ).rejects.toThrow("TOTP 验证码错误");
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  // ─── setup / enable / disable ─────────────────────────────────────────────

  describe("totpSetup/enable/disable (SEC-03)", () => {
    it("setup stages a base32 secret + otpauth URL without enabling", async () => {
      const result = await service.totpSetup(1);
      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(result.otpauthUrl).toContain("otpauth://totp/AutoCodeFlow:alice");
      expect(result.otpauthUrl).toContain(`secret=${result.secret}`);
      // R32-A4: 列级写入——只碰 totpSecret，不整行回写
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        { totpSecret: result.secret },
      );
      // enabled flag untouched by setup
      const patch = userRepo.update.mock.calls[0][1];
      expect(Object.keys(patch)).toEqual(["totpSecret"]);
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
      // R32-A4: setup 改走列级 UPDATE（不再就地改实体），桩需要模拟「已落库」
      usersService.findById.mockResolvedValue(
        makeUser({ totpSecret: secret }) as any,
      );
      // enable with correct code derived from the staged secret
      const code = hotp(secret, CURRENT_COUNTER);
      await service.totpEnable(1, code);
      expect(userRepo.update).toHaveBeenLastCalledWith(
        { id: 1 },
        { totpEnabled: true },
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
        "TOTP 验证码错误",
      );
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it("enable without a staged secret is rejected", async () => {
      usersService.findById.mockResolvedValue(makeUser() as any);
      await expect(service.totpEnable(1, goodCode())).rejects.toThrow(
        /尚未暂存 TOTP 密钥/,
      );
    });

    it("disable with the correct password clears secret and flag", async () => {
      usersService.findByIdRaw.mockResolvedValue(
        makeUser({ totpSecret: FIXED_SECRET, totpEnabled: true }) as any,
      );
      const result = await service.totpDisable(1, { password: "pw" });
      expect(result).toEqual({ disabled: true });
      // R32-A4: 两列同时清空——单条列级 UPDATE，不整行回写
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        { totpEnabled: false, totpSecret: null },
      );
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
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it("disable on a non-TOTP account is an idempotent no-op", async () => {
      usersService.findByIdRaw.mockResolvedValue(makeUser() as any);
      const result = await service.totpDisable(1, {});
      expect(result).toEqual({ disabled: false });
      expect(userRepo.update).not.toHaveBeenCalled();
    });
  });

  // ─── R32-A4: TOTP 状态写入的列级语义（整行回写 → 并发状态回滚）──────────
  /**
   * 缺陷现场（R32-A4 审计）：setup / enable / disable 此前都走
   * `usersService.saveUser(user)`——user 是方法开头读到的**整行快照**。
   * TypeORM 的 `save` 没有脏检查：实体上带值的列（password / isActive /
   * role / sessionVersion / loginFailCount / lockedUntil / lastTotpCounter）
   * 会被原样写回。于是「读快照 → 另一条路径（logout bump sessionVersion /
   * 管理员改密 / 禁用账号）落库 → 本行整行回写」会把那些变更**静默回滚**：
   *   · sessionVersion 回退 ⇒ 已吊销的 access token 重新可用（ver 又匹配）；
   *   · isActive 回退 ⇒ 管理员刚做的禁用被撤销（账号逃逸隔离）；
   *   · password 回退 ⇒ 刚改的密码被旧哈希覆盖。
   * 修复：只写 totpSecret / totpEnabled 两列（列级 UPDATE）。
   */
  describe("TOTP 状态写入的列级语义（R32-A4）", () => {
    let dbRow: Record<string, any>;
    /**
     * 模拟「读快照 → 并发写入落库」：返回快照后立刻把库里的值改掉，模拟
     * 另一条路径（logout / 改密 / 禁用）在读与写之间完成。
     */
    const snapshotting = () =>
      jest.fn(async () => {
        const snapshot = { ...dbRow };
        dbRow.sessionVersion = snapshot.sessionVersion + 1;
        dbRow.password = "hash-rotated";
        dbRow.isActive = false;
        return snapshot as unknown as User;
      });

    beforeEach(() => {
      dbRow = {
        id: 1,
        username: "alice",
        password: "hash-original",
        role: "user",
        isActive: true,
        loginFailCount: 0,
        lockedUntil: null,
        totpSecret: FIXED_SECRET,
        totpEnabled: true,
        sessionVersion: 4,
        lastTotpCounter: null,
      };
      usersService.findByIdRaw.mockImplementation(snapshotting());
      usersService.findById.mockImplementation(snapshotting());
      // TypeORM save 的等价物：整行合并回库
      usersService.saveUser.mockImplementation(async (u: any) => {
        Object.assign(dbRow, u);
        return u;
      });
      // 列级 UPDATE 的等价物：只合并 patch 里出现的列
      userRepo.update.mockImplementation(async (_criteria: any, patch: any) => {
        Object.assign(dbRow, patch);
        return { affected: 1 };
      });
    });

    it("disable 不得回滚并发的 sessionVersion / 密码 / 禁用状态", async () => {
      await service.totpDisable(1, { password: "pw" });

      expect(dbRow.sessionVersion).toBe(5); // 并发 bump 未被回滚
      expect(dbRow.password).toBe("hash-rotated"); // 改密未被回滚
      expect(dbRow.isActive).toBe(false); // 禁用未被回滚
      // 目标列仍然生效
      expect(dbRow.totpEnabled).toBe(false);
      expect(dbRow.totpSecret).toBeNull();
      // 绝不再走整行回写（回归即红）
      expect(usersService.saveUser).not.toHaveBeenCalled();
    });

    it("setup 只写 totpSecret 一列（会话版本等其它列原样保留）", async () => {
      dbRow.totpEnabled = false;
      dbRow.totpSecret = null;

      const { secret } = await service.totpSetup(1);

      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        { totpSecret: secret },
      );
      expect(Object.keys(userRepo.update.mock.calls[0][1])).toEqual([
        "totpSecret",
      ]);
      expect(dbRow.sessionVersion).toBe(5);
      expect(dbRow.isActive).toBe(false);
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
