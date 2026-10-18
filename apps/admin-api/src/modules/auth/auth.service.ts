import { Injectable, Optional } from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, IsNull, Not } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { randomUUID } from "crypto";
import * as bcrypt from "bcrypt";
import { UsersService } from "../users/users.service";
import { LoginDto } from "./dto/login.dto";
import { JwtPayload, SSE_TICKET_TTL_SECONDS } from "./strategies/jwt.strategy";
import { SseTicketResponseDto } from "./dto/sse-ticket.dto";
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

    // SEC-003（原始意图）+ SEC-LOCK-TIMING（审计 P1-3，2026-10-17）：
    //
    // 锁定时**不**再提前 return。原实现把「账户是否锁定」放在 bcrypt 之前
    // 快速失败（为了省 CPU），代价是这条路径**完全跳过 bcrypt**：
    //   · 锁定账户  →  <10ms 返回 LOGIN_LOCKED
    //   · 不存在的用户 → ~100ms（DUMMY_BCRYPT_HASH 的 compare 照跑）
    // 响应时间的量级差异把「用户名是否存在且当前被锁」变成可直接探测的
    // 预言机——正是 SEC-05/F-4 花力气抹平的同一类泄漏，只是从「用户存在
    // 与否」缩小到「用户存在且已锁定」。
    //
    // 现在锁定判定移到 bcrypt **之后**：所有失败路径（不存在 / 密码错 /
    // 已锁定）都付一次等价的 bcrypt 成本。锁定账户即使密码正确也仍被拒
    // （LOCKED 优先于签发），安全语义不变，只是不再以 CPU 时间为代价换
    // 时序侧信道。
    //
    // R10: 锁窗已过期时先原子清计数，再走密码校验——否则 loginFailCount
    // 仍停在 MAX_FAIL，一次新失败会立刻重新锁满一整窗（等价永久锁死）。
    // 条件 UPDATE 只清「确实已过期」的锁，并发请求无法把活跃窗口竞态清掉。
    //
    // SEC-LOCK-TIMING: 只对**已过期**的锁发这条 UPDATE。活跃锁若也发，每次
    // 被拒的尝试都会多一次 DB 写（放大成本，且与「未知用户」路径的写次数
    // 不同——那正是时序差本身）。下面这个纯内存判定不改变任何写行为。
    if (user && user.lockedUntil && user.lockedUntil <= new Date()) {
      await this.usersService.clearExpiredLock(user.id);
    }

    // F-4: always run the full bcrypt compare — for an unknown user compare
    // against a pre-computed dummy hash so both paths take the same time and
    // usernames cannot be enumerated via response timing.
    const passwordOk = await bcrypt.compare(
      loginDto.password,
      user != null ? user.password : DUMMY_BCRYPT_HASH,
    );

    // SEC-LOCK-TIMING: 锁判定移到 bcrypt 之后（见上）。**先于**密码结果的
    // 处理——锁定期间不递增计数（否则每次尝试都在给窗口续期），也不泄露
    // 密码是否正确。
    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new AppError("LOGIN_LOCKED", { minutes: minutesLeft });
    }

    if (!user || !passwordOk) {
      // SEC-05: increment failure counter and lock if threshold reached
      if (user) {
        await this.usersService.recordLoginFailure(user.id, {
          maxFail: AuthService.MAX_FAIL,
          lockMinutes: AuthService.LOCK_MINUTES,
        });
      }
      throw new AppError("INVALID_USERNAME_OR_PASSWORD");
    }

    // SEC-05: reject if account is disabled
    if (!user.isActive) {
      throw new AppError("ACCOUNT_INACTIVE");
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

    // R-05（DEEP_REVIEW 0ef3bbe）: align with login() — an expired lock must be
    // cleared BEFORE the password/TOTP check. Without this, a client that reaches
    // /auth/totp/verify directly (bypassing /auth/login, which already clears
    // expired locks) keeps loginFailCount stuck at MAX_FAIL, so ONE fresh failure
    // immediately re-locks for another full window. clearExpiredLock is a
    // conditional UPDATE that only resets a genuinely expired lock.
    // SEC-LOCK-TIMING: 只对已过期的锁发（活跃锁跳过，避免写放大与时序差）。
    if (user && user.lockedUntil && user.lockedUntil <= new Date()) {
      await this.usersService.clearExpiredLock(user.id);
    }

    const passwordOk = await bcrypt.compare(
      dto.password,
      user != null ? user.password : DUMMY_BCRYPT_HASH,
    );

    // SEC-LOCK-TIMING（审计 P1-3）：与 login() 同款——锁判定放在 bcrypt
    // **之后**，让「锁定 / 密码错 / 用户不存在」三条失败路径付出等价的
    // bcrypt 成本，不再用响应时间区分「该用户名存在且已锁定」。
    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new AppError("LOGIN_LOCKED", { minutes: minutesLeft });
    }

    if (!user || !passwordOk) {
      if (user) {
        await this.usersService.recordLoginFailure(user.id, {
          maxFail: AuthService.MAX_FAIL,
          lockMinutes: AuthService.LOCK_MINUTES,
        });
      }
      throw new AppError("INVALID_USERNAME_OR_PASSWORD");
    }

    if (!user.isActive) {
      throw new AppError("ACCOUNT_INACTIVE");
    }

    // Only meaningful for users who actually completed TOTP opt-in
    if (!user.totpEnabled || !user.totpSecret) {
      throw new AppError("TOTP_NOT_ENABLED");
    }

    const check = totpVerify(user.totpSecret, dto.code, this.clock());
    if (!check.valid) {
      await this.usersService.recordLoginFailure(user.id, {
        maxFail: AuthService.MAX_FAIL,
        lockMinutes: AuthService.LOCK_MINUTES,
      });
      throw new AppError("INVALID_TOTP_CODE");
    }

    // NETOPT-5⑤: TOTP 重放防护。totpVerify 命中的 counter 此前零消费——
    // 同一 6 位码在 ±1 步（约 90s）窗口内可反复通过第二因子。现原子占位
    // （lastTotpCounter 为 NULL 或更小才放行并写入，UsersService.consumeTotpCounter）：
    // 占位失败 = 重放或并发占位，按无效码同形态拒绝（同文案不泄露「码其实
    // 有效」，失败计数口径一致——重放尝试同样不能绕过锁定）。
    const matched = check.matchedCounter;
    const consumed =
      matched !== undefined &&
      (await this.usersService.consumeTotpCounter(user.id, matched));
    if (!consumed) {
      await this.usersService.recordLoginFailure(user.id, {
        maxFail: AuthService.MAX_FAIL,
        lockMinutes: AuthService.LOCK_MINUTES,
      });
      throw new AppError("INVALID_TOTP_CODE");
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
      throw new AppError("TOTP_SETUP_ALREADY_ENABLED");
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
    // NETOPT-5⑤: enable 不消费 lastTotpCounter——一次性启用由 totpEnabled
    // 标志守门（重放同一码无收益：启用后 setup 拒绝、enable 也拒绝），
    // 且此处消费会给「刚启用就登录」制造无谓的占位争用。
    const user = await this.usersService.findById(userId);
    if (user.totpEnabled) {
      throw new AppError("TOTP_SETUP_ALREADY_ENABLED");
    }
    if (!user.totpSecret) {
      throw new AppError("TOTP_SECRET_MISSING");
    }
    const check = totpVerify(user.totpSecret, code, this.clock());
    if (!check.valid) {
      throw new AppError("TOTP_ENABLE_CODE_INVALID");
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
    // NETOPT-5⑤: disable 也不消费 lastTotpCounter——这是已登录会话内的
    // 操作，且合法序列「同码先登录（占位 counter C）后关闭 2FA（同窗口
    // 的码 counter 也是 C）」会被单调递增防线误伤，把用户锁在 2FA 关闭
    // 流程之外。风险面（需已持有有效 JWT）与重放收益不成比例。
    const user = await this.usersService.findByIdRaw(userId);
    if (!user) throw new AppError("USER_NOT_FOUND");
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
      throw new AppError("TOTP_DISABLE_CONFIRMATION_REQUIRED");
    }

    user.totpEnabled = false;
    user.totpSecret = null;
    await this.usersService.saveUser(user);
    return { disabled: true };
  }

  async refreshToken(
    token: string,
    meta?: { userAgent?: string | null; ip?: string | null },
  ) {
    let payload: JwtPayload & { type: string; jti?: string };
    try {
      // S2: verify using the dedicated refresh secret and require type='refresh'
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>("jwt.refreshSecret"),
      });
    } catch {
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    if (payload.type !== "refresh") {
      throw new AppError("REFRESH_TOKEN_TYPE_INVALID");
    }

    // SEC-002: a refresh token without jti is either an old-format token or a
    // hand-crafted token; both must be rejected — never silently skip the
    // revocation check (that would bypass token-rotation protection).
    if (!payload.jti) {
      throw new AppError("REFRESH_TOKEN_MISSING_JTI");
    }
    // REFRESH-META（审计 P2）：先读回被消费的那一行——它携带这条会话签发
    // 时刻的 userAgent/ip 快照，轮换后的新行要继承（否则会话列表的设备/IP
    // 列在第一次轮换后就变成 null，异常登录排查失去依据）。
    // 读在 UPDATE 之前：UPDATE 只置 revoked，行本身不删，但先读更直白。
    const previous = await this.refreshTokenRepo.findOne({
      where: { jti: payload.jti, revoked: false },
    });
    const result = await this.refreshTokenRepo.update(
      { jti: payload.jti, revoked: false },
      { revoked: true },
    );
    if (!result.affected) {
      throw new AppError("REFRESH_TOKEN_REVOKED");
    }
    // DR-07: consume once before issuing; deliberately fail closed if user
    // validation or issuance fails, so the old token cannot be replayed.

    // R-04: findByIdOrNull — a deleted user's still-valid refresh token must
    // 401 here, never leak a 404 "User #N not found" via findById.
    const user = await this.usersService.findByIdOrNull(payload.sub);
    if (!user || !user.isActive) throw new AppError("REFRESH_TOKEN_INVALID");
    // A-1（R3-A 审计）: refresh 链同样比对会话版本——改密 / 全量吊销语义
    // （bumpSessionVersion）后，改密前签发的 refresh token 的 ver 快照与库中
    // 当前值失配 → 401。轮换消费（上方原子 UPDATE）已先行吊销该 jti 且不再
    // 签发新对（DR-07 fail-closed），被窃的 30 天 refresh 链就此断掉——此前
    // 该链在改密后仍可无限续换新 access token。存量无 ver claim 的旧令牌
    // 维持「到期自然失效」兼容语义（与 jwt.strategy 的 access 侧比对同形态），
    // 正常未改密流程 ver 恒等，零影响。
    if (payload.ver !== undefined && payload.ver !== user.sessionVersion) {
      throw new AppError("SESSION_REVOKED");
    }
    // REFRESH-META（审计 P2，2026-10-17）：轮换后保留原会话的 UA/IP。
    //
    // 缺陷现场：refreshToken() 直接 `return this.generateTokens(user)` —— 不带
    // meta，于是轮换出来的新 refresh_tokens 行 userAgent/ip 恒为 NULL。而
    // access token 只有 15 分钟，**几乎所有活跃会话**在登录一天后都已轮换过
    // 至少一次：GET /auth/sessions 的「设备 / 来源 IP」列大面积变成 null，
    // 异常登录排查（"这条会话来自哪个 IP"）直接失去依据。
    //
    // 修复：从被消费的那一行继承 userAgent/ip（它就是这条会话的签发快照），
    // 调用方显式传入时以其为准（controller 现在传当前请求的 UA/IP）。
    return this.generateTokens(user, {
      userAgent: meta?.userAgent ?? previous?.userAgent ?? null,
      ip: meta?.ip ?? previous?.ip ?? null,
    });
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
      throw new AppError("SESSION_NOT_FOUND");
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
  /**
   * A5（DEEP_REVIEW §七 A5）：签发一枚 SSE 专用短效票据。
   *
   * 与 access token 的差别（三条，构成收窄的全部理由）：
   *   ① TTL 30s 而非 15min——写进 nginx access log / 浏览器历史 / Referer 的
   *      东西，有效期应当以秒计；
   *   ② type=sse_ticket —— jwt.strategy 只在三条 /stream 路由上读取它，
   *      拿到也开不了任何 REST 端点（extractJwtFromRequest 的路径门 + validate
   *      的类型门双重限制）；
   *   ③ 不落库、不参与刷新——它是 access token 的**派生物**而非替代品，
   *      过期即弃，前端每次建流（含自动重连）都重新换一枚。
   *
   * 与 generateTokens 共用 base claim（含 ver 会话版本快照）⇒ 用户登出或改密
   * 后已签发的票据同样即时失效。
   *
   * 未做「单次使用」（评审原稿提到）：那需要在建流路径上引入 Redis 共享状态，
   * 等于把 SSE 的可用性与 Redis 绑定；而票据本身已是 30s + 路径受限，日志泄漏
   * 场景（事后读取）本就拿不到有效凭据。此处如实登记为残差。
   */
  issueSseTicket(user: {
    id: number;
    username: string;
    sessionVersion?: number;
  }): SseTicketResponseDto {
    const ticket = this.jwtService.sign(
      {
        sub: user.id,
        username: user.username,
        ver: user.sessionVersion,
        type: "sse_ticket",
        jti: randomUUID(),
      },
      { expiresIn: `${SSE_TICKET_TTL_SECONDS}s` as any },
    );
    return {
      ticket,
      expiresAt: new Date(
        Date.now() + SSE_TICKET_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  private async generateTokens(
    user: { id: number; username: string; sessionVersion?: number },
    meta?: { userAgent?: string | null; ip?: string | null },
  ) {
    // S2: include 'type' claim and use separate secrets for access/refresh tokens
    const base: JwtPayload = {
      sub: user.id,
      username: user.username,
      // WIKI-AUTH-REVOC: 会话版本快照进 base payload——access/refresh 两类
      // token 同点携带；access 侧 validate() 消费，refresh 侧在
      // refreshToken() 中比对（A-1：改密后旧 refresh 链 401——改密 bump 的
      // 会话版本同时切断两个面），签发经本单点自然带最新值。
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
    // A-10（R3-A 审计）: 已吊销行的凭据卫生——吊销即刻使 jti 失效（消费路径
    // revoked=false 才放行），行本身只剩审计价值；此前只清 expiresAt<now，
    // 被吊销但未到 30 天自然过期的行要滞留至多 30 天。现追加清理「吊销满
    // 7 天」的行（createdAt 锚点，保留近一周的吊销痕迹供会话审计回溯）。
    // 同一 cron 内顺序执行；两条件天然不重叠冲突（先清过期，再清吊销残留）。
    const revokedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await this.refreshTokenRepo.delete({
      revoked: true,
      createdAt: LessThan(revokedCutoff),
    });
  }
}
