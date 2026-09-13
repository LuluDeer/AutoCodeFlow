import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { Request } from "express";
import { UsersService } from "../../users/users.service";

export interface JwtPayload {
  sub: number;
  username: string;
  type?: string;
  /** SEC-03: session id — mirrors the refresh token jti this login issued. */
  sid?: string;
  /**
   * AUTH-01（多租户 Project，第一批）：可选项目上下文 claim。保守落地——
   * sign 侧 base payload 本批不加（auth.service.generateTokens 不带
   * projectId，签发行为零变化），claim 面先立契约：项目上下文后续经
   * X-Project-Id header 注入时由该字段承接。validate() 不消费、不校验。
   */
  projectId?: string;
  /**
   * WIKI-AUTH-REVOC: 会话版本快照——签发时刻 user.sessionVersion（logout /
   * 改密时原子 +1）。validate() 与库中当前值比对，不一致 = 令牌签发后该用户
   * 已 logout / 改密 → 401（"Session has been revoked"），在途访问令牌即时
   * 失效。无 ver 的存量旧令牌（本特性部署前签发）按「到期自然失效」兼容
   * 放行，不被新逻辑立即打死。
   */
  ver?: number;
}

/**
 * P1-6 (contract): EventSource cannot set Authorization headers, so the
 * admin-web SSE log stream appends the JWT to the URL as `?access_token=`.
 * Query strings are logged by proxies and leak into referers, so a query
 * token is accepted ONLY on the execution log-stream route(s) and ONLY for
 * type=access tokens — every other route must keep using the bearer header.
 */
export const SSE_QUERY_TOKEN_PARAM = "access_token";

/** Path suffixes on which the `access_token` query parameter is accepted. */
// UI-14 第一阶段：/metrics/stream（Dashboard 汇总流）同款回退——EventSource
// 无法设置 Authorization 头，与 /logs/stream 共享 ?access_token= 先例
// （type=access 限定仍由 validate() 强制，refresh token 无法借道）。
// FEAT-16：/executions/stream（执行列表终态推送流）同款回退——消费端与
// /metrics/stream 同为 admin-web EventSource，鉴权形态保持一致。
const SSE_QUERY_TOKEN_PATH_SUFFIXES = [
  "/logs/stream",
  "/metrics/stream",
  "/executions/stream",
];

export function extractJwtFromRequest(req: Request): string | null {
  const headerToken = req?.headers
    ? ExtractJwt.fromAuthHeaderAsBearerToken()(req)
    : null;
  if (headerToken) return headerToken;

  // Query-token fallback: restricted to the SSE log-stream paths.
  const url = (req as any)?.originalUrl ?? (req as any)?.url ?? "";
  const path = typeof url === "string" ? url.split("?")[0] : "";
  const isStreamPath = SSE_QUERY_TOKEN_PATH_SUFFIXES.some((suffix) =>
    path.endsWith(suffix),
  );
  if (!isStreamPath) return null;

  const queryToken = (req as any)?.query?.[SSE_QUERY_TOKEN_PARAM];
  return typeof queryToken === "string" && queryToken.length > 0
    ? queryToken
    : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: extractJwtFromRequest,
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("jwt.secret"),
    });
  }

  async validate(payload: JwtPayload) {
    // SEC-001: require the 'access' type marker — tokens that omit `type`
    // are old-format or attacker-crafted and must be rejected. This also
    // guarantees a refresh token can never be smuggled in via ?access_token=.
    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException("User not found");
    // S1: reject disabled accounts even when their JWT is still valid
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");
    // WIKI-AUTH-REVOC: 会话版本比对——payload.ver 是签发时刻快照，库中
    // sessionVersion 在 logout / 改密时原子 +1，不一致即「令牌签发后该用户
    // 的会话已被撤销」。存量旧令牌无 ver claim（undefined）→ 跳过比对，
    // 维持「到期自然失效」的兼容语义（部署前签发的令牌零破坏）。
    if (payload.ver !== undefined && payload.ver !== user.sessionVersion) {
      throw new UnauthorizedException("Session has been revoked");
    }
    return user;
  }
}
