import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, IsNull, Not } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { randomUUID } from "crypto";
import * as bcrypt from "bcrypt";
import { UsersService } from "../users/users.service";
import { LoginDto } from "./dto/login.dto";
import { JwtPayload } from "./strategies/jwt.strategy";
import { RefreshToken } from "./entities/refresh-token.entity";
import { generateTotpSecret, totpVerify, buildOtpauthUrl } from "./totp.util";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 TracingService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * F-4: bcrypt hash of a throw-away password, pre-computed offline (cost 12).
 * When the username does not exist we compare against this dummy hash so the
 * "user not found" path burns the same bcrypt CPU cost as the "wrong password"
 * path — otherwise response-time differences allow username enumeration
 * (SEC-05 intent; the previous `&&` short-circuit did not achieve it).
 */
const DUMMY_BCRYPT_HASH =
  "$2b$12$S9kPReHdJ9LbTYcwPzpe1eTNr.OfUdkFFoDqc6MiS0X7nFO76DFii";

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(RefreshToken)
    private refreshTokenRepo: Repository<RefreshToken>,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {}

  /** Max consecutive failures before lockout. */
  private static readonly MAX_FAIL = 5;
  /** Lockout duration in minutes. */
  private static readonly LOCK_MINUTES = 15;

  /**
   * SEC-03: clock source for TOTP verification (unix seconds). Kept as an
   * instance field so deterministic tests can pin the time instead of
   * monkey-patching the global Date.
   */
  private clock: () => number = () => Math.floor(Date.now() / 1000);

  async login(
    loginDto: LoginDto,
    meta?: { userAgent?: string | null; ip?: string | null },
  ) {
    const user = await this.usersService.findByUsername(loginDto.username);

    // SEC-003: check the lockout state BEFORE running bcrypt — if the account
    // is currently locked, fail fast without paying the bcrypt CPU cost and
    // without leaking whether the username exists.
    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Account locked. Try again in ${minutesLeft} minute(s).`,
      );
    }

    // R10: the lock window has expired — atomically reset the fail counter
    // BEFORE the password check. loginFailCount still sits at MAX_FAIL from
    // the original lockout, so without this a single fresh failure would
    // re-trip the threshold and re-lock for another full window (effectively
    // a permanent lockout for anyone who mistypes once after expiry). The
    // conditional UPDATE only clears a genuinely expired lock, so a
    // concurrent request cannot race a reset against an active window.
    if (user && user.lockedUntil) {
      await this.usersService.clearExpiredLock(user.id);
    }

    // F-4: always run the full bcrypt compare — for an unknown user compare
    // against a pre-computed dummy hash so both paths take the same time and
    // usernames cannot be enumerated via response timing.
    const passwordOk = await bcrypt.compare(
      loginDto.password,
      user != null ? user.password : DUMMY_BCRYPT_HASH,
    );

    if (!user || !passwordOk) {
      // SEC-05: increment failure counter and lock if threshold reached
      if (user) {
        await this.usersService.recordLoginFailure(user.id, {
          maxFail: AuthService.MAX_FAIL,
          lockMinutes: AuthService.LOCK_MINUTES,
        });
      }
      throw new UnauthorizedException("Invalid credentials");
    }

    // SEC-05: reject if account is disabled
    if (!user.isActive) {
      throw new UnauthorizedException("Account is disabled");
    }

    // SEC-05: successful login — reset failure counter
    await this.usersService.resetLoginFailure(user.id);

    // SEC-03: TOTP enabled users do NOT receive tokens from /auth/login.
    // Contract (documented in docs/api-reference.md): responds 200 with
    // { totpRequired: true } — the client must then call POST /auth/totp/verify.
    // 200 (not 401) so frontends cannot confuse a normal failure with the
    // second-factor challenge, and audit success is not doubled.
    if (user.totpEnabled && user.totpSecret) {
      return { totpRequired: true };
    }

    return this.generateTokens(user, meta);
  }

  /**
   * SEC-03: second-factor completion — re-validates username+password, then
   * verifies the TOTP code before issuing tokens. Failure counter semantics
   * mirror login() (recordLoginFailure on bad password/code) so the TOTP
   * step cannot be used to brute-force around lockout.
   */
  async totpVerifyLogin(dto: {
    username: string;
    password: string;
    code: string;
    meta?: { userAgent?: string | null; ip?: string | null };
  }) {
    const user = await this.usersService.findByUsername(dto.username);

    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Account locked. Try again in ${minutesLeft} minute(s).`,
      );
    }

    // R-05（DEEP_REVIEW 0ef3bbe）: align with login() — an expired lock must be
    // cleared BEFORE the password/TOTP check. Without this, a client that reaches
    // /auth/totp/verify directly (bypassing /auth/login, which already clears
    // expired locks) keeps loginFailCount stuck at MAX_FAIL, so ONE fresh failure
    // immediately re-locks for another full window. clearExpiredLock is a
    // conditional UPDATE that only resets a genuinely expired lock.
    if (user && user.lockedUntil) {
      await this.usersService.clearExpiredLock(user.id);
    }

    const passwordOk = await bcrypt.compare(
      dto.password,
      user != null ? user.password : DUMMY_BCRYPT_HASH,
    );

    if (!user || !passwordOk) {
      if (user) {
        await this.usersService.recordLoginFailure(user.id, {
          maxFail: AuthService.MAX_FAIL,
          lockMinutes: AuthService.LOCK_MINUTES,
        });
      }
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.isActive) {
      throw new UnauthorizedException("Account is disabled");
    }

    // Only meaningful for users who actually completed TOTP opt-in
    if (!user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException("TOTP is not enabled for this account");
    }

    const check = totpVerify(user.totpSecret, dto.code, this.clock());
    if (!check.valid) {
      await this.usersService.recordLoginFailure(user.id, {
        maxFail: AuthService.MAX_FAIL,
        lockMinutes: AuthService.LOCK_MINUTES,
      });
      throw new UnauthorizedException("Invalid TOTP code");
    }

    await this.usersService.resetLoginFailure(user.id);
    return this.generateTokens(user, dto.meta);
  }

  /**
   * SEC-03: stage a new TOTP secret (base32) + otpauth URL. The secret is
   * saved with totpEnabled=false (staged state) — it only becomes active
   * after a successful enable with a valid code. Calling setup again simply
   * re-stages a fresh secret.
   */
  async totpSetup(userId: number) {
    const user = await this.usersService.findById(userId);
    if (user.totpEnabled) {
      throw new BadRequestException("TOTP is already enabled");
    }
    const secret = generateTotpSecret();
    user.totpSecret = secret;
    await this.usersService.saveUser(user);
    return {
      secret,
      otpauthUrl: buildOtpauthUrl(secret, "AutoCodeFlow", user.username),
    };
  }

  /**
   * SEC-03: activate the staged secret after verifying one valid code.
   * Requires a previously staged secret (setup must have been called).
   */
  async totpEnable(userId: number, code: string) {
    const user = await this.usersService.findById(userId);
    if (user.totpEnabled) {
      throw new BadRequestException("TOTP is already enabled");
    }
    if (!user.totpSecret) {
      throw new BadRequestException(
        "No TOTP secret staged — call /auth/totp/setup first",
      );
    }
    const check = totpVerify(user.totpSecret, code, this.clock());
    if (!check.valid) {
      throw new BadRequestException("Invalid TOTP code");
    }
    user.totpEnabled = true;
    await this.usersService.saveUser(user);
    return { enabled: true };
  }

  /**
   * SEC-03: disable TOTP. Requires either the account password or a valid
   * TOTP code — a stolen JWT alone must not be able to turn 2FA off.
   * Returns true if TOTP was actually disabled, false when it was not on.
   */
  async totpDisable(
    userId: number,
    opts: { password?: string; code?: string },
  ): Promise<{ disabled: boolean }> {
    const user = await this.usersService.findByIdRaw(userId);
    if (!user) throw new UnauthorizedException("User not found");
    if (!user.totpEnabled) {
      // Idempotent semantics: disabling a disabled account is a no-op success
      return { disabled: false };
    }

    let confirmed = false;
    if (opts.code && user.totpSecret) {
      confirmed = totpVerify(user.totpSecret, opts.code, this.clock()).valid;
    } else if (opts.password) {
      confirmed = await bcrypt.compare(opts.password, user.password);
    }
    if (!confirmed) {
      throw new UnauthorizedException(
        "TOTP disable requires a valid password or TOTP code",
      );
    }

    user.totpEnabled = false;
    user.totpSecret = null;
    await this.usersService.saveUser(user);
    return { disabled: true };
  }

  async refreshToken(token: string) {
    let payload: JwtPayload & { type: string; jti?: string };
    try {
      // S2: verify using the dedicated refresh secret and require type='refresh'
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>("jwt.refreshSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (payload.type !== "refresh") {
      throw new UnauthorizedException("Invalid token type");
    }

    // SEC-002: a refresh token without jti is either an old-format token or a
    // hand-crafted token; both must be rejected — never silently skip the
    // revocation check (that would bypass token-rotation protection).
    if (!payload.jti) {
      throw new UnauthorizedException("Refresh token missing jti claim");
    }
    const result = await this.refreshTokenRepo.update(
      { jti: payload.jti, revoked: false },
      { revoked: true },
    );
    if (!result.affected) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }
    // DR-07: consume once before issuing; deliberately fail closed if user
    // validation or issuance fails, so the old token cannot be replayed.

    // R-04: findByIdOrNull — a deleted user's still-valid refresh token must
    // 401 here, never leak a 404 "User #N not found" via findById.
    const user = await this.usersService.findByIdOrNull(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException();
    return this.generateTokens(user);
  }

  /**
   * SEC-02: Revoke all active refresh tokens for a user (called on logout).
   *
   * WIKI-AUTH-REVOC: 同时原子 bump users.sessionVersion——该用户所有在途
   * access token 的 ver 快照随即与库中失配，jwt.strategy.validate() 即刻
   * 401（logout 后访问令牌即时失效，不再等自然过期）。bump 与 refresh 吊销
   * 的先后不影响正确性（先 bump 即先断 access 面）。原子自增、无读改写。
   * 注：revokeOtherSessions 保留当前会话的路径不经此处（bump 会误杀当前
   * access token），只有「全量吊销」语义才 bump。
   */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.usersService.bumpSessionVersion(userId);
    await this.refreshTokenRepo.update(
      { userId, revoked: false },
      { revoked: true },
    );
  }

  // ─── SEC-03: session management ────────────────────────────────────────────

  /**
   * List active (non-revoked, non-expired) refresh tokens for a user —
   * one row per logged-in session. `current` marks the row matching the
   * sid claim of the caller's access-token session (null when unknown).
   */
  async listSessions(userId: number, currentSid?: string | null) {
    const rows = await this.refreshTokenRepo.find({
      where: [
        { userId, revoked: false, expiresAt: Not(LessThan(new Date())) },
        { userId, revoked: false, expiresAt: IsNull() },
      ],
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => ({
      id: r.id,
      jti: r.jti,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      userAgent: r.userAgent ?? null,
      ip: r.ip ?? null,
      current: currentSid != null && r.jti === currentSid,
    }));
  }

  /**
   * Revoke a single session by refresh_tokens row id. Ownership is enforced
   * in the WHERE clause — a foreign sessionId yields NotFoundException.
   */
  async revokeSession(userId: number, sessionId: number): Promise<void> {
    const result = await this.refreshTokenRepo.update(
      { id: sessionId, userId, revoked: false },
      { revoked: true },
    );
    if (!result.affected) {
      throw new UnauthorizedException("Session not found or already revoked");
    }
  }

  /**
   * Revoke every session of the user except the caller's own (identified by
   * the sid claim embedded in the current access token). When no sid is
   * known this is equivalent to revoking all — never silently keeps unknown
   * sessions.
   */
  async revokeOtherSessions(
    userId: number,
    currentSid?: string | null,
  ): Promise<{ revoked: number }> {
    if (currentSid) {
      const result = await this.refreshTokenRepo
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revoked: true })
        .where('"userId" = :userId AND "revoked" = false AND "jti" != :sid', {
          userId,
          sid: currentSid,
        })
        .execute();
      return { revoked: result.affected ?? 0 };
    }
    await this.revokeAllForUser(userId);
    return { revoked: -1 }; // -1 = "all including current" sentinel
  }

  /**
   * Token issuance single point — login / TOTP second stage / refresh all
   * converge here, so any claim added to `base` reaches every issuance path.
   *
   * WIKI-AUTH-REVOC: token 额外携带 ver claim = user.sessionVersion（签发
   * 时刻快照），jwt.strategy.validate() 据此实现 logout/改密后的访问令牌
   * 即时撤销。调用方传入完整用户实体，sessionVersion 天然携带；个别调用
   * 方（单测桩）缺失该字段时 JSON 序列化落掉 undefined——等同存量「无
   * ver」令牌的兼容形态，生产实体经迁移 1790000000017 后恒有值。
   */
  private async generateTokens(
    user: { id: number; username: string; sessionVersion?: number },
    meta?: { userAgent?: string | null; ip?: string | null },
  ) {
    // S2: include 'type' claim and use separate secrets for access/refresh tokens
    const base: JwtPayload = {
      sub: user.id,
      username: user.username,
      // WIKI-AUTH-REVOC: 会话版本快照进 base payload——access/refresh 两类
      // token 同点携带；access 侧 validate() 消费，refresh 侧仅随行不校验
      // （refresh 校验走「吊销表 + 重新加载用户」，签发经本单点自然带新值）。
      ver: user.sessionVersion,
    };

    // SEC-02: attach a unique jti to each refresh token for revocation tracking
    const jti = randomUUID();

    const accessToken = this.jwtService.sign(
      { ...base, type: "access", sid: jti },
      { expiresIn: this.configService.get<string>("jwt.expiresIn") as any },
    );

    const refreshToken = this.jwtService.sign(
      { ...base, type: "refresh", jti },
      {
        secret: this.configService.get<string>("jwt.refreshSecret"),
        expiresIn: "30d",
      },
    );

    // SEC-02: persist the refresh token for future revocation checks
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await this.refreshTokenRepo.save(
      this.refreshTokenRepo.create({
        jti,
        userId: user.id,
        expiresAt,
        userAgent: meta?.userAgent ?? null,
        ip: meta?.ip ?? null,
      }),
    );

    return { accessToken, refreshToken };
  }

  /**
   * AUTH-04: OIDC SSO 令牌签发出口——与本地登录同一 generateTokens 通路
   * （同一 JWT 声明结构 / refresh 持久化 / 会话管理语义），仅入口不同：
   * SSO 身份已在 OidcService 完成 IdP 验签与账号定位，此处不再触密码面。
   */
  async issueTokensForOidcUser(
    user: { id: number; username: string },
    meta?: { userAgent?: string | null; ip?: string | null },
  ) {
    return this.generateTokens(user, meta);
  }

  /**
   * SEC-02: Daily cleanup of expired refresh token rows to keep the table lean.
   * Runs at 03:00 every day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredTokens(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    await this.refreshTokenRepo.delete({ expiresAt: LessThan(new Date()) });
  }
}
