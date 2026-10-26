import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染；oidc.controller 的 mapCallbackError 直接按 errorCode 分派，
// 不再做文案子串匹配）。AppError 按状态码挂到对应内置异常原型上，故既有按
// 异常类断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import {
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import axios from "axios";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";
import {
  assertAndPinHttpUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
import { User, UserRole } from "../users/entities/user.entity";
import { AuthService } from "./auth.service";

/**
 * AUTH-04: OIDC SSO（授权码模式，confidential client）。
 *
 * 流程（见 docs/adr/adr-014-oidc-sso.md）：
 *   GET /auth/oidc/login → 302 IdP authorize（state+nonce 打包 HMAC 签名后放
 *   HttpOnly cookie，不依赖服务端会话存储——多实例天然共享）→ IdP 回调
 *   GET /auth/oidc/callback?code&state → 校验 cookie 签名与时效 → code 换
 *   token → ID Token RS256 验签（JWKS，node:crypto 零新依赖）+ iss/aud/exp/
 *   nonce 校验 → 身份定位（oidcSub → username 绑定 → JIT 建号）→ 签发平台
 *   JWT 对 → 302 回前端落地页（#fragment 携带 token，不进服务器日志）。
 *
 * 安全边界：
 * - issuer/凭据全部为部署级 env（管理员控制），仍走 assertSafeHttpUrl 态势
 *   ——默认拒内网（内网 Keycloak 用 OIDC_ALLOW_PRIVATE_NETWORK 显式放行，
 *   云元数据段恒拒），与 AI/executor 豁免开关同形态；
 * - state cookie HMAC-SHA256 签名 + 10 分钟时效，防 CSRF 与重放；
 * - 比较均用 timingSafeEqual（签名/nonce）。
 */

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/** state cookie 承载的无状态会话载荷。 */
interface OidcStatePayload {
  state: string;
  nonce: string;
  exp: number;
}

/** ID Token 校验后提取的最小身份面。 */
export interface OidcProfile {
  sub: string;
  username: string;
  email: string | null;
  /**
   * A-3（R3-A 审计）: IdP 对 email 声明的核验状态（email_verified claim）。
   * 自动绑定（username 撞名 → 首登绑 sub）只信任「已核验且与平台账号一致」
   * 的 email——未核验/缺失的 claim 不足以证明 IdP 侧身份与平台账号同主。
   */
  emailVerified: boolean;
  /** 组声明归一（数组/单字符串 → string[]；用于 JIT 角色映射，R20）。 */
  groups: string[];
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** state cookie 有效期（授权→回调全程） */
export const OIDC_STATE_COOKIE = "acf_oidc_state";
const STATE_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;

/**
 * P3-4（2026-10-25 审计）：JIT 自动建号前的声明防御性校验（纯函数，便于
 * 单测）。返回缺陷描述（用作 AppError 的 reason 参数与日志）；null = 通过。
 *
 * 上限口径与 users 表列宽 / CreateUserDto 同源：
 *   · username：非空且 ≤128（users.username varchar(128)，entity @Length
 *     上界同值；CreateUserDto F-18 上限对齐）；
 *   · email：声明非空时必须是合法 email 形态且 ≤255（users.email 列宽）；
 *     缺省回落 `${sub}@oidc.local.invalid` 时整体也必须 ≤255（sub 来自
 *     IdP、长度不受本仓控制）。
 *
 * 只拒**不可安全归一**的形态（超长/非法）：没有做任何截断或改写——见
 * resolveAndBindUser ③ 内注释的「拒发不归一」论证。
 */
export function jitProfileDefect(profile: OidcProfile): string | null {
  const username = typeof profile.username === "string" ? profile.username : "";
  if (username.length === 0) return "username claim is empty";
  if (username.length > 128) {
    return `username claim exceeds 128 chars (got ${username.length})`;
  }
  // email 列宽 varchar(255)（TypeORM 默认）；形态用 CreateUserDto @IsEmail
  // 的宽口径近似——本地部分 @ 域名，不含空白。拒绝明显非法即可，不在 SSO
  // 链路上重抄一套完整 RFC 校验。
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const fallbackEmail = `${profile.sub}@oidc.local.invalid`;
  if (profile.email != null && profile.email !== "") {
    if (profile.email.length > 255) {
      return `email claim exceeds 255 chars (got ${profile.email.length})`;
    }
    if (!EMAIL_SHAPE.test(profile.email)) {
      return "email claim is not a valid address";
    }
  } else if (fallbackEmail.length > 255) {
    return `sub claim too long to derive a fallback email (got ${fallbackEmail.length} chars, max 255)`;
  }
  return null;
}

@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discoveryCache: { value: OidcDiscovery; at: number } | null = null;
  private jwksCache: { keys: Jwk[]; at: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  get enabled(): boolean {
    return this.config.get<boolean>("oidc.enabled") === true;
  }

  /** 回调落地页（controller 302 用）。 */
  getWebRedirectUrl(): string {
    return (
      this.config.get<string>("oidc.webRedirectUrl") ||
      "http://localhost:5173/auth/sso/complete"
    );
  }

  private oidcConfig() {
    return {
      issuer: this.config.get<string>("oidc.issuer") ?? "",
      clientId: this.config.get<string>("oidc.clientId") ?? "",
      clientSecret: this.config.get<string>("oidc.clientSecret") ?? "",
      redirectUri: this.config.get<string>("oidc.redirectUri") ?? "",
      scopes: this.config.get<string>("oidc.scopes") ?? "openid profile email",
      usernameClaim:
        this.config.get<string>("oidc.usernameClaim") ?? "preferred_username",
      groupsClaim: this.config.get<string>("oidc.groupsClaim") ?? "groups",
      adminGroups: this.config.get<string>("oidc.adminGroups") ?? "",
      autoProvision: this.config.get<boolean>("oidc.autoProvision") === true,
      webRedirectUrl: this.config.get<string>("oidc.webRedirectUrl") ?? "",
      allowPrivateNetwork:
        this.config.get<boolean>("oidc.allowPrivateNetwork") === true,
    };
  }

  /** 配置完整性校验（enabled=true 时缺任一必填项即 fail-fast 400）。 */
  private assertConfigured(): ReturnType<OidcService["oidcConfig"]> {
    const cfg = this.oidcConfig();
    const missing = (
      ["issuer", "clientId", "clientSecret", "redirectUri"] as const
    ).filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new AppError("OIDC_CONFIG_INCOMPLETE", {
        keys: missing
          .map(
            (k) => `OIDC_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`,
          )
          .join(", "),
      });
    }
    return cfg;
  }

  /** discovery 文档（1h 内存缓存；issuer 过 SSRF 态势闸）。 */
  async getDiscovery(): Promise<OidcDiscovery> {
    if (
      this.discoveryCache &&
      Date.now() - this.discoveryCache.at < DISCOVERY_TTL_MS
    ) {
      return this.discoveryCache.value;
    }
    const cfg = this.assertConfigured();
    const issuer = cfg.issuer.replace(/\/+$/, "");
    // F-3（SEC-NEW）: discovery 首跳同样 pin 到校验通过的 IP（Host/SNI
    // 保留）——OIDC issuer 是部署级域名，逐请求 rebind 同样成立。
    const pinned = await assertAndPinHttpUrl(issuer, {
      allowPrivateNetwork: cfg.allowPrivateNetwork,
    });
    const pinCfg = pinnedAxiosConfig(pinned);
    // 原始 issuer 拼路径（new URL 归一化会改字节形态）；pin 由 agent.lookup 完成。
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const { data } = await axios.get<OidcDiscovery>(url, {
        timeout: 10_000,
        maxRedirects: 0, // R3 parity: 首跳是唯一经 SSRF 校验的地址
        ...pinCfg,
      });
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
      ] as const) {
        if (!data?.[key]) {
          throw new AppError("OIDC_DISCOVERY_INCOMPLETE", { key });
        }
      }
      this.discoveryCache = { value: data, at: Date.now() };
      return data;
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError("OIDC_DISCOVERY_FAILED", {
        url,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 无状态 state/nonce（HMAC cookie）─────────────────────────────────

  private stateSecret(): string {
    // 复用 JWT refresh secret 作为 HMAC 密钥：部署必配（Joi required），
    // 与平台既有信任域一致，不引入新 secret 负担。
    return this.config.get<string>("jwt.refreshSecret") ?? "";
  }

  createStateCookieValue(): { value: string; state: string } {
    const payload: OidcStatePayload = {
      state: randomBytes(16).toString("base64url"),
      nonce: randomBytes(16).toString("base64url"),
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", this.stateSecret())
      .update(body)
      .digest("base64url");
    return { value: `${body}.${sig}`, state: payload.state };
  }

  verifyStateCookieValue(raw: string | undefined): OidcStatePayload {
    if (!raw || !raw.includes(".")) {
      throw new AppError("OIDC_STATE_INVALID", { reason: "cookie_missing" });
    }
    const [body, sig] = raw.split(".");
    const expected = createHmac("sha256", this.stateSecret())
      .update(body)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError("OIDC_STATE_INVALID", {
        reason: "signature_mismatch",
      });
    }
    let payload: OidcStatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new AppError("OIDC_STATE_INVALID", { reason: "payload_malformed" });
    }
    if (!payload?.state || !payload?.nonce || payload.exp * 1000 < Date.now()) {
      throw new AppError("OIDC_STATE_INVALID", {
        reason: "expired_or_malformed",
      });
    }
    return payload;
  }

  /** authorize 跳转 URL（state+nonce 经 cookie 无状态承载）。 */
  async buildAuthorizeUrl(stateCookieValue: string): Promise<string> {
    const cfg = this.assertConfigured();
    const discovery = await this.getDiscovery();
    const payload = this.verifyStateCookieValue(stateCookieValue);
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", cfg.scopes);
    url.searchParams.set("state", payload.state);
    url.searchParams.set("nonce", payload.nonce);
    return url.toString();
  }

  // ── code 换 token + ID Token 验签 ────────────────────────────────────

  /**
   * NETOPT-5③: 二跳 SSRF 闸。token_endpoint / jwks_uri 都来自 discovery
   * 响应体——那是 IdP 控制的数据，不是部署级配置；若 discovery 文档被
   * 篡改（或恶意 IdP），内网 token_endpoint 会带着 client_secret + 授权码
   * 直奔内网/云元数据。闸的语义是「逐跳校验」：URL 无论来自配置还是
   * 上游响应体，每一跳都要过闸（与 discovery 首跳同一套 assertAndPinHttpUrl
   * + pinnedAxiosConfig + maxRedirects:0，F-3 的 DNS pin 同样适用）。
   */
  private async gateSecondHop(url: string) {
    const pinned = await assertAndPinHttpUrl(url, {
      allowPrivateNetwork:
        this.config.get<boolean>("oidc.allowPrivateNetwork") === true,
    });
    return pinnedAxiosConfig(pinned);
  }

  async exchangeCode(code: string): Promise<{ idToken: string }> {
    const cfg = this.assertConfigured();
    const discovery = await this.getDiscovery();
    // NETOPT-5③: 闸在 try 之外——被拒的 URL 抛 BadRequest（与 discovery
    // 首跳闸的异常语义一致），不被下面的 catch 折叠成 401。
    const pinCfg = await this.gateSecondHop(discovery.token_endpoint);
    try {
      const { data } = await axios.post(
        discovery.token_endpoint,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: cfg.redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          timeout: 10_000,
          // 二跳不跟随重定向（R3 parity）：重定向目标未经闸校验
          maxRedirects: 0,
          ...pinCfg,
        },
      );
      if (!data?.id_token) {
        throw new AppError("OIDC_TOKEN_NO_ID_TOKEN");
      }
      return { idToken: data.id_token as string };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      // IdP 侧错误（code 无效/过期/凭据错）统一 401，不泄露内部细节
      throw new AppError("OIDC_CODE_EXCHANGE_FAILED", {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getJwks(discovery: OidcDiscovery): Promise<Jwk[]> {
    if (this.jwksCache && Date.now() - this.jwksCache.at < JWKS_TTL_MS) {
      return this.jwksCache.keys;
    }
    // NETOPT-5③: jwks_uri 同为 discovery 响应体提供的二跳 URL，过同一套闸
    const pinCfg = await this.gateSecondHop(discovery.jwks_uri);
    const { data } = await axios.get<{ keys: Jwk[] }>(discovery.jwks_uri, {
      timeout: 10_000,
      maxRedirects: 0,
      ...pinCfg,
    });
    if (!Array.isArray(data?.keys) || data.keys.length === 0) {
      throw new AppError("OIDC_JWKS_EMPTY");
    }
    this.jwksCache = { keys: data.keys, at: Date.now() };
    return data.keys;
  }

  /**
   * ID Token 校验：RS256 验签（JWKS，kid 匹配 → 缺 kid 尝试全钥）+
   * iss/aud/exp/iat/nonce 全量校验。任一不满足 → 401。
   */
  async validateIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<OidcProfile> {
    const cfg = this.assertConfigured();
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      throw new AppError("OIDC_ID_TOKEN_MALFORMED");
    }
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new AppError("OIDC_ID_TOKEN_MALFORMED");
    }
    if (header.alg !== "RS256") {
      throw new AppError("OIDC_ALG_UNSUPPORTED", { alg: String(header.alg) });
    }

    const discovery = await this.getDiscovery();
    const jwks = await this.getJwks(discovery);
    const candidates = jwks.filter(
      (k) =>
        k.kty === "RSA" && (!header.kid || k.kid === header.kid) && k.n && k.e,
    );
    if (candidates.length === 0) {
      throw new AppError("OIDC_KID_NOT_FOUND");
    }
    const signedInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], "base64url");
    const verified = candidates.some((jwk) => {
      try {
        const key = createPublicKey({ key: jwk as never, format: "jwk" });
        return createVerify("RSA-SHA256")
          .update(signedInput)
          .verify(key, signature);
      } catch {
        return false;
      }
    });
    if (!verified) {
      throw new AppError("OIDC_SIGNATURE_INVALID");
    }

    const issuerNormalized = cfg.issuer.replace(/\/+$/, "");
    const tokenIssuer = String(claims.iss ?? "").replace(/\/+$/, "");
    if (tokenIssuer !== issuerNormalized) {
      throw new AppError("OIDC_ISSUER_MISMATCH");
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.clientId)) {
      throw new AppError("OIDC_AUDIENCE_MISMATCH");
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.exp !== "number" ||
      claims.exp < now - CLOCK_SKEW_SECONDS
    ) {
      throw new AppError("OIDC_ID_TOKEN_EXPIRED");
    }
    if (
      typeof claims.iat === "number" &&
      claims.iat > now + CLOCK_SKEW_SECONDS
    ) {
      throw new AppError("OIDC_ID_TOKEN_IAT_FUTURE");
    }
    const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
    const a = Buffer.from(nonce);
    const b = Buffer.from(expectedNonce);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError("OIDC_NONCE_INVALID");
    }
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const username =
      typeof claims[cfg.usernameClaim] === "string"
        ? (claims[cfg.usernameClaim] as string)
        : "";
    if (!sub || !username) {
      throw new AppError("OIDC_CLAIMS_INCOMPLETE", {
        claim: cfg.usernameClaim,
      });
    }
    const rawGroups = claims[cfg.groupsClaim];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === "string")
      : typeof rawGroups === "string"
        ? [rawGroups]
        : [];
    return {
      sub,
      username,
      email: typeof claims.email === "string" ? claims.email : null,
      // A-3: email_verified 透传——resolveAndBindUser 的自动绑定闸消费
      emailVerified: claims.email_verified === true,
      groups,
    };
  }

  // ── 身份定位与令牌签发 ───────────────────────────────────────────────

  /**
   * R20（ADR-014 修订）: 组→角色映射，**仅在 JIT 建号时调用**——
   * 已绑定/存量账号的角色由平台管理员管理，IdP 侧组变化不会反向改写
   * （防提权打架与「最后一个 admin 被降级」类竞态）。`OIDC_ADMIN_GROUPS`
   * 为空（默认）时恒 USER，行为与未配置一致；命中清单内任一组即 ADMIN。
   */
  private roleFromGroups(groups: string[]): UserRole {
    const adminGroups = (this.oidcConfig().adminGroups || "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    if (adminGroups.length === 0) return UserRole.USER;
    return groups.some((g) => adminGroups.includes(g))
      ? UserRole.ADMIN
      : UserRole.USER;
  }

  /**
   * 身份定位三级：oidcSub 精确匹配 → username 声明匹配（首登绑定 sub）→
   * autoProvision 时 JIT 建号。任一命中账号 isActive=false 即拒。
   * autoProvision=false 且无匹配 → 403（不泄露「用户不存在」细节）。
   *
   * A-3（R3-A 审计）: ②级的自动绑定收紧。旧实现「username 命中且 oidcSub
   * 为空就直接绑定签发令牌」——种子管理员 username 恒为 admin，IdP 侧注册
   * preferred_username=admin 即可接管 ADMIN 账号。现要求自动绑定必须同时：
   *   ① 目标账号非 ADMIN（ADMIN 只认管理员预置的 oidcSub，禁止任何形式的
   *      自动绑定——IdP 声明再可信也不能给全局角色背书）；
   *   ② email claim 存在且 email_verified=true 且与目标账号 email 完全一致
   *      （未核验/缺失/不一致一律拒绝）。
   * 不满足 → 403（日志含双方 username，不落 email/sub 等敏感值）。
   */
  async resolveAndBindUser(profile: OidcProfile): Promise<User> {
    // ① sub 稳定绑定
    const bySub = await this.usersRepo.findOne({
      where: { oidcSub: profile.sub },
    });
    if (bySub) {
      if (!bySub.isActive) throw new AppError("OIDC_ACCOUNT_DISABLED");
      return bySub;
    }
    // ② username 声明匹配 + 首登绑定 sub
    const byUsername = await this.usersRepo.findOne({
      where: { username: profile.username },
    });
    if (byUsername) {
      if (!byUsername.isActive) throw new AppError("OIDC_ACCOUNT_DISABLED");
      if (!byUsername.oidcSub) {
        const emailTrusted =
          !!profile.email &&
          profile.emailVerified &&
          profile.email === byUsername.email;
        if (byUsername.role === UserRole.ADMIN || !emailTrusted) {
          // 日志只落双方 username 与拒绝原因码（不落 email/sub 敏感值）
          this.logger.warn(
            `OIDC auto-bind denied: IdP username '${profile.username}' collides with platform account '${byUsername.username}' (reason: ${
              byUsername.role === UserRole.ADMIN
                ? "admin-account-requires-preprovisioned-oidcSub"
                : "email-claim-missing-unverified-or-mismatched"
            })`,
          );
          throw new AppError("OIDC_AUTOBIND_DENIED");
        }
        // R32-A4: 列级 UPDATE——绑定只碰 oidcSub 一列。此前是
        // usersRepo.save(byUsername)：把进入方法时读到的**整行快照**回写
        // （TypeORM save 无脏检查），若此刻另一条路径（登出 bump sessionVersion
        // / 管理员改密 / 禁用账号）刚落了库，这次 SSO 登录会把那些变更静默
        // 回滚——与 auth.service 的 TOTP 写入同款缺陷，只是入口不同。
        // R38（ADR-026）：上面的 `!byUsername.oidcSub` 是**读时判断**，覆盖不了并发。
        //
        // 两个不同的 IdP 身份同时声明同一个 username（各自 sub 不同）时，两个请求都能
        // 通过那只 if，于是各自写自己的 sub —— 后到者把先到者的绑定**静默换掉**，
        // 而这个分支下面那句注释明确写着"声明冲突，拒绝而非静默换绑"。也就是说：
        // 并发下它做的恰好是自己声称不做的事，且换绑后先绑定的那个 IdP 身份再也登不进来。
        //
        // 条件写把判据挪进 WHERE：只有**仍未绑定**时才写。命中 0 时再读一次区分两种情形：
        // 已绑定成同一个 sub（幂等重入，正常返回）还是被绑成了别的 sub（真冲突，拒绝）。
        const bound = await this.usersRepo.update(
          { id: byUsername.id, oidcSub: IsNull() },
          { oidcSub: profile.sub },
        );
        if (!bound.affected) {
          const now = await this.usersRepo.findOne({
            where: { id: byUsername.id },
          });
          if (!now || now.oidcSub !== profile.sub) {
            this.logger.warn(
              `OIDC auto-bind lost the race: platform account '${byUsername.username}' ` +
                `was bound to another sub concurrently; refusing to silently rebind`,
            );
            throw new AppError("OIDC_SUB_ALREADY_BOUND");
          }
          // 已经绑成同一个 sub —— 幂等重入，继续正常流程。
          byUsername.oidcSub = profile.sub;
        } else {
          byUsername.oidcSub = profile.sub;
        }
      } else {
        // 同 username 已绑定其他 sub：声明冲突，拒绝而非静默换绑
        throw new AppError("OIDC_SUB_ALREADY_BOUND");
      }
      return byUsername;
    }
    // ③ JIT 自动建号（默认关）
    if (this.config.get<boolean>("oidc.autoProvision") === true) {
      // P3-4（2026-10-25 审计）：JIT 前的声明防御。JIT 绕过 CreateUserDto
      // 直写 users 表，IdP 声明的 username 超长（DB 列 varchar(128)，
      // CreateUserDto 同上限）或 email 形态非法/超长（DB 列 varchar(255)）
      // 时，旧路径撞数据库约束冒 500。**拒发不归一**：截断会让平台身份与
      // IdP 身份漂移（审计无法对账），让管理员在 IdP 侧修正声明才是可追溯
      // 的修法——日志只落 sub 前缀与原因（不落 email 等敏感值，同本文件
      // 既有拒绝日志的口径）。
      const defect = jitProfileDefect(profile);
      if (defect) {
        this.logger.warn(
          `OIDC JIT provision rejected: ${defect} (sub=${profile.sub.slice(0, 8)}…, username='${profile.username}')`,
        );
        throw new AppError("OIDC_JIT_PROFILE_INVALID", { reason: defect });
      }
      const provisionedRole = this.roleFromGroups(profile.groups);
      // 随机 32 字节占位密码：SSO 用户永远不走密码登录。直接 repo.create
      // 绕过 UsersService.create 的密码强度校验——占位密码不参与任何认证面，
      // 校验规则（混合字符集）对它没有意义，也不应成为 JIT 建号的失败模式
      const placeholderPassword = randomBytes(32).toString("base64url");
      const created = this.usersRepo.create({
        username: profile.username,
        email: profile.email ?? `${profile.sub}@oidc.local.invalid`,
        password: placeholderPassword,
        role: provisionedRole,
        isActive: true,
        oidcSub: profile.sub,
      });
      const saved = await this.usersRepo.save(created);
      this.logger.log(
        `OIDC JIT provisioned user '${profile.username}' (sub=${profile.sub.slice(0, 8)}…)`,
      );
      return saved;
    }
    throw new AppError("OIDC_ACCOUNT_NOT_LINKED");
  }

  /** 完整回调链：state 双向比对 → 换码 → 验签 → 定位/绑定 → 平台令牌对。 */
  async completeLogin(
    code: string,
    stateCookieValue: string,
    meta?: {
      expectedState?: string | null;
      userAgent?: string | null;
      ip?: string | null;
    },
  ): Promise<{ accessToken: string; refreshToken: string; username: string }> {
    const state = this.verifyStateCookieValue(stateCookieValue);
    // cookie 内 state 与授权请求携带的 state 双向比对：任一侧被替换（跨流程
    // 注入 / 另一浏览器的回调 URL）即拒绝。
    if (meta?.expectedState && meta.expectedState !== state.state) {
      throw new AppError("OIDC_STATE_MISMATCH");
    }
    const { idToken } = await this.exchangeCode(code);
    const profile = await this.validateIdToken(idToken, state.nonce);
    const user = await this.resolveAndBindUser(profile);
    const tokens = await this.authService.issueTokensForOidcUser(user, meta);
    return { ...tokens, username: user.username };
  }

  /** 供测试/诊断：重置缓存（套件换 IdP 时用）。 */
  resetCaches(): void {
    this.discoveryCache = null;
    this.jwksCache = null;
  }
}
