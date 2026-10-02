import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "../strategies/jwt.strategy";
import { AuthService } from "../auth.service";
import { AuthController } from "../auth.controller";
import { UsersService } from "../../users/users.service";
import { AuditService } from "../../audit/audit.service";

/**
 * A-2（R3-A 审计）: sid 断链接线专项——真实 validate → controller → service
 * 链路。既有 auth.totp-sessions.spec 只在 service 层直传 sid（listSessions(1,
 * "jti-b")），覆盖不了「validate 返回值丢 sid → req.user.sid 恒 null →
 * revoke-others 恒走 revokeAllForUser（把当前设备也登出）」的断链形态。
 *
 * 本文件把三段真件接起来：
 *   JwtStrategy.validate(payload) ── req.user ──▶ AuthController
 *     ── sidOf(req) ──▶ AuthService.revokeOtherSessions / listSessions
 * 断言当前会话（sid 对应行）在两条路径下都被**保留**而非误杀。
 */

const SESSION_JTI = "jti-current-device";
const OTHER_JTI = "jti-other-device";

describe("A-2 sid 断链接线（validate → controller → service）", () => {
  let usersService: {
    findById: jest.Mock;
    findByIdOrNull: jest.Mock;
    bumpSessionVersion: jest.Mock;
  };
  let jwtService: { sign: jest.Mock; verify: jest.Mock };
  let configService: { get: jest.Mock };
  let refreshTokenRepo: Record<string, jest.Mock>;
  let strategy: JwtStrategy;
  let controller: AuthController;

  beforeEach(() => {
    usersService = {
      findById: jest.fn(),
      findByIdOrNull: jest.fn().mockResolvedValue({
        id: 1,
        username: "alice",
        isActive: true,
        sessionVersion: 0,
      }),
      bumpSessionVersion: jest.fn().mockResolvedValue(undefined),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue("signed"),
      verify: jest.fn(),
    };
    configService = { get: jest.fn().mockReturnValue("secret") };
    refreshTokenRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn(),
      create: jest.fn((d) => d),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    strategy = new JwtStrategy(
      configService as unknown as ConfigService,
      usersService as unknown as UsersService,
    );
    const authService = new AuthService(
      usersService as unknown as UsersService,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
      refreshTokenRepo as never,
      // ARCH-31: cron Leader 门禁缺席 → null → 门禁不生效（单测装配先例）
      null,
    );
    controller = new AuthController(authService, {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);
  });

  const makeReq = (user: unknown) =>
    ({ headers: {}, ip: "127.0.0.1", user }) as never;

  it("真实 validate 产出带 sid 的主体 → revoke-others 保留当前会话（jti != sid）", async () => {
    // ① 真实 JwtStrategy.validate —— sid claim 必须出现在返回主体上
    const principal = await strategy.validate({
      sub: 1,
      username: "alice",
      type: "access",
      sid: SESSION_JTI,
      ver: 0,
    });
    expect((principal as { sid?: string }).sid).toBe(SESSION_JTI);

    // ② 真实 controller.revokeOtherSessions —— sidOf(req) 读 req.user.sid
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    refreshTokenRepo.createQueryBuilder.mockReturnValue(qb);

    const result = await controller.revokeOtherSessions(
      principal as never,
      makeReq(principal),
    );

    expect(result).toEqual({ revoked: 2 });
    // WHERE 条件排除当前 sid ⇒ 当前会话行不被吊销（「保留当前设备」的落点）
    expect(qb.where).toHaveBeenCalledWith(
      '"userId" = :userId AND "revoked" = false AND "jti" != :sid',
      { userId: 1, sid: SESSION_JTI },
    );
    // 不得退化为 revokeAllForUser（bump + 全量吊销 = 当前设备也被登出）
    expect(refreshTokenRepo.update).not.toHaveBeenCalled();
    expect(usersService.bumpSessionVersion).not.toHaveBeenCalled();
  });

  it("真实 listSessions 接线：sid 透传后当前行被标记 current=true", async () => {
    const principal = await strategy.validate({
      sub: 1,
      username: "alice",
      type: "access",
      sid: SESSION_JTI,
      ver: 0,
    });
    refreshTokenRepo.find.mockResolvedValue([
      {
        id: 11,
        jti: OTHER_JTI,
        createdAt: new Date(),
        expiresAt: null,
        revoked: false,
        userAgent: null,
        ip: null,
      },
      {
        id: 12,
        jti: SESSION_JTI,
        createdAt: new Date(),
        expiresAt: null,
        revoked: false,
        userAgent: null,
        ip: null,
      },
    ]);

    const rows = (await controller.listSessions(
      principal as never,
      makeReq(principal),
    )) as Array<{ id: number; current: boolean }>;

    expect(rows.find((r) => r.id === 11)).toMatchObject({ current: false });
    expect(rows.find((r) => r.id === 12)).toMatchObject({ current: true });
  });

  it("回归守卫：无 sid 的存量令牌仍 fail-safe（revoke-others 退化为全量吊销）", async () => {
    const principal = await strategy.validate({
      sub: 1,
      username: "alice",
      type: "access",
      ver: 0,
    });
    expect((principal as { sid?: string }).sid).toBeUndefined();

    await controller.revokeOtherSessions(
      principal as never,
      makeReq(principal),
    );

    expect(refreshTokenRepo.update).toHaveBeenCalledWith(
      { userId: 1, revoked: false },
      { revoked: true },
    );
    expect(refreshTokenRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("validate 的会话版本门在本链路上仍然生效（ver 失配 401）", async () => {
    usersService.findByIdOrNull.mockResolvedValue({
      id: 1,
      username: "alice",
      isActive: true,
      sessionVersion: 5,
    });
    await expect(
      strategy.validate({
        sub: 1,
        username: "alice",
        type: "access",
        sid: SESSION_JTI,
        ver: 0,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
