import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import axios from "axios";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { assertSafeHttpUrl } from "../../common/utils/safe-http.util";
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
  /** 组声明归一（数组/单字符串 → string[]；用于 JIT 角色映射，R20）。 */
  groups: string[];
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** state cookie 有效期（授权→回调全程） */
export const OIDC_STATE_COOKIE = "acf_oidc_state";
const STATE_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;

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
      throw new BadRequestException(
        `OIDC is enabled but misconfigured; missing env: ${missing.map((k) => `OIDC_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`).join(", ")}`,
      );
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
    await assertSafeHttpUrl(issuer, {
      allowPrivateNetwork: cfg.allowPrivateNetwork,
    });
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const { data } = await axios.get<OidcDiscovery>(url, { timeout: 10_000 });
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
      ] as const) {
        if (!data?.[key]) {
          throw new BadRequestException(
            `OIDC discovery document missing ${key}`,
          );
        }
      }
      this.discoveryCache = { value: data, at: Date.now() };
      return data;
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Failed to fetch OIDC discovery from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      throw new UnauthorizedException("OIDC state cookie missing");
    }
    const [body, sig] = raw.split(".");
    const expected = createHmac("sha256", this.stateSecret())
      .update(body)
      .digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("OIDC state signature mismatch");
    }
    let payload: OidcStatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedException("OIDC state payload malformed");
    }
    if (!payload?.state || !payload?.nonce || payload.exp * 1000 < Date.now()) {
      throw new UnauthorizedException("OIDC state expired or malformed");
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

  async exchangeCode(code: string): Promise<{ idToken: string }> {
    const cfg = this.assertConfigured();
    const discovery = await this.getDiscovery();
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
        },
      );
      if (!data?.id_token) {
        throw new UnauthorizedException(
          "OIDC token endpoint returned no id_token",
        );
      }
      return { idToken: data.id_token as string };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) throw err;
      // IdP 侧错误（code 无效/过期/凭据错）统一 401，不泄露内部细节
      throw new UnauthorizedException(
        `OIDC code exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getJwks(discovery: OidcDiscovery): Promise<Jwk[]> {
    if (this.jwksCache && Date.now() - this.jwksCache.at < JWKS_TTL_MS) {
      return this.jwksCache.keys;
    }
    const { data } = await axios.get<{ keys: Jwk[] }>(discovery.jwks_uri, {
      timeout: 10_000,
    });
    if (!Array.isArray(data?.keys) || data.keys.length === 0) {
      throw new UnauthorizedException("OIDC JWKS endpoint returned no keys");
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
      throw new UnauthorizedException("OIDC id_token malformed");
    }
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw new UnauthorizedException("OIDC id_token malformed");
    }
    if (header.alg !== "RS256") {
      throw new UnauthorizedException(
        `OIDC id_token alg ${header.alg} not supported (RS256 only)`,
      );
    }

    const discovery = await this.getDiscovery();
    const jwks = await this.getJwks(discovery);
    const candidates = jwks.filter(
      (k) =>
        k.kty === "RSA" && (!header.kid || k.kid === header.kid) && k.n && k.e,
    );
    if (candidates.length === 0) {
      throw new UnauthorizedException("OIDC id_token kid not found in JWKS");
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
      throw new UnauthorizedException(
        "OIDC id_token signature verification failed",
      );
    }

    const issuerNormalized = cfg.issuer.replace(/\/+$/, "");
    const tokenIssuer = String(claims.iss ?? "").replace(/\/+$/, "");
    if (tokenIssuer !== issuerNormalized) {
      throw new UnauthorizedException("OIDC id_token issuer mismatch");
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.clientId)) {
      throw new UnauthorizedException("OIDC id_token audience mismatch");
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.exp !== "number" ||
      claims.exp < now - CLOCK_SKEW_SECONDS
    ) {
      throw new UnauthorizedException("OIDC id_token expired");
    }
    if (
      typeof claims.iat === "number" &&
      claims.iat > now + CLOCK_SKEW_SECONDS
    ) {
      throw new UnauthorizedException("OIDC id_token issued in the future");
    }
    const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
    const a = Buffer.from(nonce);
    const b = Buffer.from(expectedNonce);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("OIDC id_token nonce mismatch");
    }
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const username =
      typeof claims[cfg.usernameClaim] === "string"
        ? (claims[cfg.usernameClaim] as string)
        : "";
    if (!sub || !username) {
      throw new UnauthorizedException(
        `OIDC id_token missing sub or username claim '${cfg.usernameClaim}'`,
      );
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
   */
  async resolveAndBindUser(profile: OidcProfile): Promise<User> {
    // ① sub 稳定绑定
    const bySub = await this.usersRepo.findOne({
      where: { oidcSub: profile.sub },
    });
    if (bySub) {
      if (!bySub.isActive)
        throw new UnauthorizedException("Account is disabled");
      return bySub;
    }
    // ② username 声明匹配 + 首登绑定 sub
    const byUsername = await this.usersRepo.findOne({
      where: { username: profile.username },
    });
    if (byUsername) {
      if (!byUsername.isActive)
        throw new UnauthorizedException("Account is disabled");
      if (!byUsername.oidcSub) {
        byUsername.oidcSub = profile.sub;
        await this.usersRepo.save(byUsername);
      } else {
        // 同 username 已绑定其他 sub：声明冲突，拒绝而非静默换绑
        throw new UnauthorizedException(
          "OIDC identity is bound to a different account",
        );
      }
      return byUsername;
    }
    // ③ JIT 自动建号（默认关）
    if (this.config.get<boolean>("oidc.autoProvision") === true) {
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
    throw new UnauthorizedException(
      "OIDC identity not linked to any platform account (ask an administrator to create a matching username, or enable OIDC_AUTO_PROVISION)",
    );
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
      throw new UnauthorizedException(
        "OIDC state mismatch between query and cookie",
      );
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
